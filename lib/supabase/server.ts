import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

import { supabaseAnonKey, supabaseUrl } from './env'

/**
 * Supabase client for use in Server Components, Server Actions and Route
 * Handlers.
 *
 * A new client is created per request because it is bound to that request's
 * cookie store — never hoist this into a module-level singleton.
 */
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(supabaseUrl(), supabaseAnonKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options)
          }
        } catch {
          // `setAll` throws when called from a Server Component, which cannot
          // write cookies. This is safe to ignore as long as proxy.ts is
          // refreshing the session — it writes the rotated cookies instead.
        }
      },
    },
  })
}
