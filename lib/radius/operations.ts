import 'server-only'

import {
  activateInRadius,
  disconnectInRadius,
  extendInRadius,
  getRadiusStatus as readRadcheck,
  radiusConfigured,
} from '@/lib/radius-db'
import { addMonths, firstExpiry, nextCutOff } from '@/lib/expiry'
import { formatRadiusExpiration, parseRadiusExpiration } from '@/lib/radius/format'
import type { NetworkEventType } from '@/lib/status'

/**
 * The single gateway for every write to the live FreeRADIUS database.
 *
 * All of the safety rules live here rather than being repeated in each server
 * action:
 *
 *   1. The current radcheck state is ALWAYS read before writing, so the audit
 *      trail records what the expiry actually was, not what we assumed.
 *   2. Every write is wrapped, and a failure returns a structured error rather
 *      than throwing — callers must not touch Supabase unless `ok` is true.
 *   3. The result carries old and new expiry so the caller can write a complete
 *      log row.
 *
 * The radcheck table on this NAS gates internet access for thousands of live
 * subscribers. Nothing here should be made to swallow an error quietly.
 */

/**
 * The four network actions, matching the buttons on the customer record.
 *
 * They map onto three radcheck writes: provision creates both rows from
 * scratch, reconnect and extend move the Expiration forward through the
 * backwards-write guard, and disconnect is the one operation that deliberately
 * moves it back — which is why it has its own function rather than a flag on
 * extendInRadius. See lib/radius-db.ts#disconnectInRadius.
 */
export type RadiusAction = 'provision' | 'reconnect' | 'extend' | 'disconnect'

/** The `log` row type each action writes once the radcheck write has landed. */
export const ACTION_EVENT_TYPE: Record<RadiusAction, NetworkEventType> = {
  provision: 'network_provision',
  reconnect: 'network_reconnect',
  extend: 'network_extend',
  disconnect: 'network_disconnect',
}

export type RadiusWriteResult =
  | {
      ok: true
      /** Expiration value before this write, or null if it had no row. */
      oldExpiry: string | null
      /** Expiration value now stored. */
      newExpiry: string
      /** False when the identity had no radcheck rows before this write. */
      existedBefore: boolean
      /** True when RADIUS is unconfigured and the write was skipped. */
      skipped: boolean
    }
  | { ok: false; error: string; code: string | null; oldExpiry: string | null }

/**
 * Applies one RADIUS change for an identity (MAC or PPPoE username).
 *
 * `expiry` is required for provision, reconnect and extend, and ignored for
 * disconnect, which always writes the current moment.
 */
export async function applyRadiusWrite(
  action: RadiusAction,
  identity: string,
  expiry?: Date
): Promise<RadiusWriteResult> {
  if (!radiusConfigured()) {
    // Not an error: the app must stay usable without a NAS. The caller decides
    // whether to proceed, and says so in its log entry.
    const target = action === 'disconnect' ? new Date() : (expiry ?? new Date())
    return {
      ok: true,
      oldExpiry: null,
      newExpiry: formatRadiusExpiration(target),
      existedBefore: false,
      skipped: true,
    }
  }

  // --- 1. Read current state before touching anything ---------------------
  let oldExpiry: string | null = null
  let existedBefore = false

  try {
    const before = await readRadcheck(identity)
    oldExpiry = before.rawExpiry
    existedBefore = before.exists
  } catch (err) {
    const e = err as { code?: string; sqlMessage?: string; message?: string }
    return {
      ok: false,
      code: e.code ?? null,
      error:
        'Could not read the current RADIUS state for ' + identity + ': ' +
        (e.sqlMessage ?? e.message ?? 'unknown error'),
      oldExpiry: null,
    }
  }

  // --- 2. Write -----------------------------------------------------------
  const target = action === 'disconnect' ? new Date() : expiry
  if (!target) {
    return {
      ok: false,
      code: null,
      error: 'No expiry date was supplied for a ' + action + ' operation.',
      oldExpiry,
    }
  }
  const newExpiry = formatRadiusExpiration(target)

  try {
    if (action === 'provision') await activateInRadius(identity, newExpiry)
    else if (action === 'disconnect') await disconnectInRadius(identity)
    // reconnect and extend are the same write — an absolute Expiration moved
    // forward — and both go through the backwards-write guard.
    else await extendInRadius(identity, newExpiry)
  } catch (err) {
    const e = err as { code?: string; sqlMessage?: string; message?: string }
    return {
      ok: false,
      code: e.code ?? null,
      error:
        'RADIUS ' + action + ' failed for ' + identity +
        ' (' + (e.code ?? 'error') + '): ' +
        (e.sqlMessage ?? e.message ?? 'unknown error'),
      oldExpiry,
    }
  }

  return { ok: true, oldExpiry, newExpiry, existedBefore, skipped: false }
}

