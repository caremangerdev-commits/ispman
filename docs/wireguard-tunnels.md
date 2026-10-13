# Router tunnels — WireGuard between tenant routers and the RADIUS server

Run these yourself. Nothing in this repo touches the box. ISPMan writes `nas`
rows and prints router blocks; the root job installed in section 5 applies the
server side.

**Why.** Tenant routers sit on dynamic public IPs that change about daily. A
`nas` row keyed on a public IP goes stale the next time the address moves, and
the router falls onto the shared `0.0.0.0/0` catch-all: one client, one secret,
one set of runtime state for every router behind it. Each router now builds a
WireGuard tunnel to the server and sends RADIUS through it from a fixed inside
address with its own permanent `nas` row and secret.

**Decided (owner, 13 Oct 2026):**

- One peer per router, not per company.
- The router generates its own key; ISPMan only ever sees the public half.
- The public RADIUS path stays as a fallback during the move, then is closed:
  tunnel only.
- Company admins add and manage their own routers.
- The server side runs itself: a root job applies peers, and the RADIUS server
  looks new routers up on demand, so adding one needs no restart.
- The range is `10.250.0.0/16`, widened from `/24` before more addresses were
  handed out.

**The values** (defined once, in `lib/tunnels/wireguard.ts`; the root job keeps its
own copy of the range in `/etc/ispman/wg-sync.env` on purpose):

| | |
|---|---|
| Tunnel network | `10.250.0.0/16`. Server `10.250.0.1`; routers from `10.250.0.2` up, skipping each `.0` and `.255`; 65,023 addresses, never reused |
| Server interface | `wg-routers`, config `/etc/wireguard/wg-routers.conf`, UDP `51820` |
| Router interface | `wg-ispman`, listen port `13239`, keepalive `25s` |
| RADIUS inside the tunnel | `10.250.0.1:1812/1813`, sent from the router's tunnel address |
| Per company | at most 25 live routers and 100 addresses ever (company admins; the platform operator is not held to it) |

`10.250.0.0/16` overlaps nothing a tenant used in 90 days of radacct (10.5, 10.9,
10.10, 10.11, 10.30, 10.99, 100.100, 172.16, 172.30, 172.168, 192.168) and is not
the EC2 default VPC (172.31). The interface is `wg-routers`, not `wg0`, so it
cannot land on top of whatever gives WCN's router `10.99.99.110`.

**The three routers already set up** (`10.250.0.2`–`.4`) keep their addresses: a
router's address is a `/32` point-to-point link, so the prefix only changes on
the server (section 1).

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

# The box's own networks: 10.250.0.0/16 must not overlap any of them.
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

# The root job needs Python 3 (Ubuntu 20.04 ships 3.8).
python3 --version
```

---

## 1. WireGuard on the server

```sh
sudo apt install wireguard

# The server's key pair. The private key goes straight into a root-only file
# and is never printed; only the public key is ever copied anywhere.
sudo sh -c 'umask 077; wg genkey > /etc/wireguard/wg-routers.key; wg pubkey < /etc/wireguard/wg-routers.key > /etc/wireguard/wg-routers.pub'
sudo cat /etc/wireguard/wg-routers.pub     # PUBLIC key -> WG_SERVER_PUBLIC_KEY (section 6)
```

`/etc/wireguard/wg-routers.conf`:

```ini
# ISPMan router tunnels. Peers are NOT listed here: the root job
# (ispman-wg-sync) applies them from ISPMan, and puts the last good set back
# when the interface comes up. Values: lib/tunnels/wireguard.ts.
[Interface]
# /16: the whole tunnel network is on this interface, so a peer added live
# (which brings no route of its own) is reachable at once.
Address = 10.250.0.1/16
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

