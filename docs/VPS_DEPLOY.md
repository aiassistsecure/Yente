# Yente public site — VPS deployment

The public landing page, waitlist API, embedded NEDB v2 DAG, live counters, and
admin export run in one Node.js process. Nginx terminates TLS and proxies to the
loopback-only Yente server.

## 1. Install and configure

Node.js 24 or newer is required.

```sh
git clone https://github.com/aiassistsecure/Yente.git /opt/yente
cd /opt/yente
npm ci
cp .env.example .env
useradd --system --home /opt/yente --shell /usr/sbin/nologin yente
install -d -m 700 /var/lib/yente/waitlist-nedb
chown -R yente:yente /var/lib/yente
```

Set a long random admin password and an absolute data path in `/opt/yente/.env`:

```dotenv
YENTE_WAITLIST_DATA_PATH=/var/lib/yente/waitlist-nedb
YENTE_ADMIN_USERNAME=interchained
YENTE_ADMIN_PASSWORD=replace-with-a-long-random-password
YENTE_HOST=127.0.0.1
YENTE_PORT=3000
YENTE_TRUST_PROXY=1
```

The local shell launch requested for Yente is:

```sh
set -a
source .env
set +a
npm start
```

Open `http://127.0.0.1:3000/healthz` and confirm `ok: true`,
`storage: nedb-v2-dag-embedded`, and `scanReady: true`.

## 2. systemd

Create `/etc/systemd/system/yente.service`:

```ini
[Unit]
Description=Yente public site and founding network
After=network.target

[Service]
Type=simple
User=yente
Group=yente
WorkingDirectory=/opt/yente
EnvironmentFile=/opt/yente/.env
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/yente

[Install]
WantedBy=multi-user.target
```

Then start it:

```sh
systemctl daemon-reload
systemctl enable --now yente
systemctl status yente
```

Only one process may open `YENTE_WAITLIST_DATA_PATH`. NEDB locks the dedicated
waitlist directory and refuses a split-brain second writer. Do not point this
variable at Yente's core database directory.

## 3. nginx and TLS

Use the intended public hostname in place of `ccme.network`:

```nginx
server {
    listen 443 ssl http2;
    server_name ccme.network www.ccme.network;

    client_max_body_size 32k;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Do not expose the admin panel over plain HTTP. HTTP Basic credentials are read
only from `.env`; the browser sends them to `/admin/` and `/api/admin/*` over
the TLS connection.

## 4. Operations

- Public site: `/`
- Admin subscriber desk: `/admin/`
- Public live capacity: `/api/founding-network/capacity`
- Admin JSON records: `/api/admin/subscribers`
- Admin CSV export: `/api/admin/subscribers.csv`
- Health: `/healthz`

The public page polls capacity every 10 seconds. Failures back off to two
minutes and recover automatically. The admin desk refreshes every 15 seconds.

CSV export neutralizes spreadsheet-formula prefixes and quotes every field.
Back up the directory named by `YENTE_WAITLIST_DATA_PATH`; stop the Yente
service first when taking a raw filesystem copy so the snapshot has one durable
boundary.
