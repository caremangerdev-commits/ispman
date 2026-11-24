import 'server-only'

import { affectedCustomers, type Incident } from '@/lib/data/incidents'
import { getSmsSettings } from '@/lib/data/sms'
import { channelReadiness, enqueueForRoute } from '@/lib/messaging/enqueue'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * Telling customers about an outage, on open and on restore. Shared by the
 * Incidents page and the background OLT check, which opens and closes
 * incidents for a PON port by itself. Off unless the company turned outage
 * messages on (settings.notify_outage_enabled), and paced through the outbox.
 */

function whenLabel(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  }).format(d)
}

async function outageSmsEnabled(companyId: number): Promise<boolean> {
  const { data } = await tenantClient()
    .from('settings').select('notify_outage_enabled').eq('company_id', companyId).maybeSingle()
  return Boolean((data as { notify_outage_enabled: boolean | null } | null)?.notify_outage_enabled)
}

/** Texts every affected customer on open or restore, via the paced outbox. */
export async function blastOutage(
  companyId: number,
  companyName: string,
  incident: Incident,
  phase: 'open' | 'restored'
): Promise<void> {
  try {
    if (!(await outageSmsEnabled(companyId))) return
    const settings = await getSmsSettings(companyId)
    const readiness = await channelReadiness(companyId, settings)
    const customers = await affectedCustomers(companyId, incident)

    const text =
      phase === 'open'
        ? companyName + ': ' + (incident.message || incident.title) +
          (incident.nextUpdateAt ? ' Next update by ' + whenLabel(incident.nextUpdateAt) + '.' : '')
        : companyName + ': your internet service is restored. ' + incident.title

    for (const c of customers) {
      await enqueueForRoute({
        companyId,
        kind: 'bulk',
        settings,
        readiness,
        customer: {
          id: c.id, phone: c.phone, email: c.email,
          sms_opted_out: c.sms_opted_out, email_opted_out: c.email_opted_out,
        },
        values: {},
        text: {
          sms: text,
          email: { subject: companyName + (phase === 'open' ? ' — service issue' : ' — service restored'), body: text },
        },
        dedupeKey: 'outage:' + incident.id + ':' + phase + ':' + c.id,
      }).catch(() => {})
    }
  } catch (err) {
    console.error('[incidents] outage blast failed:', (err as Error).message)
  }
}

