# Running the desk

`bin/daemon.mjs` is a long-lived process that polls the mailbox on an interval.
**Nobody runs a tick by hand.** systemd starts it once and it keeps reading the
inbox until stopped.

`bin/poll.mjs` still exists for one thing: `--dry-run`, to prove credentials
before the daemon touches anyone. It is a debugging tool, not the deployment.

## Why a daemon rather than a timer

The embedded engine holds an exclusive lock on its data directory for the life
of the process and exposes no close. A one-shot tick therefore pays a full cold
open every run — **measured at 3.8s on the box**, almost all of it the store, for
work that took milliseconds. Holding the store open across ticks removes that,
and since the lock is per-process regardless, a long-lived owner is the shape the
engine actually wants.

## /etc/systemd/system/yente.service

```ini
[Unit]
Description=Yente — the desk
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=yente
WorkingDirectory=/opt/yente
EnvironmentFile=/etc/yente/yente.env
ExecStart=/usr/bin/node bin/daemon.mjs

# The loop survives its own errors, so a restart here means the process itself
# died. Always come back.
Restart=always
RestartSec=5

# SIGTERM lets the in-flight tick finish before the store flushes. Killing a
# tick between recording a message and marking it \Seen, or between reserving
# an outbox row and sending it, is exactly what this avoids.
KillSignal=SIGTERM
TimeoutStopSec=45

StandardOutput=journal
StandardError=journal

# It reads one mailbox and one directory. Nothing else.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/yente/data

[Install]
WantedBy=multi-user.target
```

## /etc/yente/yente.env

`chmod 600`, owned by root — it holds the mailbox password.

```
YENTE_DATA_PATH=/opt/yente/data/yente
YENTE_MAIL_HOST=box.electronero.org
YENTE_MAIL_USER=yente@ccme.network
YENTE_MAIL_PASS=...
YENTE_FROM=Yente <yente@ccme.network>
YENTE_IMAP_PORT=993
YENTE_SMTP_PORT=587

# How often she checks. 30s is responsive without being rude to the mailbox.
YENTE_POLL_INTERVAL_MS=30000
# Ceiling for the backoff when the mailbox is unreachable.
YENTE_MAX_BACKOFF_MS=300000
# YENTE_LOG_JSON=1 for structured lines in the journal.
```

## Bring it up

```bash
# 1. credentials and mailbox only — records nothing, sends nothing, marks nothing
node bin/poll.mjs --dry-run

# 2. hand it to systemd
sudo systemctl daemon-reload
sudo systemctl enable --now yente
journalctl -u yente -f
```

That is the last manual step. From then on she runs.

## What the daemon has to get right

A one-shot process gets crash-safety for free — it dies, systemd runs it again,
nothing carries over. A daemon has to earn the same properties, and these are
tested:

**An error does not kill the loop.** Verified against a refused mailbox: five
consecutive failures, loop still running.

```
tick_failed  connect ECONNREFUSED  consecutive=1  next_in_ms=1000
tick_failed  connect ECONNREFUSED  consecutive=2  next_in_ms=2000
tick_failed  connect ECONNREFUSED  consecutive=3  next_in_ms=4000
tick_failed  connect ECONNREFUSED  consecutive=4  next_in_ms=8000
tick_failed  connect ECONNREFUSED  consecutive=5  next_in_ms=8000
```

**Repeated failure backs off** to `YENTE_MAX_BACKOFF_MS` and returns to the
normal interval on the first success. A dead mailbox is not hammered.

**Ticks cannot overlap themselves.** The loop awaits the tick, then sleeps —
not `setInterval`, which would start a second tick on top of a slow one.

**Shutdown finishes the tick.** SIGTERM sets a flag and cuts the sleep short;
the in-flight tick runs to completion (30s bound), then the store flushes.

**An unhandled rejection reaches the log** before Node exits, so `Restart=always`
is recovery rather than a silent loop.

## Is she reading the inbox?

```
FROM poll_runs ORDER BY started_at DESC LIMIT 20
```

Every tick appends a row **before** doing the work, so **a row with
`finished_at: null` is a tick that did not complete.** That is the signal to look
at. Verified: against a refused mailbox, all five rows came back with a null
`finished_at`.

Quiet ticks are not logged — only ticks that ingested or sent something, plus
every failure. A log full of "nothing happened" is a log nobody reads.
