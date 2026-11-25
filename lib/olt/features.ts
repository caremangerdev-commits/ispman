/**
 * What each OLT brand can show or do from ISPMan, so the page offers only
 * that. A tab that can never fill — Cards on a GCOM, which has none to list —
 * is clutter that reads like something is broken.
 *
 * Kept apart from the drivers (which are server-only) so the page can use it.
 */
export type OltFeatures = {
  /** Lists its line cards and their state. */
  cards: boolean
  /** Lists its uplink ports. */
  uplinks: boolean
  /** Lists the VLANs set on it. */
  vlans: boolean
  /**
   * New ONUs wait to be let on. GCOM adds every ONU by itself, so there is no
   * Unauthorized list and nothing to switch on automatically.
   */
  authorise: boolean
  /**
   * ISPMan may change things on it: authorize, reboot, disable, delete.
   *
   * False for a brand whose driver was written from the maker's command guide
   * and not yet watched working on a real unit. Reading is harmless if a
   * command is slightly wrong — the list comes back short. Writing is not,
   * and these OLTs are in production. A brand turns true once its read side
   * has been seen right on one of ours.
   */
  writes: boolean
  /**
   * Can read how the ONUs already working on a port are set up, so new ones
   * are set up the same way (tagged or not, which VLAN).
   */
  copySetup: boolean
}

const FEATURES: Record<string, OltFeatures> = {
  zte: { cards: true, uplinks: true, vlans: true, authorise: true, writes: true, copySetup: true },
  huawei: { cards: true, uplinks: false, vlans: false, authorise: true, writes: false, copySetup: false },
  vsol: { cards: false, uplinks: false, vlans: false, authorise: true, writes: false, copySetup: false },
  cdata: { cards: false, uplinks: false, vlans: false, authorise: true, writes: true, copySetup: false },
  gcom: { cards: false, uplinks: false, vlans: false, authorise: false, writes: true, copySetup: false },
}

/** Said wherever a change is refused or hidden for a read-only brand. */
export const READ_ONLY_NOTE =
  'ISPMan only reads this make of OLT for now. Authorizing, rebooting and other changes switch on once it has been tested on a real unit.'

export function oltFeatures(brand: string): OltFeatures {
  return FEATURES[brand] ?? { cards: true, uplinks: true, vlans: true, authorise: true, writes: false, copySetup: false }
}
