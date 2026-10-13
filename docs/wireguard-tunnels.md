# Router tunnels — WireGuard between tenant routers and the RADIUS server

Run these yourself. Nothing in this repo touches the box; ISPMan only writes
`nas` rows and prints the blocks you paste.

**Why.** Tenant routers sit on dynamic public IPs that change about daily. A
`nas` row keyed on a public IP goes stale the next time the address moves, and
the router falls onto the shared `0.0.0.0/0` catch-all: one client, one secret,
one set of runtime state for every router behind it. Each router now builds a
WireGuard tunnel to the server and sends RADIUS through it from a fixed inside
address with its own permanent `nas` row and secret.

**Decided (owner, 13 Oct 2026).** One peer per router, not per company. The
router generates its own key; ISPMan only ever sees the public half. The public
RADIUS path stays as a fallback during the move, then is closed: tunnel only.

**The values** (defined once, in `lib/tunnels/wireguard.ts`):

| | |
|---|---|
| Tunnel network | `10.250.0.0/24` — server `10.250.0.1`, routers `.2`–`.254`, never reused |
| Server interface | `wg-routers`, config `/etc/wireguard/wg-routers.conf`, UDP `51820` |
| Router interface | `wg-ispman`, listen port `13239`, keepalive `25s` |
| RADIUS inside the tunnel | `10.250.0.1:1812/1813`, sent from the router's tunnel address |

`10.250.0.0/24` overlaps nothing a tenant used in 90 days of radacct (10.5, 10.9,
10.10, 10.11, 10.30, 10.99, 100.100, 172.16, 172.30, 172.168, 192.168) and is not
the EC2 default VPC (172.31). The interface is `wg-routers`, not `wg0`, so it
cannot land on top of whatever gives WCN's router `10.99.99.110`.

---

## 0. Before you change anything

All read-only.

```sh
# Kernel WireGuard. Ubuntu 20.04's kernel carries it; this just loads it.
sudo modprobe wireguard && echo wireguard ok

# Anything already using WireGuard, 10.99.99.x or 10.250.x on this box.
# This is also where 10.99.99.110 may turn out to come from.
ip -4 addr | grep -E 'wg|10\.99\.|10\.250\.'
sudo wg show
ls -la /etc/wireguard/

# The box's own networks: 10.250.0.0/24 must not be one of them.
ip -4 route

# How FreeRADIUS listens. "ipaddr = *" needs no change (section 3).
sudo grep -n -A6 '^listen' /etc/freeradius/3.0/sites-enabled/default
sudo ss -lunp | grep -E ':(1812|1813|51820)\b'

# FreeRADIUS must be reading clients from the nas table.
sudo grep -n 'read_clients' /etc/freeradius/3.0/mods-enabled/sql

# Firewall in use, and forwarding (Docker turns it on).
sudo ufw status
sudo iptables -S | head -40
sysctl net.ipv4.ip_forward

# MariaDB answers remote connections today (ISPMan's scripts reach it from
# outside), which is why the tunnel firewall below allows RADIUS and nothing else.
sudo ss -lntp | grep 3306
```

Expect: nothing on `10.250.x`, nothing named `wg-routers`, `read_clients = yes`.
If FreeRADIUS listens on specific addresses rather than `*`, section 3 has an
extra step.

---

## 1. WireGuard on the server

```sh
sudo apt install wireguard

# The server's key pair. The private key goes straight into a root-only file
# and is never printed; only the public key is ever copied anywhere.
sudo sh -c 'umask 077; wg genkey > /etc/wireguard/wg-routers.key; wg pubkey < /etc/wireguard/wg-routers.key > /etc/wireguard/wg-routers.pub'
sudo cat /etc/wireguard/wg-routers.pub     # PUBLIC key -> WG_SERVER_PUBLIC_KEY (section 6)
```

Create `/etc/wireguard/wg-routers.conf`:

```ini
# ISPMan router tunnels. One [Peer] per router is appended below by the
# server block ISPMan prints. Values: lib/tunnels/wireguard.ts.
[Interface]
Address = 10.250.0.1/24
ListenPort = 51820
# The private key stays in its own root-only file, never in this one.
PostUp = wg set %i private-key /etc/wireguard/%i.key

# Tenant routers may reach RADIUS on this box and nothing else: not SSH, not
# MariaDB, not ISPMan, and not each other. -I puts each rule on top, so read
# them bottom-up: RADIUS accepted, ping accepted, everything else dropped.
PostUp = iptables -I INPUT -i %i -j DROP
PostUp = iptables -I INPUT -i %i -p icmp -j ACCEPT
PostUp = iptables -I INPUT -i %i -p udp -m multiport --dports 1812,1813 -j ACCEPT
PostUp = iptables -I FORWARD -i %i -j DROP
PostUp = iptables -I FORWARD -o %i -j DROP
PostDown = iptables -D INPUT -i %i -p udp -m multiport --dports 1812,1813 -j ACCEPT
PostDown = iptables -D INPUT -i %i -p icmp -j ACCEPT
PostDown = iptables -D INPUT -i %i -j DROP
PostDown = iptables -D FORWARD -i %i -j DROP
PostDown = iptables -D FORWARD -o %i -j DROP
```

