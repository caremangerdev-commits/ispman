'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import {
  affectedCustomers, closeIncident, createIncident, getIncident, updateIncident,
  type Incident, type IncidentScope,
} from '@/lib/data/incidents'
import { getSmsSettings } from '@/lib/data/sms'
import { channelReadiness, enqueueForRoute } from '@/lib/messaging/enqueue'
import { can } from '@/lib/permissions'
import { displayName, getSession } from '@/lib/session'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * Outage incidents (migration 0037). Declaring an outage is an administrative
 * act, so it is gated on manage_company_settings. The SMS on open and restore
 * is off by default per company (settings.notify_outage_enabled) and goes
 * through the paced outbox (kind 'bulk'), so a company-wide notice does not
 * fire thousands of messages at once.
 */

async function authorize() {
  const session = await getSession()
  if (!can(session.profile.role, 'manage_company_settings')) {
    throw new Error('Forbidden: role "' + session.profile.role + '" cannot manage incidents.')
  }
  return session
}

export type IncidentResult = { ok: true } | { ok: false; error: string }

const str = (fd: FormData, key: string) => String(fd.get(key) ?? '').trim()

/** A datetime-local value ("YYYY-MM-DDTHH:MM") to an ISO instant, or null. */
function parseWhen(raw: string): string | null {
  if (!raw) return null
  const d = new Date(raw)
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}

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
async function blastOutage(
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

export async function openIncident(_prev: IncidentResult | null, formData: FormData): Promise<IncidentResult> {
  const { company, profile } = await authorize()

  const title = str(formData, 'title')
  if (!title) return { ok: false, error: 'Enter a short title.' }

  const scope: IncidentScope = str(formData, 'scope') === 'access_point' ? 'access_point' : 'company'
  const scopeValue = scope === 'access_point' ? str(formData, 'scope_value') : null
  if (scope === 'access_point' && !scopeValue) {
    return { ok: false, error: 'Choose which access point is affected.' }
  }

  const id = await createIncident(
    company.id,
    { title, message: str(formData, 'message') || null, scope, scopeValue, nextUpdateAt: parseWhen(str(formData, 'next_update_at')) },
    { id: profile.id, name: displayName(profile) }
  )

  const incident = await getIncident(company.id, id)
  if (incident) await blastOutage(company.id, company.name, incident, 'open')

  revalidatePath('/dashboard/incidents')
  return { ok: true }
}

export async function postIncidentUpdate(formData: FormData): Promise<void> {
  const { company } = await authorize()
  const id = Number(formData.get('id'))
  if (Number.isInteger(id)) {
    await updateIncident(company.id, id, {
      message: str(formData, 'message') || null,
      nextUpdateAt: parseWhen(str(formData, 'next_update_at')),
    })
    revalidatePath('/dashboard/incidents')
  }
  redirect('/dashboard/incidents')
}

export async function resolveIncident(formData: FormData): Promise<void> {
  const { company } = await authorize()
  const id = Number(formData.get('id'))
  if (Number.isInteger(id)) {
    await closeIncident(company.id, id)
    const incident = await getIncident(company.id, id)
    if (incident) await blastOutage(company.id, company.name, incident, 'restored')
    revalidatePath('/dashboard/incidents')
  }
  redirect('/dashboard/incidents')
}
