/**
 * The log you actually want to watch.
 *
 * Yente is three loops running at different speeds against a slow model, and
 * for most of a minute nothing visible happens. A log that only speaks when
 * something completes is indistinguishable from a log that has died — which is
 * precisely how a two-day outage went unnoticed. So this narrates: who is doing
 * what, right now, with numbers.
 *
 * COLOUR IS OFF WHEN NOBODY IS WATCHING
 *
 * `process.stdout.isTTY` decides. Piping to a file or through `tee` gives plain
 * text, because a log file full of escape codes is worse than no colour at all —
 * grep stops matching and every line gains eleven invisible characters. NO_COLOR
 * is honoured too, since that is the standard and somebody will have set it.
 *
 * ONE GLYPH PER LOOP, HELD CONSTANT
 *
 * The point of the glyphs is not decoration. Three loops interleave in one
 * stream, and a fixed colour per loop lets you see at a glance whether mail is
 * flowing while inference is stuck — the single most useful thing to know, and
 * impossible to read out of uniform grey text.
 */

const TTY = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const paint = (code) => (text) => (TTY ? `[${code}m${text}[0m` : String(text));

const c = {
  dim: paint("2"),
  bold: paint("1"),
  red: paint("31"),
  green: paint("32"),
  yellow: paint("33"),
  blue: paint("34"),
  magenta: paint("35"),
  cyan: paint("36"),
  grey: paint("90"),
  bgRed: paint("41;97"),
};

/**
 * The loops, each with a colour and a glyph.
 *
 * LISTEN is blue because it is the sensor; UNDERSTAND magenta because it is the
 * expensive one you will be staring at; CONNECT green because it is the payoff;
 * HUMAN yellow because it is you.
 */
const CHANNELS = {
  listen:     { glyph: "📬", label: "LISTEN    ", tint: c.blue },
  understand: { glyph: "🧠", label: "UNDERSTAND", tint: c.magenta },
  connect:    { glyph: "🔗", label: "CONNECT   ", tint: c.green },
  human:      { glyph: "🖐", label: "HUMAN     ", tint: c.yellow },
  store:      { glyph: "🗄", label: "STORE     ", tint: c.cyan },
  boot:       { glyph: "⚡", label: "BOOT      ", tint: c.bold },
  doc:        { glyph: "📄", label: "DOCUMENT  ", tint: c.cyan },
  desk:       { glyph: "🗂", label: "DESK      ", tint: c.cyan },
};

/** Which channel an event belongs to. Unknown events land in `store`. */
const EVENT_CHANNEL = {
  started: "boot", manager: "boot", intelligence: "boot",
  requeued_stranded_jobs: "boot", mail_not_configured: "boot",
  imap_connected: "listen", imap_error: "listen", imap_idle_ended: "listen",
  ingested: "listen", listen_failed: "listen", mail_unreachable: "listen",
  seat_claimed: "listen", seat_claim_failed: "listen", seats_backfilled: "boot",
  mail_uidvalidity_changed: "listen", mail_parse_failed: "listen",
  observe_started: "understand",
  observed: "understand", understood: "understand", observe_failed: "understand",
  understand_failed: "understand", job_stuck: "understand",
  job_failed_permanently: "understand", thinking: "understand",
  proposed: "connect", connect_failed: "connect",
  attachment_refused: "doc", attachment_empty: "doc",
  shutting_down: "boot", stopped: "boot", http_failed: "boot", http: "boot",
  desk: "boot", tick: "desk", tick_failed: "desk", matching_failed: "desk",
  extraction_failed: "desk", facts_rejected: "desk",
};

const LEVEL = {
  info: (s) => s,
  warn: (s) => c.yellow(s),
  error: (s) => c.red(s),
};