No `SaveConfig`: peers are added to this file by hand from ISPMan's blocks, and
`SaveConfig` would overwrite it on shutdown.

```sh
sudo chmod 600 /etc/wireguard/wg-routers.conf
sudo systemctl enable --now wg-quick@wg-routers
sudo wg show wg-routers                         # listening port 51820, no peers
sudo iptables -S INPUT | grep wg-routers        # the three INPUT rules
sudo iptables -S FORWARD | grep wg-routers      # the two FORWARD drops
```

Nothing changes for existing traffic: no router knows about the tunnel yet.

## 2. AWS security group

Inbound **UDP 51820 from 0.0.0.0/0**. Routers' addresses change, so it cannot
be narrowed; WireGuard silently ignores anything without a valid key.

Leave 1812/1813 open. They close at cutover (section 10).

Check the box has an **Elastic IP**. That address goes in every router's
config; if it ever changed, every tunnel would break at once.

## 3. FreeRADIUS: listening on the tunnel

If section 0 showed `ipaddr = *` (`0.0.0.0:1812` or `*:1812` in `ss`), FreeRADIUS
already answers on `10.250.0.1`. Nothing to do.

If it is bound to a specific address, add `listen` sections for `10.250.0.1`
(auth and acct) beside the existing ones, **and** make FreeRADIUS start after
the tunnel. Otherwise, at boot, it starts before `10.250.0.1` exists, fails to
bind, and every company loses RADIUS:

```sh
sudo systemctl edit freeradius
#   [Unit]
#   After=wg-quick@wg-routers.service
#   Wants=wg-quick@wg-routers.service
```

Nothing goes in `clients.conf`: each router is a `nas` row, and `read_clients`
loads them at start.

## 4. The RADIUS database user can write `nas`

ISPMan writes `nas` rows with the same MariaDB user it uses for `radcheck`. If
that user's grants are per table, add `nas`:

```sql
SHOW GRANTS FOR '<RADIUS_DB_USER>'@'<host>';
-- only if nas is not covered:
GRANT SELECT, INSERT, DELETE ON radius.nas TO '<RADIUS_DB_USER>'@'<host>';
```

Without it, "Save key" fails with `ER_TABLEACCESS_DENIED_ERROR` and nothing is
saved.

## 5. Tunnel status for the settings card

ISPMan cannot ask WireGuard itself (that needs root), so root writes the
latest handshake per peer to a file every minute:

```sh
sudo mkdir -p /var/lib/ispman
sudo tee /etc/cron.d/ispman-wg >/dev/null <<'EOF'
# ISPMan router tunnel status. latest-handshakes, NEVER "wg show dump":
# dump's first line is the server's private key.
* * * * * root /usr/bin/wg show wg-routers latest-handshakes > /var/lib/ispman/wg-handshakes.tmp && mv /var/lib/ispman/wg-handshakes.tmp /var/lib/ispman/wg-handshakes
EOF
```

A minute later `/var/lib/ispman/wg-handshakes` exists and is world-readable.

## 6. ISPMan

1. Apply `supabase/migrations/0033_router_tunnels.sql` in the Supabase SQL editor.
2. In ISPMan's `.env.local` on the box:

   ```
   WG_SERVER_PUBLIC_KEY=<contents of /etc/wireguard/wg-routers.pub>
   WG_SERVER_ENDPOINT=<the Elastic IP>
   WG_HANDSHAKES_FILE=/var/lib/ispman/wg-handshakes
   ```

3. Restart ISPMan the way it is normally deployed.

**Settings → Router Tunnels** appears for the super admin only, inside a company.

**Try it on Demo ISP Jamaica (company 23) first.** Add a router; step 1 should
appear. Pasting a key writes a real `nas` row (`10.250.0.x`) into the live RADIUS
database, which is harmless (no peer can reach it), but revoke the demo router
afterwards so the row goes again.

---

## 7. Adding a router

In **Settings → Router Tunnels**, inside the router's company:

1. **Add Router.** Give it a name ("Main CCR") and the services its RADIUS
   carries (DHCP for the tenants on this server today). It gets the next free
   tunnel address.
2. **Step 1, on the router.** Paste it into the terminal. It prints the
   RouterOS version (must start with 7, see section 11) and whether the NTP
   client is on (must be `true`). After a reboot, WireGuard will not reconnect
   until the router's clock is right. Then it creates `wg-ispman` and prints
   the router's public key.
3. **Paste key**, then **Save key**. ISPMan writes the router's `nas` row with a
   fresh secret and shows two blocks.
4. **The server block, as root.** It adds the peer (live and in
   `wg-routers.conf`), then checks the FreeRADIUS config and restarts it to
   load the new `nas` row. Adding several routers? Run the `wg set` and `cat`
   parts for each, and the restart once at the end.
