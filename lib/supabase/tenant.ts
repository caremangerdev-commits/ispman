import { createAdminClient } from './admin'

/**
 * Server-side reader for tenant data.
 *
 * WHY THIS EXISTS: row level security is enabled on the application tables but
 * no policies are defined yet, so the `authenticated` role currently reads back
 * zero rows. Until `supabase/migrations/0001_rls_policies.sql` is applied, the
 * dashboard's server components read through the service role instead.
 *
 * THE RULES, while that is true:
 *   1. Only ever call this from server code that has already resolved a session
 *      via getSessionContext().
 *   2. Every query MUST filter on the company id from that session. There is no
 *      RLS backstop right now — an unfiltered query returns every tenant's rows.
 *   3. Never pass a company id that came from the client.
 *
 * Once the policies are applied, switch these reads back to the cookie-bound
 * client in `lib/supabase/server.ts` and delete this module; the queries
 * themselves need no changes because they are already scoped.
 */
export function tenantClient() {
  return createAdminClient()
}
