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
  /** ONU counts across the whole OLT, as of the last reading. */
  onus?: {
    /** Registered on a PON port and allowed on the network. */
    authorised: number
    /** Plugged in and detected, but not yet let on. */
    unauthorised: number
    /** Authorised, but not in service right now. */
    offline: number
  }
}

/**
 * One module per brand. Everything brand-specific — prompts, commands, the
 * layout of what comes back — stays inside the module, and the pages only ever
 * see these types. Adding Huawei or V-SOL is a new file and one line in the
 * registry, with no screen changed.
 */
/** An ONU that is plugged in and detected, but not yet let on. */
export type OltPendingOnu = {
  /** The PON port it is on, e.g. gpon-olt_1/1/3. */
  port: string
  sn: string
  model: string | null
}

/** An ONU registered on the OLT. */
export type OltOnu = {
  /** e.g. gpon-onu_1/1/3:12 */
  id: string
  port: string
  index: number
  type: string | null
  sn: string | null
  /** As the OLT words it: working, LOS, DyingGasp, OffLine... */
  phase: string
  online: boolean
  /**
   * Light levels in dBm, for the bars in the list. rx is what the ONU
   * receives from the OLT; tx is the ONU's own light as it arrives at the
   * OLT. Null when the ONU is offline or the OLT gave no reading.
   */
  rx?: number | null
  tx?: number | null
  /**
   * MAC addresses the OLT has seen behind this ONU, as AA:BB:CC:DD:EE:FF.
   * Normally one: the customer's router. This is what ties an ONU to a
   * customer without anyone typing.
   */
  macs?: string[]
  /**
   * Switched off on purpose from the OLT. The ONU stays registered and keeps
   * its settings, but carries nothing until it is enabled again.
   */
  disabled?: boolean
}

export type OltOnuLists = { pending: OltPendingOnu[]; onus: OltOnu[] }

/** Everything one ONU reports about itself and its light levels. */
export type OltOnuDetail = {
  id: string
  name: string | null
  description: string | null
  type: string | null
  sn: string | null
  phase: string
  online: boolean
  /** As the OLT words it, e.g. "1234m". */
  distance: string | null
  onlineFor: string | null
  /**
   * Light levels in dBm. onuRx is the one that decides connection quality:
   * what the customer's ONU receives from the OLT.
   */
  onuRx: number | null
  onuTx: number | null
  oltRx: number | null
  oltTx: number | null
  vendor: string | null
  model: string | null
  firmware: string | null
  /** The last times it came online and went off, newest as the OLT lists them. */
  history: { up: string; down: string | null; cause: string | null }[]
  /**
   * Traffic through the ONU right now, in bits per second, and the totals the
   * OLT has counted. "down" is towards the customer.
   */
  traffic?: { downBps: number | null; upBps: number | null; downBytes: number | null; upBytes: number | null } | null
  disabled?: boolean
}

export type OltOnuAction =
  | { kind: 'reboot' }
  | { kind: 'remove' }
  | { kind: 'disable' }
  | { kind: 'enable' }
  | { kind: 'rename'; name: string; description: string }
  /**
   * GCOM only: the two settings a V-SOL ONU needs on a GCOM OLT before it
   * passes traffic. Set on that one ONU, never on the group.
   */
  | { kind: 'vsol-fix' }
  /**
   * Rewrite how this ONU's traffic is carried (tagged or untagged, which
   * VLAN) without unregistering it. The customer drops for a few seconds.
   */
  | { kind: 'service'; setup: OnuServiceSetup }

/**
 * How an ONU's traffic reaches the uplink. Two halves that have to agree:
 *
 *   onuVlan — the tag the ONU itself puts on its traffic. Null when it sends
 *   plain traffic and never knows a VLAN exists (VLAN switched off on the
 *   customer's ONU).
 *
 *   vlan — the VLAN the OLT carries it on to the uplink.
 *
 * Get the first half wrong and the ONU shows as authorized while nothing
 * passes: the OLT drops tagged traffic it was told would arrive untagged, and
 * the other way round.
 */
export type OnuServiceSetup = {
  onuVlan: number | null
  vlan: number
  /** The upstream profile to use, when copying a setup that names one. */
  upProfile?: string | null
}

/** A setup read off ONUs already working on a port. */
export type LearnedSetup = OnuServiceSetup & {
  /** The ONU it was read from, e.g. gpon-onu_1/1/3:5. */
  from: string
  /** How many of the ONUs read have this exact setup, out of how many read. */
  agreeing: number
  read: number
  /** The configuration lines a new ONU would be given, to show before it is. */
  lines?: string[]
}

/** 'learn': copy whatever the working ONUs on the same port use. */
export type OnuSetupChoice = OnuServiceSetup | 'learn'

export type OltAuthoriseResult = {
  sn: string
  port: string
  ok: boolean
  /** The ONU's new id on the OLT, when it worked. */
  id?: string
  /** The setup it was given, when it worked. */
  setup?: OnuServiceSetup
  /** Where that setup came from, when it was learned. */
  learnedFrom?: string
  error?: string
}

export type OltDriver = {
  brand: string
  label: string
  inspect(target: CliTarget, creds: OltLogin): Promise<OltInfo>
  /** Read live: who is waiting, and who is already registered. */
  listOnus(target: CliTarget, creds: OltLogin): Promise<OltOnuLists>
  onuDetail(target: CliTarget, creds: OltLogin, id: string): Promise<OltOnuDetail>
  onuAction(target: CliTarget, creds: OltLogin, id: string, action: OltOnuAction): Promise<void>
  /**
   * Let ONUs on. Each item may say how its traffic is carried; without one,
   * plain untagged traffic carried on `vlan`. Drivers that cannot set the
   * ONU side treat every setup as untagged on `vlan`.
   */
  authorise(
    target: CliTarget,
    creds: OltLogin,
    items: { port: string; sn: string; setup?: OnuSetupChoice }[],
    vlan: number
  ): Promise<OltAuthoriseResult[]>
  /**
   * Read how the ONUs already working on a port are set up, so a new one can
   * be set up the same way. Null when none could be read.
   */
  learnSetup?(target: CliTarget, creds: OltLogin, port: string): Promise<LearnedSetup | null>
}
