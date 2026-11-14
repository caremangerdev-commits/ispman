import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

import {
  externalHost, isKnownAppHost, isPortalHost, PORTAL_SLUG_HEADER, portalSlugFromHost,
} from '@/lib/portal/config'
import { supabaseAnonKey, supabaseUrl } from '@/lib/supabase/env'

/**
 * Path prefixes reachable without a session.
 *
 * `/api/sms/dispatch` is NOT public in any meaningful sense — it authenticates
 * itself with a shared secret, because the caller is a background worker with
 * no user and therefore no cookie. It has to be exempted HERE because this
 * proxy redirects anything unauthenticated to /login, and a 307 to a login page
 * is something `fetch` follows silently: the ticker would read the login HTML,
 * see a 200, find no JSON, and log nothing at all. It would appear to run
 * perfectly every minute while dispatching precisely nothing.
 *
 * Anything added to this list must do its own authorization. See the secret
 * check in app/api/sms/dispatch/route.ts.
 */
// The background routes carry their own shared-secret check; a session
// redirect would hand their callers the login page as a 200.
// /api/tunnels/peers also refuses anything that is not a loopback call.
const PUBLIC_PATHS = ['/login', '/auth', '/api/sms/dispatch', '/api/billing/tick', '/api/tunnels/peers']

/**
 * A payment gateway's webhook: /api/payments/{provider}/{company}/webhook.
 *
 * THE SAME TRAP THE SMS TICKER FELL INTO, and it cost a real payment to find.
 * A gateway POSTs here with no cookie, this proxy redirected it to /login, the
 * gateway's HTTP client followed the redirect and read a 200 — so Dime's
 * delivery log showed success, the route never ran, nothing was recorded, and
 * nothing was logged anywhere. A payment taken and silently dropped is the
 * worst shape this bug can have.
 *
 * MATCHED BY SUFFIX, NOT PREFIX, on purpose: /api/payments/export is a staff
 * route and must stay behind the session. Only the webhook leaf is exempt.
 *
 * It authorizes itself, as everything on this list must: the route verifies
 * the gateway's HMAC signature over the raw body against that company's stored
 * secret before it will act on a delivery, and answers 401 when it does not
 * verify (lib/payments/gateways).
 */
function isGatewayWebhook(pathname: string) {
  return pathname.startsWith('/api/payments/') && pathname.endsWith('/webhook')
}

