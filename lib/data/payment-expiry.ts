import 'server-only'

import { logEvent } from '@/lib/audit'
import { localDateOnly } from '@/lib/format'
import { logField, readLogDetail } from '@/lib/log-detail'
import { getRadiusStatus, radiusConfigured, replaceExpiryInRadius } from '@/lib/radius-db'
import { parseRadiusExpiration, shiftExpirationMonths } from '@/lib/radius/format'
import { getSchemaCapabilities } from '@/lib/schema'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * DELETING A PAYMENT PUTS THE EXPIRY BACK (owner, 9 Oct 2026).
 *
 * A deleted payment never happened. The balance already went back; the expiry
 * did not, and that left a month nobody paid for — and a payment re-entered
 * afterwards counted forward from it (Janel Dixion: one J$3,500, 10 Oct to
 * 7 Dec). Of 35 deletions, staff had put the expiry back by hand 13 times; six
 * customers were left holding the month.
 *
 * WHAT HAPPENS, decided by planExpiryUndo and carried out by applyExpiryUndo:
 *
 *   restore  RADIUS still holds exactly what this payment wrote: it goes back
 *            to what it was before the payment.
 *   shift    A later payment counted forward from this one, and its value is
 *            what RADIUS holds: that value comes back by this payment's months
 *            (5 Dec -> 5 Nov), and the later payment's record follows.
 *   none     This payment did not move the expiry. Nothing to do.
 *   left     Anything else moved the expiry since (an Extend, a correction, a
 *            payment that did not count forward from this one), or the network
 *            cannot be read. NOTHING IS GUESSED: the expiry stays, and the
 *            screen and the log say what this payment had done, for a person.
 *
 * EVERY WRITE IS GUARDED by the value read (lib/radius-db.ts
 * #replaceExpiryInRadius): if it changed between the plan and the write, it
 * becomes `left`.
 *
 * WHERE A PAYMENT'S WRITE IS FOUND: its own expiry_before / expiry_after
 * (migration 0031) for payments taken since; before that, the radius_extend
 * row the till logged when it took the payment.
 */

export type ExpiryWrite = { before: string | null; after: string }

export type ExpiryUndo =
  | { kind: 'none'; message: string }
  | { kind: 'restore'; from: string; to: string; message: string }
  | { kind: 'shift'; from: string; to: string; months: number; laterPaymentId: number; laterBefore: string | null; message: string }
  | { kind: 'left'; current: string | null; message: string }

type PaymentRow = {
  id: number
  customer_id: number | null
  created_at: string
  months_paid: number | null
  access_decision?: string | null
  expiry_before?: string | null
  expiry_after?: string | null
  payment_kind?: string | null
}

const day = (raw: string | null) => {
  const d = parseRadiusExpiration(raw)
  return d ? localDateOnly(d) : null
}

async function paymentColumns(): Promise<string> {
  const caps = await getSchemaCapabilities()
  return 'id, customer_id, created_at, months_paid' +
    (caps.billing ? ', access_decision' : '') +
    (caps.otherPayments ? ', payment_kind' : '') +
    (caps.paymentExpiry ? ', expiry_before, expiry_after' : '')
}

/**
 * What one payment's till write did to the expiry, or null if it moved nothing.
 */
export async function paymentExpiryWrite(companyId: number, payment: PaymentRow): Promise<ExpiryWrite | null> {
  if (payment.expiry_after) return { before: payment.expiry_before ?? null, after: payment.expiry_after }
  if (!payment.customer_id) return null

  // Before 0031: the radius_extend row the till wrote for it. Named by
  // payment_id since 9 Oct 2026; before that, the first one written after the
  // payment row — the till inserts the row, THEN writes the network, so a
  // row logged before it belongs to an earlier payment.
  const db = tenantClient()
  const from = payment.created_at
  const to = new Date(new Date(payment.created_at).getTime() + 120_000).toISOString()
  const { data, error } = await db
    .from('log')
    .select('created_at, details')
    .eq('company_id', companyId)
    .eq('customer_id', payment.customer_id)
    .eq('type', 'radius_extend')
    .gte('created_at', from)
    .lte('created_at', to)
    .order('created_at')
  if (error) throw new Error('Could not read the network log for payment #' + payment.id + ': ' + error.message)

  const rows = ((data ?? []) as { details: string | null }[]).map((r) => readLogDetail(r.details).body)
  const named = rows.find((b) => logField(b, 'payment_id') === String(payment.id))
  const body = named ?? rows.find((b) => logField(b, 'payment_id') === null && /bill period/.test(b))
  if (!body) return null
  const after = logField(body, 'new_expiry')
  if (!after) return null
  const before = logField(body, 'old_expiry')
  return { before: before && before !== 'none' ? before : null, after }
}

/** What deleting this payment would do to the expiry. Reads only. */
export async function planExpiryUndo(companyId: number, paymentId: number, identity: string | null): Promise<ExpiryUndo> {
  const db = tenantClient()
  const { data, error } = await db.from('payments').select(await paymentColumns())
    .eq('company_id', companyId).eq('id', paymentId).maybeSingle()
  if (error) throw new Error('Could not read the payment: ' + error.message)
  const payment = data as unknown as PaymentRow | null
  if (!payment || payment.payment_kind === 'other') {
    return { kind: 'none', message: 'This payment did not move the expiry.' }
  }

  const write = await paymentExpiryWrite(companyId, payment)
  if (!write) return { kind: 'none', message: 'This payment did not move the expiry.' }
  const did = 'This payment moved the expiry ' + (write.before ?? 'from none') + ' -> ' + write.after + '.'

  if (!identity) return { kind: 'left', current: null, message: did + ' The customer has no network identity now; check it by hand.' }
  if (!radiusConfigured()) return { kind: 'left', current: null, message: did + ' The network is not configured; check it by hand.' }
  const record = await getRadiusStatus(identity).catch(() => null)
  if (!record) return { kind: 'left', current: null, message: did + ' The network could not be read; check it by hand.' }
  const current = record.rawExpiry

  if (current === write.after) {
    if (!write.before) {
      return { kind: 'left', current, message: did + ' There was no expiry before it, so there is nothing to put back; check it by hand.' }
    }
    return { kind: 'restore', from: current, to: write.before, message: 'Expiry goes back to ' + write.before + ', where it was before this payment.' }
  }

  // A later payment that counted forward from this one, and is what RADIUS holds.
  if (!payment.customer_id) {
    return { kind: 'left', current, message: did + ' It has changed since (now ' + (current ?? 'none') + '); check it by hand.' }
  }
  const { data: later, error: laterError } = await db.from('payments').select(await paymentColumns())
    .eq('company_id', companyId).eq('customer_id', payment.customer_id)
    .gt('created_at', payment.created_at).order('created_at')
  if (laterError) throw new Error('Could not read later payments: ' + laterError.message)
  for (const l of (later ?? []) as unknown as PaymentRow[]) {
    if (l.payment_kind === 'other') continue
    const lw = await paymentExpiryWrite(companyId, l)
    if (!lw || lw.before !== write.after) continue
    const months = payment.months_paid ?? 0
    const to = months >= 1 && payment.access_decision !== 'date_selected' && current === lw.after
      ? shiftExpirationMonths(current, -months)
      : null
    if (to && current) {
      return {
        kind: 'shift', from: current, to, months, laterPaymentId: l.id, laterBefore: write.before,
        message: 'Payment #' + l.id + ' counted forward from this one. Expiry comes back ' + months +
          (months === 1 ? ' month' : ' months') + ', to ' + to + '.',
      }
    }
    break
  }

  return {
    kind: 'left', current,
    message: did + ' It has changed since (now ' + (current ?? 'none') + '), so it is left where it is; check it and correct it by hand.',
  }
}

/**
 * Carries out a plan, after the payment row is gone. Guarded write; logs the
 * move on the customer's network history. Returns what actually happened.
 */
export async function applyExpiryUndo(opts: {
  plan: ExpiryUndo
  companyId: number
  customerId: number | null
  identity: string | null
  paymentId: number
  actorEmail: string
}): Promise<ExpiryUndo> {
  const { plan, companyId, customerId, identity, paymentId, actorEmail } = opts
  if (plan.kind !== 'restore' && plan.kind !== 'shift') return plan
  if (!identity) return { kind: 'left', current: null, message: 'No network identity; the expiry was not moved.' }

  const written = await replaceExpiryInRadius(identity, plan.from, plan.to).catch(() => false)
  if (!written) {
    return {
      kind: 'left', current: null,
      message: 'The expiry changed while the payment was being deleted, so it was left; it was ' + plan.from +
        ' and would have gone to ' + plan.to + '. Check it by hand.',
    }
  }

  if (plan.kind === 'shift') {
    // The later payment's record follows its expiry.
    const caps = await getSchemaCapabilities()
    const patch: Record<string, unknown> = {}
    const toDay = day(plan.to)
    if (caps.paymentExpiry) { patch.expiry_before = plan.laterBefore; patch.expiry_after = plan.to }
    if (caps.billing && toDay) patch.access_granted_until = toDay
    if (caps.otherPayments && toDay) patch.service_active_until = toDay
    if (Object.keys(patch).length) {
      await tenantClient().from('payments').update(patch).eq('company_id', companyId).eq('id', plan.laterPaymentId)
    }
  }

  await logEvent({
    customerId: customerId ?? undefined,
    type: 'network_expiry_corrected',
    tag: '[payments]',
    details:
      'Expiry corrected for ' + identity + '. Expiry ' + (day(plan.from) ?? plan.from) + ' -> ' + (day(plan.to) ?? plan.to) +
      '. By ' + actorEmail + ' | reason=payment #' + paymentId + ' deleted; ' +
      (plan.kind === 'restore'
        ? 'its month taken back'
        : 'payment #' + plan.laterPaymentId + ' had counted forward from it') +
      ' (was ' + plan.from + ', now ' + plan.to + ' RADIUS clock) | payment_id=' + paymentId,
  })
  return plan
}
