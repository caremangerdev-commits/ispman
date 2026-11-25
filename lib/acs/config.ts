/**
 * How a company wants its customers' ONUs set up inside: the Wi-Fi name and
 * password, and the internet login. Kept apart from the server code so the
 * settings page can use the same type and the same preview.
 *
 * EVERY COMPANY DOES THIS DIFFERENTLY, so nothing is assumed. The Wi-Fi name
 * is a pattern filled from the customer ("{first}-WiFi", "{account}"); the
 * password comes from where the company chooses, or is left alone; the
 * internet login is only written for customers who log in with PPPoE.
 */
export type OnuConfig = {
  enabled: boolean
  /** e.g. "{first}-WiFi". Tokens: {name} {first} {last} {account}. Empty: leave the name alone. */
  wifiName: string
  /** Where the Wi-Fi password comes from. */
  wifiPassword: 'phone' | 'account' | 'random' | 'leave'
  /** Put the customer's PPPoE login into the ONU, for PPPoE customers. */
  pppoe: boolean
  /** Point ONUs authorized on a ZTE OLT at ISPMan's ACS, on this VLAN. */
  acs: { zte: boolean; vlan: number | null }
}

export const DEFAULT_ONU_CONFIG: OnuConfig = {
  enabled: false,
  wifiName: '{first}-WiFi',
  wifiPassword: 'leave',
  pppoe: true,
  acs: { zte: false, vlan: null },
}

export type OnuCustomer = {
  first: string
  last: string
  account: string | null
  phone: string | null
  pppoeUser: string | null
  pppoePass: string | null
  pppoe: boolean
}

/** Letters, numbers, spaces and a few marks; ONUs reject the rest or show them garbled. */
const clean = (s: string) => s.replace(/[^A-Za-z0-9 _.-]/g, '').replace(/\s+/g, ' ').trim()

export function wifiNameFor(pattern: string, c: OnuCustomer): string | null {
  if (!pattern.trim()) return null
  const name = clean(
    pattern
      .replace(/\{name\}/g, (c.first + ' ' + c.last).trim())
      .replace(/\{first\}/g, c.first)
      .replace(/\{last\}/g, c.last)
      .replace(/\{account\}/g, c.account ?? '')
  )
  // Wi-Fi names are at most 32 characters.
  return name ? name.slice(0, 32) : null
}

/**
 * The Wi-Fi password the rule gives this customer, or null to leave it as is.
 * WPA2 needs at least 8 characters; a phone or account number shorter than
 * that is not used rather than padded into something nobody would guess.
 */
export function wifiPasswordFor(rule: OnuConfig['wifiPassword'], c: OnuCustomer, random: () => string): string | null {
  if (rule === 'leave') return null
  if (rule === 'random') return random()
  const raw = rule === 'phone' ? (c.phone ?? '').replace(/\D/g, '') : (c.account ?? '').replace(/\s/g, '')
  return raw.length >= 8 ? raw.slice(-20) : null
}

export function cleanOnuConfig(raw: unknown): OnuConfig {
  const r = (raw ?? {}) as Partial<OnuConfig>
  const vlan = Number(r.acs?.vlan)
  return {
    enabled: r.enabled === true,
    wifiName: typeof r.wifiName === 'string' ? r.wifiName.slice(0, 60) : DEFAULT_ONU_CONFIG.wifiName,
    wifiPassword: ['phone', 'account', 'random', 'leave'].includes(String(r.wifiPassword))
      ? (r.wifiPassword as OnuConfig['wifiPassword'])
      : 'leave',
    pppoe: r.pppoe !== false,
    acs: { zte: r.acs?.zte === true, vlan: Number.isInteger(vlan) && vlan >= 1 && vlan <= 4094 ? vlan : null },
  }
}