function isPublicPath(pathname: string) {
  if (isGatewayWebhook(pathname)) return true
  return PUBLIC_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`)
  )
}

/**
 * Refreshes the Supabase session on every request and performs an optimistic
 * auth redirect.
 *
 * This is an *optimistic* check only. Next.js runs the proxy in front of the
 * app, so it must not be treated as the authorization boundary — pages and
 * route handlers that expose real data must re-verify with their own
 * `supabase.auth.getUser()` call.
 *
 * In Next.js 16 the `middleware` file convention was renamed to `proxy`.
 */
export async function proxy(request: NextRequest) {
  // The host the client actually asked for. Behind Apache the `Host` header can
  // be the upstream (127.0.0.1:3000), so this prefers X-Forwarded-Host — keying
  // on the raw Host is what let a post-OTP redirect be mis-read as a staff
  // request and bounced to /login.
  const host = externalHost(request.headers)

  // A tenant portal answers on its own subdomain and carries its own customer
  // auth, so it NEVER touches the staff Supabase flow below. The slug is
  // resolved from the host and stamped on the request for the portal layout to
  // read; a client-sent copy of that header is overwritten here, so it cannot
  // be forged.
  const portalSlug = portalSlugFromHost(host)
  if (portalSlug) {
    const url = request.nextUrl.clone()
    // Portal PAGES live under /portal, so a tenant subdomain's '/account' is
    // served by '/portal/account'. API routes (/api/portal/*) are NOT under
    // /portal — they must pass through at their real path, just with the slug
    // header attached, or the statement/photo endpoints 404.
    if (!url.pathname.startsWith('/portal') && !url.pathname.startsWith('/api/')) {
      url.pathname = url.pathname === '/' ? '/portal' : '/portal' + url.pathname
    }
    const headers = new Headers(request.headers)
    headers.set(PORTAL_SLUG_HEADER, portalSlug)
    return NextResponse.rewrite(url, { request: { headers } })
  }

  // A portal-domain host with no tenant slug — the apex, or an odd multi-level
  // subdomain — is STILL a portal host and must never reach staff auth. Send it
  // into the portal (it renders the portal's own not-found), and strip any
  // client-sent slug header so the apex cannot be made to impersonate a tenant.
  if (isPortalHost(host)) {
    const url = request.nextUrl.clone()
    if (!url.pathname.startsWith('/portal') && !url.pathname.startsWith('/api/')) {
      url.pathname = url.pathname === '/' ? '/portal' : '/portal' + url.pathname
    }
    const headers = new Headers(request.headers)
    headers.delete(PORTAL_SLUG_HEADER)
    return NextResponse.rewrite(url, { request: { headers } })
  }

  // A HOST THAT IS NOT OURS IS A SUSPENDED CUSTOMER, not a visitor.
  //
  // Their router rewrites their web traffic to this server, and the request
  // still asks for whatever they typed — so `Host: instagram.com` arriving here
  // means somebody's internet was cut off and their browser has been pointed at
  // us. See deploy/freeradius/suspended-router-setup.md.
  //
  // Without this they fall through to the staff app below, find no session, and
  // are redirected to /login — a customer whose internet is off being shown an
  // ISP's staff login screen, which explains nothing and invites them to try
  // passwords.
  //
  // Checked BEFORE the Supabase client is created, so a redirected customer
  // costs no auth round trip. Inert until APP_HOSTS is set.
  if (!isKnownAppHost(host)) {
    const url = request.nextUrl.clone()
    url.pathname = '/suspended'
    url.search = ''
    return NextResponse.rewrite(url)
  }

  // From here down is the STAFF app. A portal host can never reach it, and a
  // staff host (a different domain) never reaches the portal above.

  // Must be reassigned by setAll below so rotated auth cookies survive.
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(supabaseUrl(), supabaseAnonKey(), {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value)
        }
        supabaseResponse = NextResponse.next({ request })
        for (const { name, value, options } of cookiesToSet) {
          supabaseResponse.cookies.set(name, value, options)
        }
      },
    },
  })

  // Do not insert logic between creating the client and calling getUser().
  // getUser() revalidates the token with Supabase and triggers the cookie
  // refresh above; anything that returns early in between can drop the
  // refreshed session and log the user out at random.
  // [perf] TEMPORARY instrumentation
  const tProxy = Date.now()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  console.log('[perf] proxy.ts: auth.getUser (%s)  %dms', request.nextUrl.pathname, Date.now() - tProxy)

  const { pathname } = request.nextUrl

  if (!user && !isPublicPath(pathname)) {
    const redirectUrl = request.nextUrl.clone()
    redirectUrl.pathname = '/login'
    // Preserve where the user was heading so login can send them back.
    redirectUrl.searchParams.set('redirectTo', pathname)
    return copyAuthCookies(supabaseResponse, NextResponse.redirect(redirectUrl))
  }

  if (user && pathname === '/login') {
    const redirectUrl = request.nextUrl.clone()
    // Sent to `/`, not straight to a dashboard: where a user belongs depends on
    // their role (a cashier lands on the payment screen, a platform owner on
    // /superadmin), and the role is not in the auth session — it lives in the
    // `users` table. Resolving it here would mean a database round trip on
    // every request this proxy matches. The root page already has the session
    // loaded and routes by role via lib/home.ts#homePathFor.
    redirectUrl.pathname = '/'
    redirectUrl.search = ''
    return copyAuthCookies(supabaseResponse, NextResponse.redirect(redirectUrl))
  }

  return supabaseResponse
}

/**
 * Carries any refreshed auth cookies onto a redirect response.
 *
 * Returning a bare `NextResponse.redirect` would discard the rotated tokens
 * that Supabase just wrote onto `supabaseResponse`, causing a redirect loop.
 */
function copyAuthCookies(from: NextResponse, to: NextResponse) {
  for (const cookie of from.cookies.getAll()) {
    to.cookies.set(cookie)
  }
  return to
}

export const config = {
  matcher: [
    /*
     * Run on everything except static assets and image files, so auth
     * redirects never block CSS, JS or images from loading.
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
}
