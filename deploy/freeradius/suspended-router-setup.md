# What a router needs, to show suspended customers a notice page

This is the template for the per-router block the app will generate. It was
worked out and applied by hand on West Central Networks' CCR1036 on
11 November 2026; everything below is what actually went onto that router,
with the values that have to change per router marked.

A TENANT MUST NEVER SEE THIS FILE. The point of writing it down is that the
app generates these lines for each router, with that router's own values
already filled in and a copy button per step — the same shape as the WireGuard
tunnel flow in `lib/tunnels/wireguard.ts`. A tenant will never give us access
to their router, so nothing in the design may assume we have any.

## What has to be decided per router

| Value | On the 1036 | Where it comes from |
|---|---|---|
| Suspended range | `10.99.3.0/24` | `10.99.<last octet of the tunnel address>.0/24`, allocated by the app |
| Pool name | `SUSPENDED` | fixed |
| Customer bridge | `bridge` | the interface the router's DHCP server already serves |
| Portal address | `3.148.32.39` | the ISPMan server |
| Gateway hosts | `fygaro.com`, `www.fygaro.com` | the tenant's configured payment gateway |

CHECK THE RANGE IS FREE RATHER THAN ASSUMING. `10.99.x` looked unused when
measured against radacct, which only holds addresses handed to customers — the
1036 turned out to have `10.99.99.110/24` on a WAN interface. `10.99.3.0/24`
was clear, but the check belongs in the allocator, against
`/ip address print` and `/ip pool print` on the router itself.

## The block

```
/ip pool add name=SUSPENDED ranges=10.99.3.10-10.99.3.254

/ip address add address=10.99.3.1/24 interface=bridge comment="ISPMan suspended"

/ip dhcp-server network add address=10.99.3.0/24 gateway=10.99.3.1 \
    dns-server=10.99.3.1 comment="ISPMan suspended"

/ip firewall address-list add list=ISPMAN-ALLOW address=3.148.32.39 comment="ISPMan notice page"
/ip firewall address-list add list=ISPMAN-ALLOW address=fygaro.com comment="payment gateway"
/ip firewall address-list add list=ISPMAN-ALLOW address=www.fygaro.com comment="payment gateway"

/ip firewall nat add chain=dstnat src-address=10.99.3.0/24 protocol=tcp \
    dst-port=80 action=dst-nat to-addresses=3.148.32.39 to-ports=80 \
    comment="ISPMan: suspended -> notice page"

/ip firewall filter add chain=forward src-address=10.99.3.0/24 \
    dst-address-list=ISPMAN-ALLOW action=accept place-before=1 \
    comment="ISPMan: suspended may reach the portal"
/ip firewall filter add chain=forward src-address=10.99.3.0/24 action=drop \
    place-before=2 comment="ISPMan: suspended may reach nothing else"
```

## Why each line

**The pool** is what FreeRADIUS names in `Framed-Pool` for an expired customer
(see `ispman-walled-garden`). RouterOS's DHCP server honours it and it
overrides the server's own pool, so one DHCP server hands out ordinary
addresses and suspended ones depending only on what RADIUS says. `use-radius`
must already be `yes` on that DHCP server — it is, wherever ISPMan is
authenticating customers at all.

**The router's own address in the range** and **the DHCP network entry** exist
because an address without a gateway is not a working connection. DNS points
at the router, exactly as the main pool does, so a suspended customer resolves
names normally — which is what makes the redirect below work.

**The allow list** is a `dst-address-list`, with the gateway given as a
hostname. RouterOS resolves it and keeps it current: adding `fygaro.com`
produced `52.3.19.80` and `98.86.95.97` on its own. That matters because a
payment page's addresses are not ours to track.

**The redirect** is plain `dst-nat` on port 80. No DNS trickery: the customer
resolves a real address, connects to port 80, and the router rewrites the
destination. Splynx's newer answer is DNS-based because they must also serve
non-MikroTik routers; we do not, and `dst-nat` is simpler and needs no
resolver of our own.

**The accept and the drop** are a pair and belong next to each other. On the
1036 the drop ended up one position lower than intended, which is harmless —
nothing between them matches `10.99.3.0/24` — but the generated version should
place them adjacent.

## What this does NOT do

**HTTPS shows an error, not the page.** Only port 80 is redirected; 443 to
anything but the allow list is dropped. A customer who opens a site that is
HTTPS-only sees a connection failure. Everyone ships this limitation —
UISP says so in as many words. What rescues it is captive-portal detection:
Android and iOS probe a plain-HTTP URL, that probe gets redirected, and the
phone raises its "sign in to network" prompt.

**The page cannot tell who is looking at it.** The customer's traffic is
masqueraded out of the WAN like everyone else's, so the portal sees the
router's public address. Identifying them needs their real address to arrive,
which means routing this traffic over the WireGuard tunnel instead — and the
tunnel is currently locked to RADIUS and ping at the server end. That is a
later, separate decision; the first version asks the customer to sign in with
their phone number, which is login they already have.

## Still required before any of this does anything

1. The notice page, answering on port 80 for ANY `Host` header — a request
   redirected from `instagram.com` arrives asking for instagram.com. Apache
   currently redirects port 80 to 443, which would send the customer to
   `https://instagram.com` and fail.
2. A row in `ispman_walled_garden` for `10.250.0.3` with pool `SUSPENDED`.
   Until then no customer is ever put in this pool and every line above is
   dormant.
