import type { CliTarget } from '@/lib/olt/telnet'

/** The login ISPMan uses on an OLT. Decrypted; never log or render it. */
export type OltLogin = { user: string; password: string; enablePassword: string | null }

export type OltCard = {
  slot: number
  /** The card type the OLT has been told to expect in this slot. */
  configured: string
  /** The card type actually running there. Null when it has not started. */
  actual: string | null
  ports: number | null
  software: string | null
  /** As the OLT words it: INSERVICE, STANDBY, HWONLINE, OFFLINE... */
  status: string
}

export type OltInfo = {
  name: string | null
  model: string | null
  version: string | null
  uptime: string | null
  cards: OltCard[]
}

/**
 * One module per brand. Everything brand-specific — prompts, commands, the
 * layout of what comes back — stays inside the module, and the pages only ever
 * see these types. Adding Huawei or V-SOL is a new file and one line in the
 * registry, with no screen changed.
 */
export type OltDriver = {
  brand: string
  label: string
  inspect(target: CliTarget, creds: OltLogin): Promise<OltInfo>
}