/**
 * A radcheck Expiration value ("05 Sep 2026 23:06") as a plain date.
 *
 * The log is read by people, and the time of day on an expiry is noise: every
 * expiry this app writes is either midnight or the moment of a disconnect.
 */
function isoDay(value: string | null): string {
  const parsed = parseRadiusExpiration(value)
  if (!parsed) return value ?? 'none'

  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    parsed.getFullYear() + '-' + pad(parsed.getMonth() + 1) + '-' + pad(parsed.getDate())
  )
}

/**
 * The `details` string for a network event's log row.
 *
 * Written for a person reading the customer's Network History card, not for a
 * parser: the identity, the expiry transition and the operator, in a sentence.
 * The old expiry is included on every action except provision, where there was
 * nothing before it.
 *
 * The log table stamps its own created_at, which is the timestamp of record.
 */
export function networkEventDetails(opts: {
  action: RadiusAction
  identity: string
  oldExpiry: string | null
  newExpiry: string
  actor: string
  skipped: boolean
}): string {
  const { action, identity, oldExpiry, newExpiry, actor, skipped } = opts

  const verb =
    action === 'provision' ? 'Provisioned'
      : action === 'reconnect' ? 'Reconnected'
        : action === 'extend' ? 'Extended'
          : 'Disconnected'

  const change =
    action === 'provision'
      ? ', expiry ' + isoDay(newExpiry)
      : '. Expiry ' + isoDay(oldExpiry) + ' -> ' + isoDay(newExpiry)

  return (
    verb + ' ' + identity + change +
    '. By ' + actor +
    (skipped ? ' (network not configured — nothing was written)' : '')
  )
}

/**
 * The `details` string for a RADIUS write that FAILED.
 *
 * Deliberately a different shape from networkEventDetails, and logged under a
 * `radius_*_failed` type rather than a `network_*` one: a disconnect that never
 * reached the NAS must not make the customer read as disconnected.
 */
export function networkFailureDetails(opts: {
  action: RadiusAction
  identity: string
  oldExpiry: string | null
  actor: string
  error: string
}): string {
  const { action, identity, oldExpiry, actor, error } = opts
  return (
    'RADIUS ' + action + ' FAILED | identity=' + identity +
    ' | old_expiry=' + (oldExpiry ?? 'none') +
    ' | by=' + actor + ' | ' + error
  )
}

/**
 * The `details` string for the audit log row.
 *
 * Deliberately records the identity, both expiry values and the operator, so
 * a radcheck row can always be traced back to who moved it and from what.
 *
 * Kept for the payment-driven extend in app/actions/payments.ts, which logs a
 * `radius_extend` row rather than one of the four network events. The customer
 * buttons use networkEventDetails.
 */
export function radiusLogDetails(opts: {
  action: RadiusAction
  identity: string
  oldExpiry: string | null
  newExpiry: string
  actor: string
  skipped: boolean
  note?: string
}): string {
  const { action, identity, oldExpiry, newExpiry, actor, skipped, note } = opts
  return (
    'RADIUS ' + action + ' | identity=' + identity +
    ' | old_expiry=' + (oldExpiry ?? 'none') +
    ' | new_expiry=' + newExpiry +
    ' | by=' + actor +
    (skipped ? ' | SKIPPED (RADIUS not configured)' : '') +
    (note ? ' | ' + note : '')
  )
}

/**
 * Expiry for a FIRST-TIME provision — the 21-day rule.
 *
 * A thin server-side wrapper over lib/expiry.ts#firstExpiry. The next cut-off
 * day only counts as the first period if it is at least 21 days away; closer
 * than that and the customer runs to the occurrence after it, so nobody buys a
 * month and gets four days of it.
 *
 * Provisioning only. Reconnect uses reconnectExpiry, which is the plain next
 * cut-off day — the 21-day allowance is a one-off for the first period.
 */
export function provisionExpiry(cutOffDate: number | null, from: Date = new Date()): Date {
  return firstExpiry(cutOffDate, from)
}

/**
 * Expiry for a reconnection: the next occurrence of the cut-off day after today.
 *
 * No 21-day allowance. The customer is returning to a cycle they are already on,
 * and moving them a month and a bit out would put them off their cut-off day
 * for good.
 *
 * Falls back to the same day next month when no cut-off day is recorded.
 */
export function reconnectExpiry(cutOffDate: number | null, from: Date = new Date()): Date {
  const anchor = new Date(from.getFullYear(), from.getMonth(), from.getDate(), 0, 0, 0, 0)
  return nextCutOff(anchor, cutOffDate) ?? addMonths(anchor, 1)
}
