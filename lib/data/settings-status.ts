import 'server-only'

import { BILL_TEMPLATE_LABELS } from '@/lib/bill/settings'
import { getBillSettings } from '@/lib/data/bill-settings'
import { getGeneralSettings } from '@/lib/data/company'
import { getEnabledGateway } from '@/lib/data/payment-gateways'
import { getMessagingSettings } from '@/lib/data/sms'
import { listRouterTunnels } from '@/lib/data/tunnels'
import { adapterFor } from '@/lib/messaging/registry'
import { getSchemaCapabilities } from '@/lib/schema'
import { tenantClient } from '@/lib/supabase/tenant'
import { readHandshakes } from '@/lib/tunnels/server'
import { tunnelStatus } from '@/lib/tunnels/status'

/** ok: working. attention: something to look at. off: switched off on purpose, or nothing set up yet. */
export type StatusTone = 'ok' | 'attention' | 'off'
export type SettingStatus = { text: string; tone: StatusTone }

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'
  return n + s
}

/** A step that fails shows no status rather than taking the page down. */
async function safely<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch {
    return null
  }
}

async function countOf(table: string, companyId: number): Promise<number | null> {
  const { count, error } = await tenantClient()
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
  return error ? null : (count ?? 0)
}

const plural = (n: number, one: string, many: string) => n + ' ' + (n === 1 ? one : many)

/**
 * One line per settings card saying how that part of ISPMan stands right now,
 * read from the same places the feature itself reads, so the line cannot say
 * "on" while the feature is off. Keyed by section key (lib/settings-nav.ts).
 */
export async function settingsStatus(companyId: number): Promise<Record<string, SettingStatus>> {
  const caps = await getSchemaCapabilities()
  const [general, bill, messaging, gateway, tunnels, handshakes, users, plans, addons, misc] = await Promise.all([
    safely(() => getGeneralSettings(companyId)),
    safely(() => getBillSettings(companyId)),
    safely(() => getMessagingSettings(companyId)),
    caps.paymentGateways ? safely(() => getEnabledGateway(companyId)) : Promise.resolve(null),
    caps.routerTunnels ? safely(() => listRouterTunnels(companyId)) : Promise.resolve(null),
    caps.routerTunnels ? safely(() => readHandshakes()) : Promise.resolve(null),
    safely(() => countOf('users', companyId)),
    caps.catalog ? safely(() => countOf('service_plans', companyId)) : Promise.resolve(null),
    caps.catalog ? safely(() => countOf('additional_services', companyId)) : Promise.resolve(null),
    caps.catalog ? safely(() => countOf('misc_categories', companyId)) : Promise.resolve(null),
  ])
  const out: Record<string, SettingStatus> = {}

  if (general) {
    const parts = [general.timezone.replace(/^.*\//, '').replace(/_/g, ' ') + ' time', general.currency].filter(Boolean)
    out.company = { text: parts.join(', '), tone: 'off' }
    const day = general.billDate
    const mode = general.billingEngineMode
    out.billing =
      mode === 'live'
        ? { text: 'Bills run automatically' + (day ? ' on the ' + ordinal(day) : ''), tone: 'ok' }
        : mode === 'dry_run'
          ? { text: 'Practice run: bills are worked out but not charged', tone: 'attention' }
          : { text: 'Automatic billing is off', tone: 'off' }
  }

  if (bill && messaging) {
    const template = BILL_TEMPLATE_LABELS[bill.template] ?? 'Statement'
    out['bill-design'] = messaging.billEmailMonthly && messaging.billEmail
      ? { text: template + ', emailed to customers every month', tone: 'ok' }
      : messaging.billEmail
        ? { text: template + ', staff can email bills', tone: 'ok' }
        : { text: template + ', bills are not emailed', tone: 'off' }
  }

  if (messaging) {
    const email = messaging.channelsAvailable ? await safely(() => adapterFor('email').tenantReady(companyId, messaging)) : null
    const sms = await safely(() => adapterFor('sms').tenantReady(companyId, messaging))
    const emailText = email?.ready ? 'Email on' : 'Email off'
    const smsText = sms?.ready ? 'SMS on' : messaging.smsEnabled ? 'SMS: no phone paired' : 'SMS off'
    out.sms = {
      text: emailText + ', ' + smsText,
      tone: messaging.smsEnabled && !sms?.ready ? 'attention' : email?.ready || sms?.ready ? 'ok' : 'attention',
    }
  }

  if (caps.paymentGateways) {
    out.payments = gateway
      ? { text: 'Card payments on in the customer portal', tone: 'ok' }
      : { text: 'Card payments off', tone: 'off' }
  }

  if (tunnels) {
    const live = tunnels.filter((t) => t.revokedAt === null)
    if (live.length === 0) out.tunnels = { text: 'No routers added yet', tone: 'off' }
    else if (!handshakes) out.tunnels = { text: plural(live.length, 'router', 'routers'), tone: 'off' }
    else {
      const now = new Date()
      const up = live.filter((t) => tunnelStatus(t.publicKey, handshakes, now).status === 'up').length
      out.tunnels = {
        text: up + ' of ' + plural(live.length, 'router', 'routers') + ' connected',
        tone: up === live.length ? 'ok' : 'attention',
      }
    }
  }

  if (users !== null) out.users = { text: plural(users, 'staff account', 'staff accounts'), tone: 'off' }
  if (plans !== null) out['service-plans'] = plans === 0 ? { text: 'No plans yet', tone: 'attention' } : { text: plural(plans, 'plan', 'plans'), tone: 'off' }
  if (addons !== null) out['additional-services'] = { text: addons === 0 ? 'None yet' : plural(addons, 'add-on', 'add-ons'), tone: 'off' }
  if (misc !== null) out['misc-categories'] = { text: misc === 0 ? 'None yet' : plural(misc, 'category', 'categories'), tone: 'off' }

  return out
}
