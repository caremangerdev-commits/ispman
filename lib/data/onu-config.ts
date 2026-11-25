import 'server-only'

import { cleanOnuConfig, type OnuConfig } from '@/lib/acs/config'
import { tenantClient } from '@/lib/supabase/tenant'

/** A company's rules for setting up its customers' ONUs inside (migration 0071). */
export async function getOnuConfig(companyId: number): Promise<OnuConfig> {
  const { data } = await tenantClient().from('company_onu_config').select('config').eq('company_id', companyId).maybeSingle()
  return cleanOnuConfig((data as { config: unknown } | null)?.config)
}

export async function setOnuConfig(companyId: number, config: OnuConfig): Promise<boolean> {
  const { error } = await tenantClient()
    .from('company_onu_config')
    .upsert({ company_id: companyId, config, updated_at: new Date().toISOString() }, { onConflict: 'company_id' })
  return !error
}

/**
 * Where ONUs reach ISPMan's ACS. Plain http on port 80 on purpose: many ONUs
 * cannot check a modern certificate, and the server passes /cwmp through
 * without redirecting it to https (see the Apache site).
 */
export function acsUrl(): string {
  const configured = (process.env.ACS_URL ?? '').trim()
  if (configured) return configured
  const host = (process.env.PUBLIC_APP_URL ?? 'https://app.ispman.online').replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  return 'http://' + host + '/cwmp'
}

/** The ACS step for authorizing on a ZTE, if this company has switched it on. */
export async function acsStepFor(companyId: number): Promise<{ url: string; vlan: number } | undefined> {
  const cfg = await getOnuConfig(companyId)
  return cfg.enabled && cfg.acs.zte && cfg.acs.vlan ? { url: acsUrl(), vlan: cfg.acs.vlan } : undefined
}