5. **Step 2, on the router.** It adds the peer, the tunnel address (which
   brings its own route), and a `/radius` entry for `10.250.0.1` moved to the
   top. **The existing public entry stays below it**: that is the fallback.

Check it:

```sh
# Server: the peer, its latest handshake, and the router's current public IP.
sudo wg show wg-routers
# Requests from 10.250.0.N and FreeRADIUS's replies, through the tunnel.
sudo tcpdump -ni wg-routers udp port 1812 or udp port 1813
```

On the router, `/interface wireguard peers print detail where comment="ISPMan server"`
should show a `last-handshake` within a minute. New sessions in radacct carry
NAS-IP-Address `10.250.0.N`, and the card shows **Up**.

**The RouterOS lines were written without a RouterOS 7 router to try them on.**
The pilot is where they are proven. If a line fails, fix it in
`lib/tunnels/wireguard.ts`, not just in the pasted copy, so every later router
gets the fix.

## 8. The pilot: one router first

WCN's "DHCP - MAIN" router. It has the worst churn of any router (about 80
public and CGNAT addresses in 30 days) and runs several WANs, so if the tunnel
holds there, it holds anywhere.

Leave it at least three days, through at least one WAN address change and one
reboot. The card should stay **Up** throughout; `wg show` shows the endpoint
following the router's new address.

**Then test the fallback.** On the router run
`/interface wireguard disable wg-ispman` for 10 minutes:

- New leases should still be answered, through the public entry. Each one is
  slower, because the router waits 1s on the tunnel first.
- Watch what a client renewing in that window does.

Re-enable it with `/interface wireguard enable wg-ispman`.

## 9. The rest

The three companies that went dark this week next, then everyone else, with
routers on static public IPs last (they work today). Batch the `nas` rows: one
FreeRADIUS restart can cover several routers.

## 10. Cutover: tunnel only

**Per router**, after a clean week on the tunnel with the card showing **Up**:
on the router, `/radius print`, then remove the entry whose address is the
server's **public** IP. The tunnel entry's address is `10.250.0.1`; leave that
one. From then on the router has no fallback. A dead tunnel shows as **Down**
on the card within about three minutes.

**When every router is on the tunnel:**

1. Confirm nothing still arrives on the public side:
   `sudo tcpdump -ni any udp port 1812 and not net 10.250.0.0/24` should stay quiet.
2. Remove the `0.0.0.0/0` catch-all from `/etc/freeradius/3.0/clients.conf`.
3. Delete the public-IP `nas` rows. Look first:
   `SELECT id, nasname, shortname FROM nas WHERE nasname NOT LIKE '10.250.0.%';`.
   Keep any you still use from the box itself (`ispman.online` / `testweb`).
4. `sudo freeradius -C && sudo systemctl restart freeradius`
5. In the security group, remove inbound UDP 1812/1813. Keep 51820.

## 11. A router on RouterOS 6

Check with `/system resource print` and look at `version:`. RouterOS 6 has no
WireGuard.

To upgrade, off-peak, with someone on site:

```
/system backup save name=pre-v7
/export file=pre-v7
# Download both files off the router before going on.
/system package update set channel=long-term
/system package update check-for-updates
/system package update install
# Reboots onto the last 6.49.x. Then:
/system package update set channel=upgrade
/system package update check-for-updates
/system package update install
# Reboots onto RouterOS 7.
```

- **Space:** check `free-hdd-space` first; small-flash models can be tight.
- **Multi-WAN setups need checking afterwards.** Load-balancing with routing
  marks is what most often needs fixing after the jump. In 7, a routing mark
  needs a `/routing table add name=... fib`. Check routes and mangle rules
  before leaving site.
- **If it can't go to 7,** it stays on the public path until it is replaced.
  There is deliberately no second VPN type on the server for it.

## 12. If a tunnel drops

**One router, one company.** Once the router is cut over:

- New devices and reconnects get no answer.
- Renewals that ask RADIUS fail, so customers drop off over about one lease
  period (the pilot test in section 8 shows exactly how).
- Accounting stops, so "last seen" and online status in ISPMan go stale.
- Other companies, and ISPMan itself, are unaffected.

Before cutover, the router simply falls back to its public entry.

**Every tunnel at once** means the box, UDP 51820, or the Elastic IP is gone.
That takes the public RADIUS path down too.

**Finding it:** the card says **Down**, and `sudo wg show wg-routers` shows an
old handshake. Usual causes:

- **The router's clock is wrong.** NTP off after a reboot; WireGuard rejects
  the handshake until the clock is right.
- **The router can't reach the endpoint.**
- **The router was reset and made a new key.** Use **Replace key**: same
  address, same `nas` row, only the peer changes.
- **`wg-ispman` is disabled.**

## Rollback

`sudo systemctl disable --now wg-quick@wg-routers`. Until cutover, every router
still has its public entry and falls back to it. On a router, the card's
**Revoke** shows the block that removes the tunnel config.