/** Human-friendly durations. 74000 -> "1m14s", 800 -> "800ms". */
export function human(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return "?";
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;

  // Round to whole seconds FIRST, then split. Rounding the remainder on its own
  // prints "2m60s" for 179.6s — the minutes and the seconds each rounded
  // correctly and disagreed. Mark spotted it in a live heartbeat.
  const seconds = Math.round(n / 1000);
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

/**
 * A one-line sparkline of recent durations, so a slowdown is visible as a shape
 * rather than as a number you have to remember the last value of.
 */
function spark(values, width = 12) {
  const bars = "▁▂▃▄▅▆▇█";
  const recent = values.slice(-width);
  if (recent.length === 0) return "";
  const max = Math.max(...recent, 1);
  return recent.map((v) => bars[Math.min(7, Math.floor((v / max) * 7))]).join("");
}

/**
 * Create the logger.
 *
 * Tracks in-flight work so the heartbeat can say WHICH jobs are running and for
 * how long — the question "what is it doing right now" has to be answerable
 * without attaching a debugger.
 */
export function createLogger({ pid = process.pid, quiet = false } = {}) {
  const started = Date.now();

  const inFlight = new Map();      // key -> { channel, what, since }
  // Model tokens arrive as tiny fragments ("org", "1", ":", " ORGAN"). Printing
  // one terminal line per token turns the operator console into a firehose and
  // pushes the heartbeat off screen. Buffer by evidence+attempt+phase and emit
  // readable logical lines instead. Evidence is load-bearing: four concurrent
  // attempt=1 streams must never be braided into one sentence.
  const modelStreamBuffers = new Map();
  const stats = {
    ingested: 0, documents: 0, observed: 0, claims: 0,
    failures: 0, retries: 0, matches: 0, decisions: 0,
    observeMs: [],                 // for the sparkline and the average
  };

  const stamp = () => c.grey(new Date().toISOString().slice(11, 19));

  function line(level, channel, message, meta = {}) {
    const ch = CHANNELS[channel] ?? CHANNELS.store;
    const bits = Object.entries(meta)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${c.grey(k + "=")}${typeof v === "object" ? JSON.stringify(v) : v}`);

    const head = `${stamp()} ${ch.glyph} ${ch.tint(ch.label)}`;
    process.stdout.write(
      `${head} ${LEVEL[level] ? LEVEL[level](message) : message}`
      + (bits.length ? `  ${bits.join(" ")}` : "") + "\n",
    );
  }

  function printModelStream(phase, attempt, evidence, text) {
    const clean = String(text ?? "").replace(/\r/g, "").trim();
    if (!clean) return;
    line("info", "understand",
      phase === "reasoning" ? c.dim("Muse thinks") : c.magenta("Muse says"), {
        evidence: String(evidence ?? "").slice(0, 20) || undefined,
        attempt,
        text: clean,
      });
  }

  function flushModelStream(key) {
    const buffered = modelStreamBuffers.get(key);
    if (!buffered) return;
    printModelStream(
      buffered.phase, buffered.attempt, buffered.evidence, buffered.text,
    );
    modelStreamBuffers.delete(key);
  }

  function flushAllModelStreams() {
    for (const key of [...modelStreamBuffers.keys()]) flushModelStream(key);
  }

  function flushModelStreamsFor(evidence, attempt = null) {
    const prefix = `${String(evidence ?? "unknown")}:`;
    for (const [key, buffered] of [...modelStreamBuffers.entries()]) {
      if (!key.startsWith(prefix)) continue;
      if (attempt !== null && buffered.attempt !== Number(attempt)) continue;
      flushModelStream(key);
    }
  }

  function appendModelStream(meta) {
    const phase = meta.phase === "reasoning" ? "reasoning" : "content";
    const attempt = Number(meta.attempt ?? 0);
    const evidence = String(meta.evidence ?? meta.contentHash ?? "unknown");
    const base = `${evidence}:${attempt}`;
    const key = `${base}:${phase}`;

    // Keep one job's reasoning and answer visually separate without touching any
    // other job currently streaming at the same attempt number.
    if (phase === "content") flushModelStream(`${base}:reasoning`);

    let text = (modelStreamBuffers.get(key)?.text ?? "") + String(meta.delta ?? "");
    // Emit complete logical lines immediately. For long unbroken output, wrap at
    // 240 characters so one model paragraph cannot become a terminal-wide wall.
    while (text.includes("\n") || text.length >= 240) {
      const newline = text.indexOf("\n");
      const cut = newline >= 0 && newline < 240 ? newline : 240;
      printModelStream(phase, attempt, evidence, text.slice(0, cut));
      text = text.slice(cut + (newline === cut ? 1 : 0));
    }
    modelStreamBuffers.set(key, { phase, attempt, evidence, text });
  }

  /**
   * The event-shaped logger the loops already call: log(level, event, meta).
   *
   * Known events get a sentence a person can read; unknown ones still print
   * with all their metadata rather than being dropped, because an event I did
   * not anticipate is exactly the one worth seeing.
   */
  function log(level, event, meta = {}) {
    const channel = EVENT_CHANNEL[event] ?? "store";

    switch (event) {
      case "started":
        line("info", "boot", c.bold("Yente is listening."), {
          pid, data: meta.data, mailbox: meta.mailbox,
          subjects: meta.subjects, jobs: meta.jobs,
        });
        return;

      case "intelligence":
        line("info", "boot",
          `Muse is ${meta.model} via ${meta.provider}`, {
            concurrency: meta.concurrency,
            third_party: meta.third_party ? c.red("YES") : "no",
          });
        return;

      case "seats_backfilled":
        line("info", "boot", c.green("reconciled founding seats from inbox history"), {
          count: meta.count,
        });
        return;

      case "imap_connected":
        line("info", "listen", `connected to ${meta.host}`, { mailbox: meta.mailbox });
        return;

      case "ingested": {
        stats.ingested += Number(meta.new ?? 0);
        stats.documents += Number(meta.documents ?? 0);
        const verb = Number(meta.new) > 0 ? c.green("heard") : c.grey("nothing new");
        line("info", "listen", `${verb}`, {
          fetched: meta.fetched, new: meta.new, dup: meta.duplicates,
          queued: meta.enqueued, docs: meta.documents,
          refused: meta.documents_refused, uid: meta.uid,
          ...(meta.resynced ? { resynced: c.yellow("YES") } : {}),
        });
        return;
      }

      case "seat_claimed":
        line("info", "listen", c.green("founding seat claimed by email"), {
          email: meta.email,
          cohort: meta.cohort,
          remaining: meta.remaining,
        });
        return;

      case "observe_started":
        begin("understand", meta.evidence,
          `${String(meta.evidence).slice(0, 24)}${meta.est_tokens ? ` ~${meta.est_tokens}tok` : ""}`);
        line("info", "understand", c.dim("thinking about"), {
          evidence: String(meta.evidence).slice(0, 24),
          // Prompt size, on the line. A prompt too long to prefill inside the
          // upstream's silence window can never succeed, and for an hour that
          // was indistinguishable from a slow model.
          chars: meta.chars,
          est_tokens: meta.est_tokens,
          truncated: meta.truncated ? c.yellow(`from ${meta.truncated}`) : undefined,
          attempt: meta.attempt > 1 ? c.yellow(`#${meta.attempt}`) : undefined,
        });
        return;

      case "model_stream": {
        const phase = meta.phase;
        if (phase === "rejected") {
          flushModelStreamsFor(meta.evidence, meta.attempt);
          const parserCodes = new Set([
            "TRUNCATED_ANSWER", "MALFORMED_BLOCK", "MALFORMED_ARTIFACT",
            "INVALID_JSON", "BAD_ENVELOPE", "BAD_CLAIM", "FIELD_MISSING",
          ]);
          const parserRejected = parserCodes.has(String(meta.code));
          line("warn", "understand", c.yellow(
            parserRejected ? "parser rejected Muse's reply" : "Muse attempt failed",
          ), {
            attempt: meta.attempt,
            code: meta.code,
            why: String(meta.message ?? "").slice(0, 140),
            said: String(meta.sample ?? "").replace(/\r/g, "\\r").replace(/\n/g, "\\n").slice(0, 240),
          });
        } else {
          appendModelStream(meta);
        }
        return;
      }

      case "observed": {
        flushModelStreamsFor(meta.evidence);
        end(meta.evidence);
        stats.observed += 1;
        stats.claims += Number(meta.claims ?? 0);
        if (Number.isFinite(Number(meta.elapsed_ms))) {
          stats.observeMs.push(Number(meta.elapsed_ms));
        }
        line("info", "understand",
          `understood ${c.bold(meta.claims)} claim${meta.claims === 1 ? "" : "s"}`, {
            evidence: String(meta.evidence).slice(0, 20),
            took: human(meta.elapsed_ms),
            rejected: meta.rejected || undefined,
            cached: meta.cached ? c.cyan("cache hit") : undefined,
            recovered: meta.recovered ? c.yellow(meta.recovered) : undefined,
          });
        return;
      }

      case "understood":
        line("info", "understand", c.dim("drain pass"), {
          claimed: meta.claimed, ok: meta.observed, failed: meta.failed,
          claims: meta.claims, backlog: meta.backlog,
        });
        return;

      case "observe_failed":
        flushModelStreamsFor(meta.evidence);
        end(meta.evidence);
        stats.failures += 1;
        stats.retries += 1;
        line("warn", "understand", `could not understand — ${meta.code}`, {
          evidence: String(meta.evidence).slice(0, 20),
          attempt: meta.attempt,
          retry_in: meta.retry_in_s ? `${meta.retry_in_s}s` : undefined,
          why: String(meta.error ?? "").slice(0, 120),
        });
        if (meta.sample) {
          process.stdout.write(c.grey(`          the model said: ${String(meta.sample).slice(0, 200)}\n`));
        }
        return;

      case "job_stuck":
        line("error", "understand",
          c.bgRed(" STUCK ") + " this job keeps failing", {
            evidence: meta.evidence, attempts: meta.attempts,
            since: meta.since, last_error: String(meta.last_error ?? "").slice(0, 120),
          });
        return;

      case "job_failed_permanently":
        end(meta.evidence);
        line("error", "understand", "gave up for good", {
          evidence: meta.evidence, reason: meta.reason ?? meta.error,
        });
        return;

      case "tick":
        line("info", "desk", "tick", {
          in: meta.ingested || undefined,
          sent: meta.sent || undefined,
          facts: meta.facts || undefined,
          matched: meta.proposed || undefined,
          windows_closed: meta.advanced || undefined,
          took: human(meta.ms),
        });
        return;

      case "tick_failed":
        line("error", "desk", "the desk tick failed", {
          why: String(meta.error ?? "").slice(0, 140),
          note: "the loop continues; the next tick runs",
        });
        return;

      case "proposed":
        stats.matches += Number(meta.queued ?? 0);
        line("info", "connect",
          `${c.bold(meta.queued)} network-wide introduction candidate${meta.queued === 1 ? "" : "s"} queued`, {
            pending_review: meta.pending,
          });
        return;

      case "listen_failed":
        line("error", "listen", "cannot read mail", {
          consecutive: meta.consecutive,
          silent_for: `${meta.silent_for_min}m`,
          why: String(meta.error ?? "").slice(0, 140),
        });
        return;

      case "mail_uidvalidity_changed":
        line("warn", "listen", c.yellow("mailbox re-numbered — full resync"), {
          was: meta.was, now: meta.now,
        });
        return;

      case "attachment_refused":
        line("warn", "doc", `refused ${meta.filename}`, {
          why: String(meta.error ?? "").slice(0, 100),
        });
        return;

      case "attachment_empty":
        line("info", "doc", `${meta.filename} had no text`, { why: meta.reason });
        return;

      default:
        line(level, channel, event, meta);
    }
  }

  /** Mark work as in flight, so the heartbeat can name it. */
  function begin(channel, key, what) {
    inFlight.set(key, { channel, what, since: Date.now() });
  }
  function end(key) {
    inFlight.delete(key);
  }

  /**
   * The heartbeat. One line, every interval, whether or not anything happened.
   *
   * This is the part that matters. A slow model means minutes of silence, and
   * silence is the one thing a listener must never be indistinguishable from
   * death. It prints what is in flight and for how long, so "stuck" and "busy"
   * look different.
   */
  function heartbeat({
    graph, health, mailSilenceMinutes, mailConfigured = true, concurrency = null,
  }) {
    if (quiet) return;
    // Flush any partial model sentence before the dashboard line. This keeps the
    // stream readable without letting buffered tokens disappear during a long
    // paragraph with no newline.
    flushAllModelStreams();

    const jobs = graph.jobs.counts();
    const uptime = human(Date.now() - started);
    const avg = stats.observeMs.length
      ? human(stats.observeMs.reduce((a, b) => a + b, 0) / stats.observeMs.length)
      : "—";

    const running = [...inFlight.entries()].map(([key, v]) =>
      `${CHANNELS[v.channel]?.glyph ?? "•"} ${v.what} ${c.grey(human(Date.now() - v.since))}`);

    // "mail ok" with no mailbox configured is a lie of exactly the kind this
    // dashboard exists to prevent — it reads as a healthy sensor when there is
    // no sensor at all.
    const mailState = !mailConfigured
      ? c.grey("no mailbox")
      : health.consecutiveMailFailures > 0
      ? c.red(`mail DOWN ${health.consecutiveMailFailures}x`)
      : mailSilenceMinutes > 120
        ? c.yellow(`quiet ${mailSilenceMinutes}m`)
        : c.green("mail ok");

    const dashboard = [
      `${stamp()} ${c.dim("┈┈")} ${mailState}`,
      `${c.blue("in")} ${stats.ingested}${stats.documents ? `+${stats.documents}doc` : ""}`,
      `${c.magenta("understood")} ${stats.observed}${c.grey("/")}${c.bold(stats.claims)}cl`,
      // RUNNING against its ceiling. Three-in-flight when you asked for one is
      // the difference between a setting you made and a setting that took, and
      // it cost most of an hour to notice from the in-flight list alone.
      `${c.grey("queue")} ${jobs.READY ?? 0}${c.grey("\u2192")}${jobs.RUNNING ?? 0}`
        + `${concurrency ? c.grey(`/${concurrency}`) : ""}`
        + `${(jobs.FAILED ?? 0) > 0 ? c.red(` dead ${jobs.FAILED}`) : ""}`
        + `${stats.retries ? c.yellow(` retries ${stats.retries}`) : ""}`,
      `${c.green("matches")} ${stats.matches}`,
      `${c.grey("avg")} ${avg} ${c.magenta(spark(stats.observeMs))}`,
      `${c.grey("up")} ${uptime}`,
    ].join("  ");
    process.stdout.write(`${dashboard}\n`);

    if (running.length > 0) {
      process.stdout.write(`${" ".repeat(9)}${c.dim("└─ ")}${running.join(c.grey("  ·  "))}\n`);
    }
  }

  return Object.freeze({ log, begin, end, heartbeat, stats, colors: c, human });
}
