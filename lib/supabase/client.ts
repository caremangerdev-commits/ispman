import { createBrowserClient } from '@supabase/ssr'

import { supabaseAnonKey, supabaseUrl } from './env'

/**
 * Supabase client for use in Client Components (browser).
 *
 * `createBrowserClient` memoises internally, so calling this on every render
 * is safe and returns the same underlying client.
 */
export function createClient() {
  return createBrowserClient(supabaseUrl(), supabaseAnonKey())
}
