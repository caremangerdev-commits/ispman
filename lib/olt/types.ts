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
  hardware?: string | null
  software: string | null
  /** As the OLT words it: INSERVICE, STANDBY, HWONLINE, OFFLINE... */
  status: string
  /** Percent, for cards that have a processor of their own. */
  cpu?: number | null
  memory?: number | null
}

/** A port that connects the OLT to the rest of the network. */
export type OltUplink = {
  name: string
  /** Switched on by the owner. Off is a setting, not a fault. */
  enabled: boolean
  /** A working link to something at the other end. */
  up: boolean
  medium: 'fibre' | 'copper'
  duplex: string | null
  description: string | null
  /** Bits per second, averaged by the OLT over its own short window. */
  inBps: number | null
  outBps: number | null
}

/** A port customers' ONUs hang off. */
export type OltPonPort = {
  name: string
  enabled: boolean
  up: boolean
  description: string | null
  /** How many ONUs the port can hold, and how many are registered on it. */
  capacity: number | null
  registered: number | null
  inBps: number | null
  outBps: number | null
}

export type OltVlan = {
  id: number
  name: string | null
  description: string | null
  /** Ports as the OLT lists them, e.g. "gei_1/4/1,3". */
  untagged: string | null
  tagged: string | null
}

export type OltInfo = {
  name: string | null
  model: string | null
  version: string | null
  uptime: string | null
  cards: OltCard[]
  /**
   * Optional because a check recorded before these were read has none, and an
   * old record must still render.
   */
  uplinks?: OltUplink[]
  ponPorts?: OltPonPort[]
  vlans?: OltVlan[]
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
