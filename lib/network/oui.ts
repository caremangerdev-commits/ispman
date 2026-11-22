/**
 * Who made a device, from the first half of its MAC address.
 *
 * Every network card's MAC starts with a block its maker bought, so the first
 * six hex digits name the maker even when the device announces nothing about
 * itself. Mimosa radios and most Ubiquiti radios do not announce themselves
 * to a MikroTik, so this is how ISPMan recognises them in the router's address
 * tables.
 *
 * ONLY THE MAKERS OF NETWORK GEAR A WISP RUNS. Phones, laptops and TVs are
 * left unnamed on purpose: they are what customers plug in, not the network.
 * A maker missing here only means a device is not offered automatically — it
 * can still be added by hand.
 */

const MAKERS: Record<string, string[]> = {
  Ubiquiti: [
    '00156D', '002722', '04186D', '0418D6', '0CEA14', '18E829', '1C6A1B', '245A4C', '24A43C', '28704E',
    '44D9E7', '602232', '687251', '68D79A', '70A741', '7483C2', '74ACB9', '784558', '788A20', '802AA8',
    '942A6F', '9C05D6', 'AC8BA9', 'B4FBE4', 'D021F9', 'D8B370', 'DC9FDB', 'E063DA', 'E43883', 'F09FC2',
    'F492BF', 'F4E2C6', 'FCECDA',
  ],
  Mimosa: ['20B5C6'],
  MikroTik: [
    '000C42', '04F41C', '085531', '18FD74', '2CC81B', '488F5A', '48A98A', '4C5E0C', '64D154', '6C3B6B',
    '744D28', '789A18', 'B869F4', 'C4AD34', 'CC2DE0', 'D401C3', 'D4CA6D', 'DC2C6E', 'E48D8C', 'F41E57',
  ],
  Cambium: ['000456', '58C17A', 'BCE67C'],
}

const BY_PREFIX = new Map<string, string>()
for (const [maker, prefixes] of Object.entries(MAKERS)) for (const p of prefixes) BY_PREFIX.set(p, maker)

/** "Ubiquiti", "Mimosa", "MikroTik", "Cambium", or null for anything else. */
export function makerFromMac(mac: string | null | undefined): string | null {
  const hex = (mac ?? '').replace(/[^0-9a-fA-F]/g, '').toUpperCase()
  return hex.length >= 6 ? BY_PREFIX.get(hex.slice(0, 6)) ?? null : null
}

/** Makers whose gear is a radio link: on a customer's MAC, that customer is wireless. */
export const RADIO_MAKERS = new Set(['Ubiquiti', 'Mimosa', 'Cambium'])
