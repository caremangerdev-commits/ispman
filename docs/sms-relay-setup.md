# SMS relay — setting up SMSGate on the EC2 box

Run these yourself. Nothing in this repo touches the box.

The relay is [SMSGate](https://docs.sms-gate.app/getting-started/private-server/)
in **private mode**: each tenant's Android phone connects *outbound* to it, which
is what lets a tenant on a dynamic IP receive work without a static address or a
port forward.

**What must not move:** Apache keeps 80/443, ISPMan keeps 3000, FreeRADIUS keeps
1812/1813 UDP and its `radius` schema. The relay takes 3001 on loopback only and
gets its own MariaDB schema. The single shared resource is the MariaDB daemon.

**Networking choice.** The container runs with `--network host` and is configured
to listen on `127.0.0.1:3001`. The alternative — bridge networking with a
published port — would force MariaDB to listen on the docker bridge so the
container could reach it, which exposes your database to every container on the
box and buys nothing. This way MariaDB stays loopback-only and the relay is
reachable only through Apache.

---

## 0. Before you change anything

Confirm the ports are as expected and 3001 is genuinely free:

```sh
sudo ss -lntp | grep -E ':(80|443|3000|3001|3306)\s'
```

Expect: Apache on 80/443, node on 3000, MariaDB on 127.0.0.1:3306, **nothing on
3001**. If MariaDB shows `0.0.0.0:3306`, stop and fix that first — it is a
pre-existing exposure, but it becomes far more interesting once customer phone
numbers are in there.

```sh
docker --version && sudo systemctl is-active docker
```

Expect a version and `active`.

---

## 1. The database

SMSGate wants "an empty database and a privileged user" and runs its own
migrations against it. It gets `smsgate` and nothing else — in particular it is
never granted anything on `radius`, because a third-party migrator near
FreeRADIUS's schema is a bad trade for no benefit.

Generate a password and keep it; it goes in step 2.

```sh
openssl rand -base64 24
```

```sh
sudo mysql -u root -p
```

```sql
CREATE DATABASE smsgate CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- BOTH host forms on purpose. With --network host the container connects over
-- 127.0.0.1, and whether MariaDB calls that 'localhost' or '127.0.0.1' depends
-- on skip-name-resolve. Creating both means the grant works either way.
CREATE USER 'smsgate'@'localhost' IDENTIFIED BY 'PASTE-THE-PASSWORD';
CREATE USER 'smsgate'@'127.0.0.1' IDENTIFIED BY 'PASTE-THE-PASSWORD';

GRANT ALL PRIVILEGES ON smsgate.* TO 'smsgate'@'localhost';
GRANT ALL PRIVILEGES ON smsgate.* TO 'smsgate'@'127.0.0.1';
FLUSH PRIVILEGES;
```

Verify the grant is scoped to the one schema:

```sh
sudo mysql -u root -p -e "SHOW GRANTS FOR 'smsgate'@'127.0.0.1';"
```

Expect exactly two lines — `USAGE ON *.*` and `ALL PRIVILEGES ON \`smsgate\`.*`.
**If you see anything mentioning `radius`, stop.**

Confirm the user can reach its own schema and nothing else:

```sh
mysql -u smsgate -p -h 127.0.0.1 -e "SHOW DATABASES;"
```

Expect `information_schema` and `smsgate`. **Not `radius`.**

---

## 2. The config file

```sh
openssl rand -hex 32          # this is the private token — keep it
sudo mkdir -p /opt/smsgate
sudo nano /opt/smsgate/config.yml
```

```yaml
gateway:
  mode: private
  # The phones are configured with this. Same for every tenant on this box.
  private_token: PASTE-THE-HEX-TOKEN

http:
  # LOOPBACK ONLY. With --network host this is the host's own 127.0.0.1:3001,
  # so Apache is the only thing that can reach it and a firewall mistake cannot
  # expose the relay directly.
  listen: 127.0.0.1:3001

database:
  host: 127.0.0.1
  port: 3306
  user: smsgate
  password: PASTE-THE-DB-PASSWORD
  database: smsgate
  timezone: UTC
```

`timezone: UTC` deliberately. Everything ISPMan stores is an instant in UTC and
is rendered per tenant at the edge — see `scripts/fix-payment-times.mjs` for what
happens when that rule is broken.

It holds two secrets:

```sh
sudo chmod 600 /opt/smsgate/config.yml
sudo ls -l /opt/smsgate/config.yml
```

Expect `-rw------- 1 root root`. The container runs as uid 405, so step 3 will
fail to read this until it is chowned — that is handled there.

---

## 3. The container

```sh
sudo docker run -d \
  --name smsgate \
  --restart unless-stopped \
  --network host \
  -v /opt/smsgate/config.yml:/app/config.yml:ro \
  -e CONFIG_PATH=/app/config.yml \
  ghcr.io/android-sms-gateway/server:latest
```

(`docker compose` works equally well; this is one service with one volume, so a
compose file would only add a second place to look.)

```sh
sudo docker logs -f smsgate
```

You are watching for it to run its migrations and reach a listening state
without a database error. The exact wording varies between versions — what
matters is that you do **not** see `connection refused`, `access denied`, or a
migration failure. Ctrl-C to stop following.

```sh
sudo ss -lntp | grep 3001
```

Expect a listener on **127.0.0.1:3001** — not `0.0.0.0:3001`. If it shows
`0.0.0.0`, the `http.listen` in step 2 did not take effect; fix it and
`sudo docker restart smsgate`.

```sh
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/api/3rdparty/v1/health
```

**200 or 401 both mean it is up** — 401 just means that endpoint wants
credentials on your version. `000` or `connection refused` means it is not.

Confirm nothing else moved:

```sh
sudo ss -lntp | grep -E ':(80|443|3000)\s'
sudo systemctl is-active apache2 freeradius
```

---

## 4. Apache

A **new vhost file**, not an edit to the ISPMan one, so the relay can be taken
offline without touching the app.

```sh
sudo a2enmod proxy proxy_http proxy_wstunnel
```

`proxy_wstunnel` is a precaution: if your server version keeps a websocket open
to the phones rather than polling, a proxy without it pairs successfully and
then silently never delivers. Harmless if unused.

Point `sms.YOURDOMAIN` at the box in DNS and wait for it to resolve:

```sh
dig +short sms.YOURDOMAIN
```

Expect the box's public IP. Certbot will fail if this is not right yet.

```sh
sudo nano /etc/apache2/sites-available/sms.conf
```

```apache
<VirtualHost *:80>
    ServerName sms.YOURDOMAIN

    ProxyPreserveHost On
    ProxyPass        / http://127.0.0.1:3001/
    ProxyPassReverse / http://127.0.0.1:3001/

    # Only if the server upgrades to a websocket; inert otherwise.
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} =websocket [NC]
    RewriteRule /(.*) ws://127.0.0.1:3001/$1 [P,L]

    ErrorLog  ${APACHE_LOG_DIR}/sms-error.log
    CustomLog ${APACHE_LOG_DIR}/sms-access.log combined
</VirtualHost>
```

```sh
sudo a2enmod rewrite
sudo apache2ctl configtest
```

Expect `Syntax OK`. **Do not continue if it says anything else** — the next
command reloads the server ISPMan is behind.

```sh
sudo a2ensite sms
sudo systemctl reload apache2
curl -sS -o /dev/null -w '%{http_code}\n' http://sms.YOURDOMAIN/api/3rdparty/v1/health
```

Same expectation as before: 200 or 401.

```sh
sudo certbot --apache -d sms.YOURDOMAIN
```

Choose redirect-to-HTTPS when it offers. Then, from a machine that is **not** the
box:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' https://sms.YOURDOMAIN/api/3rdparty/v1/health
```

Confirm ISPMan is still served and its certificate is untouched:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' https://YOUR-ISPMAN-DOMAIN/
```

---

## 5. ISPMan

`.env.local`, in the project directory:

```sh
SMS_RELAY_URL=https://sms.YOURDOMAIN
SMS_DISPATCH_SECRET=PASTE-A-SECOND-openssl-rand-hex-32
```

`SMS_RELAY_URL` is the vhost, with no path — the `/api/3rdparty/v1` prefix is added
by `lib/sms/relay.ts`. `SMS_DISPATCH_SECRET` is unrelated to the relay: it is
what stops anything but the ticker calling `/api/sms/dispatch`.

**No tenant credentials go in here.** Each company's relay username and password
are entered on their own settings page and stored per company in `sms_devices`,
and the private token from step 2 never reaches ISPMan at all.

```sh
pm2 restart ispman --update-env
pm2 start worker/sms-ticker.mjs --name ispman-sms --cwd /PATH/TO/ispman
pm2 save
```

`--update-env` matters: without it pm2 reuses the old environment and
`SMS_RELAY_URL` stays unset, which looks exactly like having done nothing.

**One ticker instance**, which is what plain fork mode (pm2's default) gives.
Do NOT add `-i 1`: despite how it reads, that switches pm2 into CLUSTER mode,
which is the wrong runtime for an ESM script and the opposite of the intent.

A second ticker corrupts nothing — the outbox claim is a compare-and-swap and
the dedupe key is a unique index — but it doubles the rate each SIM sends at,
which is the one thing the throttle exists to prevent.

```sh
pm2 logs ispman-sms --lines 20
```

Expect one `[sms-ticker] started; …` line and then silence. It is quiet by
design: it logs only ticks that did something, because a line a minute would
bury the one that matters under a week of "0 sent".

Reload **Settings → SMS Notifications**. "Relay not configured" should be gone,
replaced by the pairing form.

---

## 6. Pair the first phone

In the Android app: **Cloud Server** mode, URL `https://sms.YOURDOMAIN`, and the
`private_token` from step 2.

On first successful connect the relay **generates a username and password** and
shows them in the app's Cloud Server section. Enter that pair on the company's
SMS settings page. ISPMan verifies them against the relay before storing them,
so a wrong paste is refused rather than saved into a queue that silently fails.

Then, on that company: turn on the master switch, turn on one message type, and
send yourself a test through **Send a Message** filtered to a single customer.

---

## 7. Retention

The relay stores message bodies and recipient numbers **in plaintext**. Ten
tenants' customers on one box. ISPMan's `sms_outbox` is the record of what was
sent; the relay only needs enough history to match late delivery reports and to
answer "why did this not send" a week later.

**30 days**, pruned nightly.

Credentials in a file rather than on the command line, so they stay out of `ps`
and the shell history:

```sh
sudo tee /root/.smsgate.cnf >/dev/null <<'EOF'
[client]
user=smsgate
password=PASTE-THE-DB-PASSWORD
host=127.0.0.1
EOF
sudo chmod 600 /root/.smsgate.cnf
```

Check the table name against what the server actually created — it owns its own
migrations and may rename things between versions:

```sh
sudo mysql -u root -p -e "SHOW TABLES IN smsgate;"
```

Then, using the table name you just saw:

```sh
sudo tee /etc/cron.daily/smsgate-prune >/dev/null <<'EOF'
#!/bin/sh
mysql --defaults-file=/root/.smsgate.cnf smsgate \
  -e "DELETE FROM messages WHERE created_at < NOW() - INTERVAL 30 DAY;"
EOF
sudo chmod 755 /etc/cron.daily/smsgate-prune
sudo /etc/cron.daily/smsgate-prune && echo "prune ok"
```

**Exclude `smsgate` from whatever backs up `radius`.** A 30-day retention
contradicted by a year of nightly dumps achieves nothing.

---

## If nothing sends

In this order:

```sh
pm2 logs ispman-sms --lines 50        # is the ticker running and reaching the app?
sudo docker logs --tail 50 smsgate    # is the relay accepting the messages?
```

Then check, on the tenant's settings page: master switch on, phone shows as
recently seen, and the message type you expect actually enabled. A queued row
with nowhere to go stays `queued` and is visible in `sms_outbox`.

---

## Rolling it back

```sh
sudo docker rm -f smsgate
sudo a2dissite sms && sudo systemctl reload apache2
pm2 delete ispman-sms && pm2 save
```

Remove `SMS_RELAY_URL` from `.env.local` and `pm2 restart ispman --update-env`;
the settings page returns to "Relay not configured" and nothing queues. The
schema and the user can stay — they cost nothing and keep the pairing
credentials valid if you bring it back.
