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
}

const FEATURES: Record<string, OltFeatures> = {
  zte: { cards: true, uplinks: true, vlans: true, authorise: true },
  huawei: { cards: true, uplinks: false, vlans: false, authorise: true },
  vsol: { cards: false, uplinks: false, vlans: false, authorise: true },
  cdata: { cards: false, uplinks: false, vlans: false, authorise: true },
  gcom: { cards: false, uplinks: false, vlans: false, authorise: false },
}

export function oltFeatures(brand: string): OltFeatures {
  return FEATURES[brand] ?? { cards: true, uplinks: true, vlans: true, authorise: true }
}
