# The timer

Two files on the box. A one-shot service plus a timer, rather than a daemon —
a crash is a missed minute, not a wedged IMAP connection.

## /etc/systemd/system/yente-poll.service

```ini
[Unit]
Description=Yente — one tick of the desk
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=yente
WorkingDirectory=/srv/yente
EnvironmentFile=/etc/yente/poll.env
ExecStart=/usr/bin/node bin/poll.mjs --json
# The engine holds an exclusive lock on the data directory, so a tick that
# overlaps a running one exits 0 with status "busy". Nothing to serialise here.
TimeoutStartSec=300
StandardOutput=journal
StandardError=journal

# It reads one mailbox and one directory. Nothing else.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/srv/yente/data
```

## /etc/systemd/system/yente-poll.timer

```ini
[Unit]
Description=Poll the Yente mailbox

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
# Do not fire every tick at :00 across every machine.
RandomizedDelaySec=20
# A tick missed while the box was down runs once on return, not N times.
Persistent=true

[Install]
WantedBy=timers.target
```

## /etc/yente/poll.env

`chmod 600`, owned by root. It holds the mailbox password.

```
YENTE_DATA_PATH=/srv/yente/data/yente
YENTE_MAIL_HOST=box.electronero.org
YENTE_MAIL_USER=yente@ccme.network
YENTE_MAIL_PASS=...
YENTE_FROM=Yente <yente@ccme.network>
YENTE_IMAP_PORT=993
YENTE_SMTP_PORT=587
```

## Bring it up

```bash
# 1. credentials and mailbox only — records nothing, sends nothing, marks nothing
sudo -u yente env $(cat /etc/yente/poll.env | xargs) node bin/poll.mjs --dry-run

# 2. one real tick, watched
sudo -u yente env $(cat /etc/yente/poll.env | xargs) node bin/poll.mjs --json

# 3. hand it to the timer
sudo systemctl daemon-reload
sudo systemctl enable --now yente-poll.timer
systemctl list-timers yente-poll.timer
journalctl -u yente-poll.service -f
```

`--dry-run` first is worth the thirty seconds: it proves IMAP auth, TLS and the
mailbox name without recording a message, marking anything `\Seen`, or sending.
A failed first real tick against a live inbox is recoverable, but only because
the runtime marks `\Seen` after the durable write — do not weaken that.

## Is she reading the inbox?

```
FROM poll_runs ORDER BY started_at DESC LIMIT 20
```

A row with `finished_at: null` is a tick that died. That is the signal to look
at, and it is why the row is written before the work rather than after.