# Peers back at boot, from the job's record, without waiting for ISPMan.
# UNCOMMENT ONLY ONCE SECTION 5 IS INSTALLED: a PostUp command that does not
# exist makes wg-quick fail and take the interface down again.
# PostUp = /usr/local/sbin/ispman-wg-sync --restore
```

No `SaveConfig`: it would rewrite this file on shutdown.

```sh
sudo chmod 600 /etc/wireguard/wg-routers.conf
sudo systemctl enable --now wg-quick@wg-routers
sudo wg show wg-routers                         # listening port 51820
sudo iptables -S INPUT | grep wg-routers        # the three INPUT rules
sudo iptables -S FORWARD | grep wg-routers      # the two FORWARD drops
```

**Already running with `Address = 10.250.0.1/24`?** Change the address to `/16`
without dropping the pilot routers:

```sh
sudo ip addr add 10.250.0.1/16 dev wg-routers
sudo ip addr del 10.250.0.1/24 dev wg-routers
ip -4 addr show wg-routers                      # one address, 10.250.0.1/16
# and change the Address line in wg-routers.conf to 10.250.0.1/16
```

## 2. AWS security group

Inbound **UDP 51820 from 0.0.0.0/0**. Routers' addresses change, so it can't be
narrowed; WireGuard silently ignores anything without a valid key. Leave
1812/1813 open; they close at cutover (section 10).

Check the box has an **Elastic IP**. That address is in every router's config;
if it changed, every tunnel would break at once.

## 3. FreeRADIUS: listening on the tunnel

If section 0 showed `ipaddr = *` (`0.0.0.0:1812` or `*:1812` in `ss`), FreeRADIUS
already answers on `10.250.0.1`. Nothing to do.

If it is bound to a specific address, add `listen` sections for `10.250.0.1`
(auth and acct) beside the existing ones, **and** make FreeRADIUS start after
the tunnel. Otherwise, at boot, it fails to bind and every company loses RADIUS:

```sh
sudo systemctl edit freeradius
#   [Unit]
#   After=wg-quick@wg-routers.service
#   Wants=wg-quick@wg-routers.service
```

## 4. FreeRADIUS: routers looked up on demand

Without this, FreeRADIUS reads `nas` only when it starts, so every new router
needs a restart. With it, any address in `10.250.0.0/16` that has no client yet
is looked up in `nas` on its first request.

- **Each router is still its own client**, with its own secret; this is not the
  catch-all again.
- **A tunnel address with no `nas` row gets no answer.** It never falls through
  to `0.0.0.0/0`, because the longer match wins.
- **Revoked routers age out.** A router's lookup is redone every 10 minutes, so
  a revoked router's entry goes within 10 minutes even without a restart.

The two files are in `deploy/freeradius/`:

```sh
cd /path/to/ispman      # this repo, checked out on the box
sudo cp /etc/freeradius/3.0/clients.conf /etc/freeradius/3.0/clients.conf.before-tunnels
sudo install -o root -g freerad -m 640 deploy/freeradius/ispman-tunnel-clients /etc/freeradius/3.0/sites-available/
sudo ln -s ../sites-available/ispman-tunnel-clients /etc/freeradius/3.0/sites-enabled/ispman-tunnel-clients
sudo sh -c 'cat deploy/freeradius/clients-ispman-tunnels.conf >> /etc/freeradius/3.0/clients.conf'

