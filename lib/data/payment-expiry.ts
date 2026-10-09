import 'server-only'

import { logEvent } from '@/lib/audit'
import { localDateOnly } from '@/lib/format'
import { logField, readLogDetail } from '@/lib/log-detail'
import { getRadiusStatus, radiusConfigured, replaceExpiryInRadius } from '@/lib/radius-db'
import { parseRadiusExpiration, shiftExpirationMonths } from '@/lib/radius/format'
import { getSchemaCapabilities } from '@/lib/schema'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * TAKING BACK THE MONTHS A PAYMENT GAVE (owner, 9 Oct 2026).
 *
 *   DELETING a payment puts the expiry back: a deleted payment never happened.
 *   EDITING one down to fewer months takes the expiry back by the difference.
 *
 * Why: a payment's write to the expiry outlived the payment. A deletion left
 * the month in place and a re-entered payment counted forward from it (Janel
 * Dixion: one J$3,500, 10 Oct to 7 Dec); an amount typed as J$35,000 and
 * corrected to J$3,500 kept its six months (Patricia Salmon). Of 35 deletions,
 * staff had put the expiry back by hand 13 times; six customers were left
 * holding the month.
 *
 * WHAT HAPPENS, decided by a plan and carried out by applyExpiryUndo:
 *
 *   restore  (delete) RADIUS still holds exactly what this payment wrote: it
 *            goes back to what it was before the payment.
 *   shift    RADIUS holds what this payment wrote, or what a LATER payment
 *            wrote counting forward from it: that value comes back by the
 *            months being taken back (5 Dec -> 5 Nov), and the payment records
 *            whose stored expiry moves follow it.
 *   none     The payment did not move the expiry. Nothing to do.
 *   left     Anything else moved the expiry since (an Extend, a correction, a
 *            payment that did not count forward from this one), the payment
 *            granted a picked date rather than months, or the network cannot
 *            be read. NOTHING IS GUESSED: the expiry stays, and the screen and
 *            the log say what the payment had done, for a person.
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

/** A payment record whose stored expiry follows the move. */
type PaymentFollow = { id: number; before: string | null; after: string }

export type ExpiryUndo =
  | { kind: 'none'; message: string }
  | { kind: 'restore' | 'shift'; from: string; to: string; follow: PaymentFollow[]; message: string; laterPaymentId: number | null }
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

const plural = (n: number) => n + (n === 1 ? ' month' : ' months')

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

/**
 * The shared plan. `takeBack` is how many months to take back, or 'all' for a
 * deletion — which restores the exact earlier value when it can.
 */
async function plan(
  companyId: number,
  paymentId: number,
  identity: string | null,
  takeBack: number | 'all'
): Promise<ExpiryUndo> {
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

  const months = takeBack === 'all' ? payment.months_paid ?? 0 : takeBack
  // Months can only be taken back from a payment that bought months; a picked
  // date is a manager's decision and is not un-picked by arithmetic.
  const byMonths = months >= 1 && payment.access_decision !== 'date_selected'

  if (!identity) return { kind: 'left', current: null, message: did + ' The customer has no network identity now; check it by hand.' }
  if (!radiusConfigured()) return { kind: 'left', current: null, message: did + ' The network is not configured; check it by hand.' }
  const record = await getRadiusStatus(identity).catch(() => null)
  if (!record) return { kind: 'left', current: null, message: did + ' The network could not be read; check it by hand.' }
  const current = record.rawExpiry

  // --- Nothing has moved it since this payment -----------------------------
  if (current !== null && current === write.after) {
    if (takeBack === 'all') {
      if (!write.before) {
        return { kind: 'left', current, message: did + ' There was no expiry before it, so there is nothing to put back; check it by hand.' }
      }
      return {
        kind: 'restore', from: current, to: write.before, follow: [], laterPaymentId: null,
        message: 'Expiry goes back to ' + write.before + ', where it was before this payment.',
      }
    }
    const to = byMonths ? shiftExpirationMonths(current, -months) : null
    if (!to) return { kind: 'left', current, message: did + ' It cannot be taken back by months; check it by hand.' }
    return {
      kind: 'shift', from: current, to, laterPaymentId: null,
      follow: [{ id: payment.id, before: write.before, after: to }],
      message: 'Expiry comes back ' + plural(months) + ', to ' + to + '.',
    }
  }

  // --- A later payment counted forward from this one, and is what RADIUS holds
  if (payment.customer_id && current !== null && byMonths) {
    const { data: later, error: laterError } = await db.from('payments').select(await paymentColumns())
      .eq('company_id', companyId).eq('customer_id', payment.customer_id)
      .gt('created_at', payment.created_at).order('created_at')
    if (laterError) throw new Error('Could not read later payments: ' + laterError.message)
    for (const l of (later ?? []) as unknown as PaymentRow[]) {
      if (l.payment_kind === 'other') continue
      const lw = await paymentExpiryWrite(companyId, l)
      if (!lw || lw.before !== write.after) continue
      if (current !== lw.after) break
      const to = shiftExpirationMonths(current, -months)
      if (!to) break
      // A deletion's own row is gone; an edit's stays and its end moves back.
      const ownAfter = shiftExpirationMonths(write.after, -months)
      const follow: PaymentFollow[] = takeBack === 'all' || !ownAfter
        ? [{ id: l.id, before: write.before, after: to }]
        : [{ id: payment.id, before: write.before, after: ownAfter }, { id: l.id, before: ownAfter, after: to }]
      return {
        kind: 'shift', from: current, to, follow, laterPaymentId: l.id,
        message: 'Payment #' + l.id + ' counted forward from this one. Expiry comes back ' + plural(months) + ', to ' + to + '.',
      }
    }
  }

  return {
    kind: 'left', current,
    message: did + ' It has changed since (now ' + (current ?? 'none') + '), so it is left where it is; check it and correct it by hand.',
  }
}

