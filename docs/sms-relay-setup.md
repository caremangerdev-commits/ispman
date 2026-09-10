# SMS relay — setting up SMSGate on the EC2 box

Run these yourself. Nothing in this repo touches the box.

The relay is [SMSGate](https://docs.sms-gate.app/getting-started/private-server/)
in **private mode**: each tenant's Android phone connects *outbound* to it, which
is what lets a tenant on a dynamic IP receive work without a static address or a
port forward.

**What must not move:** Apache keeps 80/443, ISPMan keeps 3000, FreeRADIUS keeps
1812/1813 UDP and its `radius` schema. The relay takes 3001 on loopback only and
gets its own MariaDB schema. The single shared resource is the MariaDB daemon.

---

## 1. The database

SMSGate wants "an empty database and a privileged user" and runs its own
migrations against it. It gets `smsgate` and nothing else — in particular it is
never granted anything on `radius`, because a third-party migrator near
FreeRADIUS's schema is a bad trade for no benefit.

Pick a password first and keep it; it goes in the config file in step 2.

```sh
sudo mysql -u root -p
```

```sql
CREATE DATABASE smsgate CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- '%' rather than 'localhost': the relay connects from inside a container, so
-- from MariaDB's point of view it arrives over the docker bridge, not loopback.
-- The bind-address below is what keeps that from meaning "the internet".
CREATE USER 'smsgate'@'%' IDENTIFIED BY 'PUT-A-LONG-RANDOM-PASSWORD-HERE';
GRANT ALL PRIVILEGES ON smsgate.* TO 'smsgate'@'%';
FLUSH PRIVILEGES;
```

Confirm the grant is scoped to the one schema — this should list `smsgate.*`
and nothing else:

```sh
sudo mysql -u root -p -e "SHOW GRANTS FOR 'smsgate'@'%';"
```

Check MariaDB is not listening to the world. It should be `127.0.0.1` or the
docker bridge address, never `0.0.0.0`:

```sh
sudo ss -lntp | grep 3306
```

If that shows `0.0.0.0:3306`, stop and fix it before going further — that is a
pre-existing exposure, not something this adds, but it becomes a lot more
interesting once customer phone numbers are in there.

---

## 2. The config file

```sh
sudo mkdir -p /opt/smsgate
sudo nano /opt/smsgate/config.yml
```

```yaml
gateway:
  mode: private
  # The phones are configured with this. Generate it with:
  #   openssl rand -hex 32
  private_token: PUT-THE-GENERATED-TOKEN-HERE

http:
  # Inside the container. The host-side bind is in the compose file.
  listen: 0.0.0.0:3000

database:
  # From inside the container, the host is the docker bridge gateway.
  host: 172.17.0.1
  port: 3306
  user: smsgate
  password: PUT-THE-SAME-PASSWORD-AS-STEP-1
  database: smsgate
  timezone: UTC
```

`timezone: UTC` deliberately. Everything ISPMan stores is an instant in UTC and
is rendered per tenant at the edge — see the payment-time repair in
`scripts/fix-payment-times.mjs` for what happens when that rule is broken.

Lock it down; it holds two secrets:

```sh
sudo chmod 600 /opt/smsgate/config.yml
```

Confirm the bridge address matches your box — if this prints something other
than `172.17.0.1`, use what it prints in `database.host` above:

```sh
ip -4 addr show docker0 | grep -oP '(?<=inet\s)\d+(\.\d+){3}'
```

---

## 3. The container

```sh
sudo nano /opt/smsgate/docker-compose.yml
```

```yaml
services:
  smsgate:
    image: ghcr.io/android-sms-gateway/server:latest
    container_name: smsgate
    restart: unless-stopped
    # 127.0.0.1 ON PURPOSE. Apache is the only public listener; this way a
    # firewall mistake cannot expose the relay directly.
    ports:
      - "127.0.0.1:3001:3000"
    volumes:
      - /opt/smsgate/config.yml:/app/config.yml:ro
    environment:
      CONFIG_PATH: /app/config.yml
```

```sh
cd /opt/smsgate && sudo docker compose up -d
sudo docker compose logs -f smsgate
```

Wait for it to report that migrations have run, then check it answers on
loopback and that nothing else changed:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/health
sudo ss -lntp | grep -E ':(80|443|3000|3001)\s'
```

You want 3000 still held by ISPMan's node process and 3001 held by
docker-proxy on 127.0.0.1 only.

---

## 4. Apache

A **new vhost file**, not an edit to the ISPMan one — so the relay can be taken
offline without touching the app.

```sh
sudo a2enmod proxy proxy_http
sudo nano /etc/apache2/sites-available/sms.conf
```

```apache
<VirtualHost *:80>
    ServerName sms.YOURDOMAIN

    ProxyPreserveHost On
    ProxyPass        / http://127.0.0.1:3001/
    ProxyPassReverse / http://127.0.0.1:3001/

    ErrorLog  ${APACHE_LOG_DIR}/sms-error.log
    CustomLog ${APACHE_LOG_DIR}/sms-access.log combined
</VirtualHost>
```

Point `sms.YOURDOMAIN` at the box in DNS first, then:

```sh
sudo apache2ctl configtest
sudo a2ensite sms
sudo systemctl reload apache2
sudo certbot --apache -d sms.YOURDOMAIN
```

`configtest` before enabling, and `reload` rather than `restart`, so a typo
cannot take ISPMan down with it.

Verify from somewhere off the box:

```sh
curl -sS https://sms.YOURDOMAIN/health
```

---

## 5. Pair the first phone

In the Android app: **Cloud Server** mode, URL `https://sms.YOURDOMAIN`, and the
`private_token` from step 2.

On first successful connect the server **generates a username and password** and
shows them in the app's Cloud Server section. That pair — not the private token
— is the HTTP Basic credential ISPMan stores for that tenant, on the SMS
settings page. The private token never leaves the box and the phones.

---

## 6. Retention

The relay stores message bodies and recipient numbers **in plaintext**. Ten
tenants' customers on one box. ISPMan's `sms_outbox` is the record of what was
sent; the relay only needs enough history to match late delivery reports and to
answer "why did this not send" a week later.

**30 days**, pruned nightly:

```sh
sudo tee /etc/cron.daily/smsgate-prune >/dev/null <<'EOF'
#!/bin/sh
mysql --defaults-file=/root/.smsgate.cnf smsgate \
  -e "DELETE FROM messages WHERE created_at < NOW() - INTERVAL 30 DAY;"
EOF
sudo chmod 755 /etc/cron.daily/smsgate-prune
```

with credentials in a file rather than the command line, so they stay out of
`ps` and the shell history:

```sh
sudo tee /root/.smsgate.cnf >/dev/null <<'EOF'
[client]
user=smsgate
password=PUT-THE-SAME-PASSWORD-AS-STEP-1
host=127.0.0.1
EOF
sudo chmod 600 /root/.smsgate.cnf
```

Check the table name against the schema the server actually created before you
trust that cron — the server owns its own migrations and may rename things
between versions:

```sh
sudo mysql -u root -p -e "SHOW TABLES IN smsgate;"
```

**Exclude `smsgate` from whatever backs up `radius`.** A 30-day retention
contradicted by a year of nightly dumps achieves nothing.

---

## Rolling it back

```sh
cd /opt/smsgate && sudo docker compose down
sudo a2dissite sms && sudo systemctl reload apache2
```

The schema and the user can stay; they cost nothing and keep the pairing
credentials valid if you bring it back.
