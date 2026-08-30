import { createClient as createSupabaseClient } from '@supabase/supabase-js'

import type { LooseDatabase } from '@/lib/types'
import { supabaseUrl } from './env'

/**
 * Supabase client authenticated with the service role key.
 *
 * This client BYPASSES row level security. It must only ever be constructed on
 * the server (Route Handlers, Server Actions, background jobs) and its result
 * must never be returned to, or serialised into, the browser.
 *
 * Note the key is read from SUPABASE_SERVICE_ROLE_KEY — deliberately *not*
 * prefixed with NEXT_PUBLIC_, which would inline it into the client bundle.
 */
let cached: ReturnType<typeof createSupabaseClient<LooseDatabase>> | null = null

export function createAdminClient() {
  if (typeof window !== 'undefined') {
    throw new Error(
      'createAdminClient() was called in the browser. The service role key must never reach the client.'
    )
  }

  if (cached) return cached

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceRoleKey) {
    throw new Error(
      'Missing environment variable SUPABASE_SERVICE_ROLE_KEY. Add it to .env.local — see .env.example.'
    )
  }

  cached = createSupabaseClient<LooseDatabase>(supabaseUrl(), serviceRoleKey, {
    auth: {
      // The admin client is stateless: it must not read, persist or refresh
      // any user session, otherwise it can pick up a caller's tokens.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })

  return cached
}
