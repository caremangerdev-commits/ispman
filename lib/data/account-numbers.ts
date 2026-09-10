import 'server-only'

import { formatAccountNumber, normalisePrefix } from '@/lib/account-number'
import { getSchemaCapabilities } from '@/lib/schema'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * Issuing account numbers.
 *
 * The number itself is spelled by lib/account-number.ts; this decides WHICH
 * number, which is the part that has to be right under concurrency.
 */

/**
 * The company's prefix, or null. Read separately from the rest of settings
 * because the allocator needs only this one field and runs on the signup path.
 */
async function prefixFor(companyId: number): Promise<string | null> {
  const { data } = await tenantClient()
    .from('settings')
    .select('account_number_prefix')
    .eq('company_id', companyId)
    .maybeSingle()

  return normalisePrefix(
    (data as { account_number_prefix: string | null } | null)?.account_number_prefix
  )
}

/**
 * Takes the next account number for a company.
 *
 * Concurrency-safe by compare-and-swap — see bumpCounter. A plain read-then-
 * write has a window in which two signups see the same value, and the failure
 * mode is two customers holding one account number in front of two operators.
 *
 * Returns null when 0020 has not been applied, or when the counter row is
 * missing for this company. NULL IS A LEGITIMATE RESULT, not an error to throw:
 * the column is nullable precisely so that a customer is still created when the
 * number cannot be issued. A customer without an account number is visible and
 * fixable; a signup that fails at the counter is not.
 */
export async function allocateAccountNumber(companyId: number): Promise<string | null> {
  const caps = await getSchemaCapabilities()
  if (!caps.accountNumbers) return null

  const issued = await bumpCounter(companyId)
  if (issued === null) return null

  return formatAccountNumber(issued, await prefixFor(companyId))
}

/**
 * Increments the counter and returns the value that was taken.
 *
 * PostgREST has no way to write `next_value = next_value + 1`, so this reads
 * and writes — but the write is CONDITIONAL on the value that was read
 * (`.eq('next_value', current)`), which turns it into a compare-and-swap. A
 * second caller that raced in between updates nothing, sees zero rows affected,
 * and tries again with the value that actually won. That closes the window a
 * plain read-then-write leaves open, without needing a database function.
 *
 * Bounded retries: contention here is two signups in the same instant, not a
 * queue, so a handful of attempts is more than the situation can need. Giving
 * up returns null and the customer is created without a number rather than the
 * signup failing.
 */
async function bumpCounter(companyId: number, attempts = 5): Promise<number | null> {
  const db = tenantClient()

  for (let i = 0; i < attempts; i++) {
    const { data: row } = await db
      .from('account_counters')
      .select('next_value')
      .eq('company_id', companyId)
      .maybeSingle()

    const current = (row as { next_value: number } | null)?.next_value
    if (current === undefined || current === null) return null

    const { data: won } = await db
      .from('account_counters')
      .update({ next_value: current + 1, updated_at: new Date().toISOString() })
      .eq('company_id', companyId)
      // The compare half of the compare-and-swap.
      .eq('next_value', current)
      .select('company_id')
      .maybeSingle()

    if (won) return current
  }

  console.error(
    '[account-numbers] gave up allocating for company %d after %d attempts',
    companyId, attempts
  )
  return null
}

/**
 * Whether an account number is already taken in this company.
 *
 * For the importer, which accepts numbers a company brings with it and has to
 * reject a collision with a row already in the database rather than let the
 * unique index fail the whole batch.
 */
export async function accountNumbersInUse(
  companyId: number,
  numbers: string[]
): Promise<Set<string>> {
  const wanted = [...new Set(numbers.map((n) => n.trim()).filter(Boolean))]
  if (wanted.length === 0) return new Set()

  const { data } = await tenantClient()
    .from('customers')
    .select('account_number')
    .eq('company_id', companyId)
    .in('account_number', wanted)

  return new Set(
    ((data ?? []) as { account_number: string | null }[])
      .map((r) => r.account_number)
      .filter((n): n is string => Boolean(n))
  )
}
