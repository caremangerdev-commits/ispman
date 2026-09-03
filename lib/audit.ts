import 'server-only'

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
 * Appended to `details` when a platform operator writes into a tenant.
 *
 * A field on the existing `details` column rather than a new column, because
 * this project's migrations are applied by hand — a marker that depends on
 * someone remembering to run SQL is a marker that silently lies until they do.
 *
 * Follows the `| name=value` convention already used by radiusLogDetails(), so
 * it survives the field extractor in lib/format.ts#humaniseLogDetail, which
 * renders it as "(platform operator)".
 */
export function actingMarker(userId: number): string {
  return ' | via=super_admin:#' + userId
}

/**
 * Strips anything already shaped like the marker out of caller-supplied text.
 *
 * Several `details` strings embed free-text form fields — checkoff notes, an
 * import's file name. Without this, a tenant's own staff could type
 * "| via=super_admin:#1" into a notes box and have their change render as the
 * platform operator's. The marker has to mean one thing, so this function is
 * the only thing allowed to put it there.
 */
const MARKER_RE = /\s*\|\s*via=super_admin:#\d+/gi

function stripMarkers(details: string): string {
  return details.replace(MARKER_RE, '')
}

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

    const clean = stripMarkers(input.details)
    const details = crossTenant ? clean + actingMarker(profile.id) : clean

    const { error } = await tenantClient().from('log').insert({
      company_id: companyId,
      user_id: userId,
      customer_id: input.customerId ?? null,
      type: input.type,
      details,
    })

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