sudo freeradius -C && sudo systemctl restart freeradius     # the check first; nothing restarts if it fails
```

**If the check fails,** run `sudo freeradius -XC | tail -30` to see why. To back
out:

```sh
sudo rm /etc/freeradius/3.0/sites-enabled/ispman-tunnel-clients
sudo cp /etc/freeradius/3.0/clients.conf.before-tunnels /etc/freeradius/3.0/clients.conf
```

This is the last FreeRADIUS restart a new router needs. The next router added
proves it: its card goes **Up** with no restart.

## 5. The root job: `ispman-wg-sync`

This replaces running the server block by hand.

**What it does, every 30 seconds:**

1. Asks ISPMan, on `127.0.0.1:3000`, for every live router with a key.
2. Checks every entry against its own copy of the range. One bad entry rejects
   the whole list.
3. Applies the list with `wg set`.
4. Writes the status files ISPMan reads.

ISPMan never runs anything as root. The job decides for itself what it will
accept.

**The mass-removal guard.** One revoke at a time is normal. More than
`MAX_REMOVALS_PER_RUN` (3) at once, or a list that would remove every peer, is
**held**: additions still go ahead, removals wait for a person. If ISPMan is
down, or answers with anything but a well-formed list, **nothing changes**. An
error is never treated as an empty list.

```sh
cd /path/to/ispman
sudo install -o root -g root -m 755 deploy/wireguard/ispman-wg-sync /usr/local/sbin/ispman-wg-sync
sudo install -d -o root -g root -m 755 /var/lib/ispman
sudo install -d -o root -g root -m 700 /etc/ispman
sudo install -o root -g root -m 600 deploy/wireguard/wg-sync.env.example /etc/ispman/wg-sync.env
openssl rand -hex 32        # the shared secret
sudo nano /etc/ispman/wg-sync.env           # paste it as TUNNEL_SYNC_SECRET
```

Set the same secret in ISPMan (section 6), restart ISPMan, then try a dry run:

```sh
sudo /usr/local/sbin/ispman-wg-sync --dry-run
```

It should list the routers that already have keys. The pilot's peers are
already on the interface, so expect `0 to add or update`. Then:

```sh
sudo install -o root -g root -m 644 deploy/wireguard/ispman-wg-sync.service /etc/systemd/system/
sudo install -o root -g root -m 644 deploy/wireguard/ispman-wg-sync.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ispman-wg-sync.timer
sudo systemctl start ispman-wg-sync.service && sudo journalctl -u ispman-wg-sync -n 20
ls -l /var/lib/ispman/                      # wg-handshakes, wg-peers.json, wg-sync.json
```

Then uncomment the `--restore` `PostUp` line in `wg-routers.conf` (section 1), so
peers come back at boot even before ISPMan is up. It takes effect the next time
the interface starts; nothing needs restarting now.

**Clean up from the hand-run setup:**

- **Remove any `[Peer]` blocks you appended to `wg-routers.conf`** for the pilot
  routers. The job owns the peer list now; a peer left in the file comes back on
  every restart, even after it is revoked.
- **Remove the old status cron:** `sudo rm -f /etc/cron.d/ispman-wg`. The job
  writes that file now.

**When removals are held:** the platform overview says so, and
`systemctl status ispman-wg-sync` shows the unit failed. Check the routers in
ISPMan. If they really are revoked:

```sh
sudo ispman-wg-sync --allow-removals N      # N = the number it reported
```

## 6. ISPMan

1. Migration `0033_router_tunnels.sql` is already applied.
2. ISPMan's database user can already write `nas` (the pilot rows prove it).
3. In ISPMan's `.env.local` on the box:

   ```
   WG_SERVER_PUBLIC_KEY=<contents of /etc/wireguard/wg-routers.pub>
   WG_SERVER_ENDPOINT=<the Elastic IP>
   WG_HANDSHAKES_FILE=/var/lib/ispman/wg-handshakes
   WG_SYNC_STATUS_FILE=/var/lib/ispman/wg-sync.json
   TUNNEL_SYNC_SECRET=<the same secret as /etc/ispman/wg-sync.env>
   ```

4. Restart ISPMan the way it is normally deployed.

**`TUNNEL_SYNC_SECRET` switches the server side to automatic.** Set it only once
sections 4 and 5 are installed. From then on, nobody is handed a server block,
and every message says the server picks the change up within a minute. Without
it, the platform operator gets server blocks to run by hand, and company admins
are told the operator does that half.

**Settings → Router Tunnels** is for company admins and the super admin. Nothing
a tenant sees names the RADIUS server's software.

**The platform overview** lists every live router tunnel that is not up, in every
company, with how the last sync went.

---

## 7. Adding a router

In **Settings → Router Tunnels**, inside the router's company:

1. **Add Router.** Give it a name and the services its RADIUS carries (DHCP for
   the tenants on this server today). It gets the next free address. A company
   admin is held to the per-company limits.
2. **Step 1, on the router.** It prints the RouterOS version (must start with 7,
   see section 11) and whether the NTP client is on. NTP must be `true`: after a
   reboot, WireGuard won't reconnect until the router's clock is right. Then it
   creates `wg-ispman` and prints the router's public key.
3. **Paste key**, then **Save key**. ISPMan writes the router's `nas` row with a
   fresh secret and shows step 2.
4. **Step 2, on the router.** It adds the peer, the tunnel address (which brings
   its own route), and a `/radius` entry for `10.250.0.1` moved to the top. **The
   existing public entry stays below it** as the fallback.

**On the server:**

- **Automatic mode:** the job adds the peer within 30 seconds, and the RADIUS
  server answers on the router's first request. The card goes from "Waiting for
  the server side" to **Up**.
- **Hand-run mode:** the platform operator also gets the server block.

Check it:

```sh
sudo wg show wg-routers                                   # the peer, its handshake, its current public IP
sudo tcpdump -ni wg-routers udp port 1812 or udp port 1813
```

**The RouterOS lines were written without a RouterOS 7 router to try them on.**
The pilot is where they are proven. If a line fails, fix it in
`lib/tunnels/wireguard.ts`, so every later router gets the fix.

## 8. The pilot

WCN's routers ("Wcnet Ccr1036" at `10.250.0.3`, "Wcnet rb5009" at `10.250.0.4`).
"DHCP - MAIN" had the worst churn of any router (about 80 public and CGNAT
addresses in 30 days) and runs several WANs, so if the tunnel holds there, it
holds anywhere.

Leave them at least three days, through at least one WAN address change and one
reboot. The card should stay **Up**, and `wg show` should show the endpoint
following the router's new address.

**Then test the fallback.** On a router run
`/interface wireguard disable wg-ispman` for 10 minutes:

- New leases should still be answered, through the public entry. Each one is
  slower, because the router waits 1s on the tunnel first.
- Watch what a client renewing in that window does.

Re-enable it with `/interface wireguard enable wg-ispman`.

**And the first router added after section 4 and 5 are in** proves the
automatic path: no server block, no restart, **Up** within a minute.

## 9. The rest

The three companies that went dark this week next, then everyone else, with
routers on static public IPs last (they work today). With the server automatic,
company admins can do their own routers.

## 10. Cutover: tunnel only

**Per router**, after a clean week on the tunnel with the card showing **Up**:
on the router, `/radius print`, then remove the entry whose address is the
server's **public** IP. The tunnel entry's address is `10.250.0.1`; leave that
one. From then on the router has no fallback, and a dead tunnel shows as **Down**
within about three minutes.

**When every router is on the tunnel:**

1. Confirm nothing still arrives on the public side:
   `sudo tcpdump -ni any udp port 1812 and not net 10.250.0.0/16` should stay quiet.
2. Remove the `0.0.0.0/0` catch-all from `/etc/freeradius/3.0/clients.conf`. Keep
   the `ispman-tunnels` block.
3. Delete the public-IP `nas` rows. Look first:
   `SELECT id, nasname, shortname FROM nas WHERE nasname NOT LIKE '10.250.%';`.
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

## 12. If a tunnel drops

**One router, one company.** Once the router is cut over:

- New devices and reconnects get no answer.
- Renewals that ask RADIUS fail, so customers drop off over about one lease
  period.
- Accounting stops, so "last seen" and online status in ISPMan go stale.
- Other companies, and ISPMan itself, are unaffected.

Before cutover, the router falls back to its public entry.

**Every tunnel at once** means the box, UDP 51820, or the Elastic IP is gone.
That takes the public RADIUS path down too.

**Finding it:** the card and the platform overview say **Down**. Usual causes:

- **The router's clock is wrong.** NTP off after a reboot; WireGuard rejects
  the handshake until the clock is right.
- **The router can't reach the endpoint.**
- **The router was reset and made a new key.** Use **Replace key**: same
  address, same `nas` row; the job swaps the peer.
- **`wg-ispman` is disabled.**
- **The sync job itself.** The overview shows its last run; also check
  `journalctl -u ispman-wg-sync -n 50`.

## Rollback

- **Job:** `sudo systemctl disable --now ispman-wg-sync.timer`, and unset
  `TUNNEL_SYNC_SECRET` in ISPMan, which brings back the hand-run server blocks.
- **On-demand clients:** see section 4.
- **The tunnel:** `sudo systemctl disable --now wg-quick@wg-routers`. Until
  cutover, every router still has its public entry and falls back to it.
