import 'server-only'

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
