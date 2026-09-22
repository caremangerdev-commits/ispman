import 'server-only'

import { batchGetRadiusStatus, radiusConfigured } from '@/lib/radius-db'
import { usernameKey } from '@/lib/radius/format'

export type ServiceState = 'active' | 'disconnected' | 'unprovisioned'

/**
 * Which of these customers had service at the moment this was called.
 *
 * ONE DEFINITION, two callers: Run Bills (app/actions/bulk.ts) and the daily
 * billing engine (lib/data/billing-engine.ts). It used to be private to the
 * bulk action; the engine needed the same rule and a second copy is how rules
 * drift in this codebase.
 *
 * SERVICE DELIVERED IS THE TEST FOR WHETHER A BILL IS OWED. A customer whose
 * access had expired when the run fired did not have the period they would be
 * charged for, so they are not charged for it.
 *
 * THE EXPIRY COMES FROM radcheck AND NOWHERE ELSE. Not last_billed_date, not
 * last_bill_date, not a cut-off day walked forward — those are billing records
 * and derived dates, and the whole point of this rule is to bill against what
 * the network actually did. radcheck is the only authority on that.
 *
 * NO GRACE PERIOD, DELIBERATELY. A customer cut off on the 5th whose run fires
 * on the 25th is disconnected and is skipped, even though they had service for
 * part of the period. Adding grace here would re-introduce the "charge them
 * anyway" behaviour this rule exists to remove; a part-month that should be
 * charged is a manual payment, not a bill run.
 *
 * A customer with no radcheck row at all — never provisioned, or no MAC and no
 * PPPoE username to look one up by — is reported separately. They are skipped
 * too: no row means no access, which means no service to bill for.
 *
 * THROWS IF THE REGISTRY CANNOT BE REACHED. Both fallbacks are wrong: billing
 * everybody charges customers who were cut off, and billing nobody silently
 * reports a run that did nothing. Neither is safe on a company's whole book, so
 * the caller refuses rather than guessing. `what` names the caller in the
 * message: 'the bill run', 'the billing engine'.
 */
export async function serviceStateFor(
  customers: { id: number; identity: string | null }[],
  what = 'the bill run'
): Promise<Map<number, ServiceState>> {
  const out = new Map<number, ServiceState>()
  if (customers.length === 0) return out

  if (!radiusConfigured()) {
    throw new Error(
      'The network registry is not configured, so ' + what + ' cannot tell which ' +
      'customers had service. Nothing was billed.'
    )
  }

  let registry
  try {
    registry = await batchGetRadiusStatus(customers.map((c) => c.identity))
  } catch (err) {
    throw new Error(
      'The network registry could not be read, so ' + what + ' cannot tell which ' +
      'customers had service. Nothing was billed. (' + (err as Error).message + ')'
    )
  }

  for (const customer of customers) {
    if (!customer.identity) {
      out.set(customer.id, 'unprovisioned')
      continue
    }

    // Keyed the way batchGetRadiusStatus normalises identities, not by the
    // spelling the customers row happens to hold.
    const record = registry.get(usernameKey(customer.identity))

    if (!record || !record.exists) {
      out.set(customer.id, 'unprovisioned')
      continue
    }

    // 'active' is the only state that means access has not expired.
    // 'expired' and 'inactive' are both an expiry in the past — they differ
    // only in how long ago, which this rule does not care about.
    out.set(customer.id, record.status === 'active' ? 'active' : 'disconnected')
  }

  return out
}
