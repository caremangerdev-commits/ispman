/**
 * The one definition of how a MAC address is stored.
 *
 * customers.mac_address is the RADIUS username for DHCP and hotspot customers,
 * so one device must have one spelling: uppercase, colon-separated. Every
 * stored row is in that form (checked 15 Oct 2026, 5,353 rows), and every
 * writer converts to it before comparing or saving: the add and edit actions
 * (app/actions/customers.ts), the CSV import (lib/import/csv.ts) and the form
 * control (components/ui/MacAddressInput.tsx).
 *
 * The actions used to test a shape that allowed dashes and then save what was
 * typed. A MAC posted as 98-7D-DD-56-F5-99 was compared, and stored, in a
 * spelling no other row uses, so the duplicate check could not see the same
 * device held under its colon form.
 */

/** The stored form: AA:BB:CC:DD:EE:FF. */
export const MAC_FORMAT = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/

/**
 * The stored form of a MAC written with colons, dashes, dots, spaces or no
 * separators at all. Null when it is not a MAC.
 *
 * Only those separators are stripped. Stray text is NOT filtered out, so
 * "AA:BB:CC:DD:EE:GG" and "n/a" come back null rather than being reshaped
 * into something that looks like a MAC.
 */
export function canonicalMac(raw: string | null | undefined): string | null {
  const hex = (raw ?? '').replace(/[\s:.-]/g, '')
  if (!/^[0-9a-fA-F]{12}$/.test(hex)) return null
  return (hex.toUpperCase().match(/.{2}/g) as string[]).join(':')
}
