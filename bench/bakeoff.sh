#!/usr/bin/env bash
# Yente triage bake-off — run the same 23 fixtures against every model.
#
#   ./bench/bakeoff.sh                       # every *.gguf in $MODEL_DIR
#   ./bench/bakeoff.sh qwen35-4b qwen35-9b   # named models, in order
#
# Env overrides: MODEL_DIR, LLAMA_BIN, PORT, CTX, CORES, SCHEMA
set -uo pipefail

MODEL_DIR="${MODEL_DIR:-/opt/models}"
LLAMA_BIN="${LLAMA_BIN:-/opt/llama.cpp/build/bin}"
PORT="${PORT:-8399}"   # not 8080; that is commonly already in use
CTX="${CTX:-8192}"
SCHEMA="${SCHEMA:-src/triage/schema_v2.json}"
OUT_DIR="${OUT_DIR:-bench/results}"

# Physical cores, not logical: hyperthread siblings contend for the same FP
# units, so oversubscribing usually costs throughput rather than adding it.
if [ -z "${CORES:-}" ]; then
  CORES=$(lscpu -p=Core,Socket 2>/dev/null | grep -v '^#' | sort -u | wc -l)
  [ "$CORES" -lt 1 ] 2>/dev/null && CORES=$(nproc)
fi

export LD_LIBRARY_PATH="$LLAMA_BIN"
mkdir -p "$OUT_DIR"

port_busy() { ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"; }

# Preflight: a port already in use is the difference between a bake-off and
# an hour of empty result files. Report the squatter, then move rather than
# fight it - whatever is on that port is probably meant to be there.
if port_busy "$PORT"; then
  echo "port $PORT is already in use:"
  ss -ltnp 2>/dev/null | grep -E "[:.]$PORT\b" | sed 's/^/    /'
  for cand in $(seq 8399 8420); do
    if ! port_busy "$cand"; then PORT="$cand"; break; fi
  done
  if port_busy "$PORT"; then echo "no free port in 8399-8420, aborting"; exit 1; fi
  echo "using free port $PORT instead"
  echo
fi

if [ $# -gt 0 ]; then
  MODELS=("$@")
else
  MODELS=()
  for f in "$MODEL_DIR"/*.gguf; do
    [ -e "$f" ] || continue
    MODELS+=("$(basename "$f" .gguf)")
  done
fi

[ ${#MODELS[@]} -eq 0 ] && { echo "no models found in $MODEL_DIR"; exit 1; }

echo "physical cores : $CORES"
echo "port           : $PORT"
echo "context        : $CTX"
echo "schema         : $SCHEMA"
echo "models         : ${MODELS[*]}"
echo

SRV_PID=""
stop_server() {
  # Kill by the PID we started, never by pattern. A pattern kill can match
  # this script's own shell and take the run down with it.
  if [ -n "$SRV_PID" ] && kill -0 "$SRV_PID" 2>/dev/null; then
    kill "$SRV_PID" 2>/dev/null
    for _ in $(seq 1 20); do kill -0 "$SRV_PID" 2>/dev/null || break; sleep 1; done
    kill -9 "$SRV_PID" 2>/dev/null
  fi
  SRV_PID=""
}
trap 'stop_server; exit 130' INT TERM

for m in "${MODELS[@]}"; do
  GGUF="$MODEL_DIR/$m.gguf"
  echo "=============================================================="
  echo "=== $m"
  echo "=============================================================="
  if [ ! -f "$GGUF" ]; then echo "  SKIP — $GGUF not found"; continue; fi
  echo "  size: $(du -h "$GGUF" | cut -f1)"

  stop_server
  LOG="/tmp/srv_$m.log"
  "$LLAMA_BIN/llama-server" -m "$GGUF" \
    --host 127.0.0.1 --port "$PORT" -t "$CORES" -c "$CTX" \
    --jinja -rea off --no-warmup > "$LOG" 2>&1 &
  SRV_PID=$!

  # Bigger models take real time to mmap and warm; 5 minutes is generous but
  # a 35B on a cold page cache genuinely needs it.
  UP=0
  for _ in $(seq 1 60); do
    if ! kill -0 "$SRV_PID" 2>/dev/null; then break; fi
    if curl -s -m 3 "localhost:$PORT/health" | grep -q '"ok"'; then UP=1; break; fi
    sleep 5
  done

  if [ "$UP" -ne 1 ]; then
    echo "  FAILED TO START — last 25 log lines:"
    tail -25 "$LOG" | sed 's/^/    /'
    stop_server
    continue
  fi

  RSS_KB=$(ps -o rss= -p "$SRV_PID" 2>/dev/null | tr -d ' ')
  echo "  resident: $(( ${RSS_KB:-0} / 1024 )) MB"

  START=$(date +%s)
  python3 src/triage/run_triage.py \
    --url "http://127.0.0.1:$PORT" \
    --tools "$SCHEMA" \
    --out "$OUT_DIR/$m.json" \
    --label "$m"
  RC=$?
  ELAPSED=$(( $(date +%s) - START ))
  echo "  wall: ${ELAPSED}s for 23 fixtures  (~$(( ELAPSED * 1000 / 23 ))ms each)  exit=$RC"

  # Fold hardware facts into the result file so the numbers stay attached to
  # the machine that produced them.
  python3 - "$OUT_DIR/$m.json" "$ELAPSED" "${RSS_KB:-0}" "$CORES" <<'PY'
import json, sys
p, el, rss, cores = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
try:
    d = json.load(open(p))
except Exception:
    sys.exit(0)
d.setdefault("summary", {}).update(
    wall_seconds=el, resident_mb=rss // 1024, threads=cores)
json.dump(d, open(p, "w"), indent=1)
PY

  stop_server
  echo
done

stop_server
echo "=============================================================="
python3 bench/summarize.py "$OUT_DIR"
