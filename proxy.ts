import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

import { supabaseAnonKey, supabaseUrl } from '@/lib/supabase/env'

/** Path prefixes reachable without a session. */
const PUBLIC_PATHS = ['/login', '/auth']

function isPublicPath(pathname: string) {
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
