# Customer portal auth & host routing — how to verify

The portal and the staff app are one Next app on port 3000, told apart only by
the request host. `proxy.ts` must route a portal host to the portal and a staff
host to staff auth, and never cross them. These checks prove both paths.

## Invariants

1. A **portal host** (apex or any tenant subdomain under `PORTAL_HOST_SUFFIX`)
   is rewritten to `/portal` and never reaches staff auth (`/login`).
2. A **staff host** (any other domain) never rewrites to `/portal`.
3. An **unauthenticated portal request** renders the portal's own login form —
   never a redirect to `/login`.
4. The session cookie is scoped to the registrable portal domain, so it is read
   on the apex and on every tenant subdomain.

## Apache (the usual cause of a portal host being read as staff)

Behind Apache, `proxy.ts` keys on `X-Forwarded-Host` (which `mod_proxy_http`
sets to the original host), falling back to `Host`. Confirm the vhost that
proxies `*.pay.ispman.online` to port 3000 forwards the real host:

```
# either preserve the Host outright…
ProxyPreserveHost On
# …or rely on the X-Forwarded-Host mod_proxy_http adds by default.
```

If neither reaches the app, the proxy sees `Host: 127.0.0.1:3000`, treats the
request as staff, and bounces a signed-in customer to `/login`.

## Manual checks (curl, simulating Apache with headers)

Against a running server on :3000 (or :3100 in the examples below). `Host` is
the upstream Apache dials; `X-Forwarded-Host` is what the customer typed.

```bash
# 1. Tenant portal, even when Apache does NOT preserve Host — must rewrite to /portal.
curl -s -i -H 'Host: 127.0.0.1:3100' -H 'X-Forwarded-Host: wcnet.pay.ispman.online' \
  http://127.0.0.1:3100/ | grep -i 'x-middleware-rewrite\|HTTP/'
# expect: HTTP/1.1 200 (login form) or 404 (unknown slug) + x-middleware-rewrite: /portal
# must NOT be 307 -> /login

# 2. Portal apex, no tenant — still portal, never staff.
curl -s -i -H 'Host: pay.ispman.online' http://127.0.0.1:3100/ | grep -i 'x-middleware-rewrite\|location\|HTTP/'
# expect: x-middleware-rewrite: /portal ; must NOT be 307 -> /login

# 3. Staff host — must go to staff auth, never the portal.
curl -s -o /dev/null -w 'status=%{http_code} redirect=%{redirect_url}\n' \
  -H 'Host: app.ispman.online' http://127.0.0.1:3100/
# expect: status=307 redirect=.../login?redirectTo=%2F ; no x-middleware-rewrite

# 4. Cookie scope — after a real OTP sign-in, the session Set-Cookie must carry
#    Domain=pay.ispman.online (readable on the apex and all tenant subdomains).
#    Check the response of the verify step in the browser devtools, or:
#    grep -i 'set-cookie' on the sign-in response — expect Domain=pay.ispman.online.
```

## Browser end-to-end (needs migration 0035 applied + a company with SMS + a gateway)

Visit `https://<tenant>.pay.ispman.online`, sign in with a number on that
company's account, enter the texted code, and confirm it lands on the account
page (balance/expiry/history) — not `/login`. Then from the same browser visit
a second tenant subdomain and confirm it shows that tenant's login (the shared
cookie is rejected because its company does not match).
