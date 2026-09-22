import 'server-only'

import { actingMarker, stripActingMarkers, systemMarker } from '@/lib/log-detail'
import { getSchemaCapabilities } from '@/lib/schema'
import { getSession } from '@/lib/session'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * The single writer for the `log` table.
 *
 * WHY THIS EXISTS: a super admin can now enter any tenant and do anything a
 * company admin could. The tenant's own audit trail has to show that truthfully
 * — an ISP reading their activity log must be able to tell that a change came
 * from the platform operator rather than from one of their own staff.
 *
 * Routing every log write through one function is what makes that a guarantee
 * instead of a convention. There is no marker to remember and no company id to
 * pass: this decides both. A new `log` insert written by hand somewhere else
 * would silently omit the marker, so DO NOT ADD ONE — call this.
 *
 * Never throws. Every existing call site treated a failed audit write as
 * something to report and move past: the change has already landed, and undoing
 * it to keep the log tidy would take away what the operator asked for.
 */

/**
 * The marker and the sanitiser both come from lib/log-detail.ts, which owns the
 * `details` wire format for readers and writers alike. This module used to
 * carry its own copy of the marker regex while two separate readers carried
 * theirs; one of those readers was wrong and took a page down. Re-exported
 * rather than re-declared so `actingMarker` stays importable from here for the
 * call sites that already do.
 */
export { actingMarker } from '@/lib/log-detail'

export type LogEventInput = {
  type: string
  details: string
  customerId?: number | null
  /**
   * Overrides the tenant this row is filed against. Defaults to the acting
   * company, which is already the tenant when a super admin is switched in.
   *
   * Pass this only for a genuinely cross-tenant write made from OUTSIDE the
   * switch — app/actions/platform.ts files its password reset against the
   * target's company so it lands in that tenant's trail.
   */
  companyId?: number
  /** Defaults to the caller's own user id. A switch never changes who they are. */
  userId?: number
  /** Console prefix for a failed write, e.g. '[tickets]'. */
  tag?: string

  // --- Migration 0016 metadata ---------------------------------------------
  //
  // COLUMNS, NOT MORE `details` TEXT. Everything below could be written into
  // the details string — reversalDetails already writes an amount there — but
  // a field inside prose can only be read back by the parser that wrote it.
  // "What did we reverse last quarter" should be a SUM over a numeric column,
  // not a regex over a sentence that a later edit is free to reword. The
  // details string stays the human account; these are the machine's copy.
  //
  // All three are optional and dropped when 0016 has not been applied, so a
  // caller can start passing them before the SQL is run.

  /**
   * The money this row is about, signed the same way the details field is:
   * positive took money out of the books, negative put it back. Null for rows
   * that are not about an amount at all, which is most of them.
   */
  amount?: number | null

  /**
   * Ties rows written by one operator action together.
   *
   * A correction is usually more than one row — money reversed here, the
   * expiry corrected separately afterwards — and nothing in the log currently
   * says the two belong to each other. Sharing an id makes the pairing a join
   * instead of a guess about timestamps.
   */
  correlationId?: string | null

  /**
   * The OTHER customer in an action involving two of them.
   *
   * `customer_id` says whose record the row is filed against; a payment moved
   * off the wrong customer and onto the right one is one action touching two
   * accounts, and without this the second one is only named in prose.
   */
  relatedCustomerId?: number | null
}

export type LogEventResult = { ok: true } | { ok: false; error: string }