/** What deleting this payment would do to the expiry. Reads only. */
export function planExpiryUndo(companyId: number, paymentId: number, identity: string | null): Promise<ExpiryUndo> {
  return plan(companyId, paymentId, identity, 'all')
}

/** What editing this payment down by `months` months would do to the expiry. Reads only. */
export function planMonthsTakeBack(companyId: number, paymentId: number, identity: string | null, months: number): Promise<ExpiryUndo> {
  if (!(months >= 1)) return Promise.resolve({ kind: 'none', message: 'No months are being taken back.' })
  return plan(companyId, paymentId, identity, months)
}

/**
 * Carries out a plan: the guarded write, the payment records that follow, and
 * a line on the customer's network history. Returns what actually happened.
 */
export async function applyExpiryUndo(opts: {
  plan: ExpiryUndo
  companyId: number
  customerId: number | null
  identity: string | null
  paymentId: number
  /** What was done to the payment, for the log: 'deleted', 'edited to 1 month'. */
  cause: string
  actorEmail: string
}): Promise<ExpiryUndo> {
  const { plan: p, companyId, customerId, identity, paymentId, cause, actorEmail } = opts
  if (p.kind !== 'restore' && p.kind !== 'shift') return p
  if (!identity) return { kind: 'left', current: null, message: 'No network identity; the expiry was not moved.' }

  const written = await replaceExpiryInRadius(identity, p.from, p.to).catch(() => false)
  if (!written) {
    return {
      kind: 'left', current: null,
      message: 'The expiry changed while this was being saved, so it was left; it was ' + p.from +
        ' and would have gone to ' + p.to + '. Check it by hand.',
    }
  }

  // The payment records whose stored expiry moved with it.
  if (p.follow.length) {
    const caps = await getSchemaCapabilities()
    const db = tenantClient()
    for (const f of p.follow) {
      const patch: Record<string, unknown> = {}
      const toDay = day(f.after)
      if (caps.paymentExpiry) { patch.expiry_before = f.before; patch.expiry_after = f.after }
      if (caps.billing && toDay) patch.access_granted_until = toDay
      if (caps.otherPayments && toDay) patch.service_active_until = toDay
      if (Object.keys(patch).length) {
        await db.from('payments').update(patch).eq('company_id', companyId).eq('id', f.id)
      }
    }
  }

  await logEvent({
    customerId: customerId ?? undefined,
    type: 'network_expiry_corrected',
    tag: '[payments]',
    details:
      'Expiry corrected for ' + identity + '. Expiry ' + (day(p.from) ?? p.from) + ' -> ' + (day(p.to) ?? p.to) +
      '. By ' + actorEmail + ' | reason=payment #' + paymentId + ' ' + cause + '; ' +
      (p.kind === 'restore'
        ? 'its month taken back'
        : p.laterPaymentId
          ? 'payment #' + p.laterPaymentId + ' had counted forward from it'
          : 'the months it no longer pays for taken back') +
      ' (was ' + p.from + ', now ' + p.to + ' RADIUS clock) | payment_id=' + paymentId,
  })
  return p
}

/** The `expiry_action` text for a payment_deleted / payment_updated log row. */
export function expiryActionText(done: ExpiryUndo, none: string): string {
  if (done.kind === 'restore') return 'restored ' + done.from + ' -> ' + done.to
  if (done.kind === 'shift') {
    return 'moved back ' + done.from + ' -> ' + done.to +
      (done.laterPaymentId ? ' (payment #' + done.laterPaymentId + ' had counted forward from it)' : '')
  }
  if (done.kind === 'none') return none
  return 'LEFT: ' + done.message
}
