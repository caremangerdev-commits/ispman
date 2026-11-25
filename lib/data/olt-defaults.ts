import 'server-only'

import { cleanLevels, type SignalLevels } from '@/lib/olt/signal-levels'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * How a company last set up new ONUs on one OLT: copy, untagged or tagged,
 * which VLANs, which speed profiles. The Authorize screen starts from it.
 *
 * WHY PER OLT AND REMEMBERED, NOT A SETTING. Every company runs its network
 * its own way, and often each OLT differently. Asking them to describe that
 * on a settings page first is a step most will skip or get wrong; what they
 * actually chose when authorizing is the truth, so that is what is kept.
 *
 * Stored on olts.onu_defaults (migration 0067). Before that migration the
 * reads come back empty and the writes do nothing.
 */
export type OnuDefaults = {
  mode: 'learn' | 'untagged' | 'tagged'
  vlan: number
  onuVlan: number | null
  upProfile: string | null
  downProfile: string | null
}

export async function setOnuDefaults(companyId: number, oltId: number, d: OnuDefaults): Promise<void> {
  await tenantClient().from('olts').update({ onu_defaults: d }).eq('company_id', companyId).eq('id', oltId)
}

export async function getOnuDefaults(companyId: number, oltId: number): Promise<OnuDefaults | null> {
  const { data, error } = await tenantClient()
    .from('olts')
    .select('onu_defaults')
    .eq('company_id', companyId)
    .eq('id', oltId)
    .maybeSingle()
  if (error || !data) return null
  const d = (data as { onu_defaults: OnuDefaults | null }).onu_defaults
  return d && typeof d === 'object' ? d : null
}

/**
 * This OLT's signal levels (migration 0068). Asked for on its own, so a
 * server without the column reads the usual levels instead of failing.
 */
export async function getSignalLevels(companyId: number, oltId: number): Promise<SignalLevels | null> {
  const { data, error } = await tenantClient()
    .from('olts')
    .select('signal_levels')
    .eq('company_id', companyId)
    .eq('id', oltId)
    .maybeSingle()
  if (error || !data) return null
  return cleanLevels((data as { signal_levels: unknown }).signal_levels)
}

export async function setSignalLevels(companyId: number, oltId: number, levels: SignalLevels): Promise<boolean> {
  const { error } = await tenantClient()
    .from('olts')
    .update({ signal_levels: levels })
    .eq('company_id', companyId)
    .eq('id', oltId)
  return !error
}

/** Whether the owner has switched on running untested settings commands on this OLT (0069). */
export async function getSettingsUnlocked(companyId: number, oltId: number): Promise<boolean> {
  const { data, error } = await tenantClient()
    .from('olts')
    .select('settings_unlocked')
    .eq('company_id', companyId)
    .eq('id', oltId)
    .maybeSingle()
  if (error || !data) return false
  return (data as { settings_unlocked: boolean | null }).settings_unlocked === true
}

export async function setSettingsUnlocked(companyId: number, oltId: number, on: boolean): Promise<boolean> {
  const { error } = await tenantClient()
    .from('olts')
    .update({ settings_unlocked: on })
    .eq('company_id', companyId)
    .eq('id', oltId)
  return !error
}