export async function logEvent(input: LogEventInput): Promise<LogEventResult> {
  const tag = input.tag ?? '[audit]'

  try {
    const session = await getSession()
    const { profile, actingAs } = session

    const companyId = input.companyId ?? session.company.id
    const userId = input.userId ?? profile.id

    // Marked when a platform operator writes into a tenant — either switched
    // into it, or reaching into one from the platform section. Never marked for
    // an ordinary user, and never for a super admin working in their own
    // company, which is not cross-tenant.
    const crossTenant =
      profile.is_super_admin &&
      (actingAs !== null || companyId !== profile.company_id)

    const clean = stripActingMarkers(input.details)
    const details = crossTenant ? clean + actingMarker(profile.id) : clean

    const row: Record<string, unknown> = {
      company_id: companyId,
      user_id: userId,
      customer_id: input.customerId ?? null,
      type: input.type,
      details,
    }

    // Probed only when a caller actually passes metadata, so the ordinary write
    // costs nothing extra. When 0016 is not applied the fields are DROPPED and
    // the row still goes in: the change being logged has already happened, and
    // losing the whole audit row to preserve its metadata is the worse trade.
    // Said on the console so a silent downgrade is not silent.
    const wantsMetadata =
      input.amount !== undefined ||
      input.correlationId !== undefined ||
      input.relatedCustomerId !== undefined

    if (wantsMetadata) {
      if ((await getSchemaCapabilities()).logMetadata) {
        row.amount = input.amount ?? null
        row.correlation_id = input.correlationId ?? null
        row.related_customer_id = input.relatedCustomerId ?? null
      } else {
        console.warn(
          '%s wrote a %s row without its metadata: migration 0016 is not applied.',
          tag, input.type
        )
      }
    }

    const { error } = await tenantClient().from('log').insert(row)

    if (error) {
      console.error('%s could not write a %s log row: %s', tag, input.type, error.message)
      return { ok: false, error: error.message }
    }

    return { ok: true }
  } catch (err) {
    const message = (err as Error).message
    console.error('%s could not write a %s log row: %s', tag, input.type, message)
    return { ok: false, error: message }
  }
}

// ---------------------------------------------------------------------------
// System writes — rows with no signed-in user behind them
// ---------------------------------------------------------------------------

/**
 * The `users` row the daily billing engine writes as. Created by migration
 * 0024; has no auth account, so it cannot sign in. Looked up by email rather
 * than by a hard-coded id because ids differ between databases.
 */
export const SYSTEM_BILLING_EMAIL = 'billing-engine@system.ispman'

export type SystemActor = { id: number; email: string }

/**
 * The system identity for a background process, or null when migration 0024
 * has not created it. The engine REFUSES to run without it (see
 * lib/data/billing-engine.ts): a charge with no one to file it under is a
 * charge the trail cannot explain.
 */
export async function systemActor(email: string = SYSTEM_BILLING_EMAIL): Promise<SystemActor | null> {
  const { data, error } = await tenantClient()
    .from('users')
    .select('id, email')
    .eq('email', email)
    .maybeSingle()
  if (error) {
    console.error('[audit] could not look up the system user %s: %s', email, error.message)
    return null
  }
  return (data as SystemActor | null) ?? null
}

export type LogSystemEventInput = {
  /** The tenant the row is filed against. There is no session to default from. */
  companyId: number
  /** Which process wrote it: 'billing'. Becomes the `via=system:<process>` marker. */
  process: 'billing'
  /** The identity to file it under — from systemActor(). */
  actor: SystemActor
  type: string
  details: string
  customerId?: number | null
  tag?: string
  amount?: number | null
  correlationId?: string | null
}

/**
 * logEvent for a background process. Same table, same sanitiser, same
 * metadata handling, but no getSession(): a tick has no cookies to read and
 * would be redirected to /login by the one logEvent calls. The marker says
 * which process wrote the row, the way actingMarker says a platform operator
 * did, so a tenant's trail never shows an automatic charge as staff work.
 *
 * Never throws, for the same reason logEvent never does.
 */
export async function logSystemEvent(input: LogSystemEventInput): Promise<LogEventResult> {
  const tag = input.tag ?? '[system]'

  try {
    const details = stripActingMarkers(input.details) + systemMarker(input.process)

    const row: Record<string, unknown> = {
      company_id: input.companyId,
      user_id: input.actor.id,
      customer_id: input.customerId ?? null,
      type: input.type,
      details,
    }

    const wantsMetadata = input.amount !== undefined || input.correlationId !== undefined
    if (wantsMetadata) {
      if ((await getSchemaCapabilities()).logMetadata) {
        row.amount = input.amount ?? null
        row.correlation_id = input.correlationId ?? null
      } else {
        console.warn(
          '%s wrote a %s row without its metadata: migration 0016 is not applied.',
          tag, input.type
        )
      }
    }

    const { error } = await tenantClient().from('log').insert(row)
    if (error) {
      console.error('%s could not write a %s log row: %s', tag, input.type, error.message)
      return { ok: false, error: error.message }
    }
    return { ok: true }
  } catch (err) {
    const message = (err as Error).message
    console.error('%s could not write a %s log row: %s', tag, input.type, message)
    return { ok: false, error: message }
  }
}
