/**
 * Parsing and formatting for `customers.gps`.
 *
 * THE COLUMN IS TEXT AND STAYS TEXT. It holds one string, "latitude,longitude",
 * exactly as it always has — "18.16104,-77.11877". Nothing here changes the
 * shape of what is stored; it only decides what is allowed in and how it is
 * rendered back out.
 *
 * Client-safe on purpose: the capture control validates as the technician types
 * and the server actions validate again on submit, so both sides have to run
 * the same parser. The server remains the source of truth.
 */

/** A parsed pair. Latitude first, matching the stored order. */
export type GpsCoords = { lat: number; lng: number }

export type GpsParse =
  | { ok: true; coords: GpsCoords; value: string }
  | { ok: false; error: string }

/**
 * Two signed decimals separated by a comma, with optional spaces around it.
 *
 * A leading `+` is accepted because that is how some phone GPS apps and mapping
 * sites write a positive longitude, and rejecting it would look arbitrary to a
 * technician pasting a value that plainly reads as coordinates.
 */
const PAIR_RE = /^([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)$/

/**
 * Decimal places kept from a device reading.
 *
 * The fifth decimal place of a degree is about a metre — finer than any phone
 * GPS is accurate to, and already finer than the 50m warning below. Keeping the
 * raw float instead would write "18.161040000000001,-77.11877" into a text
 * column and make two captures of the same doorstep look different.
 *
 * Applied ONLY to readings this app captures. A value typed or pasted by hand
 * is stored at whatever precision it was given: rounding someone's Google Maps
 * coordinates on their behalf discards precision they deliberately supplied.
 */
const CAPTURE_DP = 5

/** Anything looser than this is flagged to the technician. */
export const ACCURACY_WARN_METRES = 50

/**
 * Validates a "lat,lng" string.
 *
 * An EMPTY STRING IS NOT AN ERROR — it is the absence of a location, which is
 * the state most customers are in and a perfectly valid thing to save. Callers
 * that need to tell "blank" from "wrong" check the raw value first; this
 * reports blank as the error it would be if a value were required, and every
 * caller in the app treats blank as "no coordinates" before ever calling in.
 */
export function parseGps(raw: string | null | undefined): GpsParse {
  const value = (raw ?? '').trim()
  if (!value) return { ok: false, error: 'No coordinates given.' }

  const m = PAIR_RE.exec(value)
  if (!m) {
    return {
      ok: false,
      error: 'Use "latitude,longitude" — for example 18.16104,-77.11877.',
    }
  }

  const lat = Number(m[1])
  const lng = Number(m[2])

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, error: 'Those are not valid numbers.' }
  }
  // Checked separately so the message names the half that is wrong. A pair
  // entered the wrong way round usually trips the latitude bound, which is the
  // most common paste error worth naming precisely.
  if (lat < -90 || lat > 90) {
    return { ok: false, error: 'Latitude must be between -90 and 90.' }
  }
  if (lng < -180 || lng > 180) {
    return { ok: false, error: 'Longitude must be between -180 and 180.' }
  }

  // Normalised: the separator loses any spaces, but the digits are left exactly
  // as they were given.
  return { ok: true, coords: { lat, lng }, value: m[1] + ',' + m[2] }
}

/** True when a stored value is usable. Blank is simply "no location". */
export function hasGps(raw: string | null | undefined): boolean {
  return parseGps(raw).ok
}

/** A device reading as the string that goes in the column. */
export function formatGps(lat: number, lng: number): string {
  return lat.toFixed(CAPTURE_DP) + ',' + lng.toFixed(CAPTURE_DP)
}

/**
 * The map link for a stored value, or null when there is nothing to link to.
 *
 * Built from the PARSED numbers rather than the raw string so a value with a
 * space in it cannot produce a broken URL.
 */
export function gpsMapUrl(raw: string | null | undefined): string | null {
  const parsed = parseGps(raw)
  if (!parsed.ok) return null
  return 'https://maps.google.com/?q=' + parsed.coords.lat + ',' + parsed.coords.lng
}

/** "±12 m" — accuracy as a technician should read it. */
export function formatAccuracy(metres: number): string {
  return '±' + Math.round(metres) + ' m'
}
