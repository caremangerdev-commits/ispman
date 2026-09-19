/**
 * What a company looks like: its name, its logo, one colour, how to reach it.
 *
 * ONE DEFINITION, TWO RENDERERS. The HTML email shell (lib/messaging/
 * email-shell.ts) and the PDF letterhead (lib/letterhead-pdf.ts) both take a
 * `Brand` and nothing else about the company. Neither reads settings, neither
 * parses a colour, neither decides what "no logo" means — those are decided
 * here and in lib/data/brand.ts#brandFor, once, so an emailed bill and the PDF
 * attached to it cannot show two different companies.
 *
 * PURE AND CLIENT-SAFE. No database, no storage, no node imports: the Branding
 * card validates a colour with the same function the server action does.
 */

/** The platform's colour, for a company that has not chosen one. */
export const DEFAULT_BRAND_COLOR = '#1d4ed8'

/** The text colour used wherever the brand colour cannot be read. */
const INK = '#1f2933'

/** What an upload may be, before normalising. See lib/logo.ts. */
export const LOGO_UPLOAD_MAX_BYTES = 512 * 1024
export const LOGO_UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const

/** The box the stored derivative fits inside, in pixels. */
export const LOGO_MAX_WIDTH = 640
export const LOGO_MAX_HEIGHT = 240

export type Rgb = [number, number, number]

/**
 * The colours actually drawn, all derived from the one the company chose.
 *
 * `accent` is the company's colour as given: the rule under the header, the
 * button. `onAccent` is the text that sits ON it. `ink` is the colour for text
 * that sits on WHITE — the wordmark, links — and is the accent only when the
 * accent can be read there; a pale yellow brand gets dark ink rather than an
 * invisible company name.
 */
export type BrandPalette = {
  accent: string
  onAccent: string
  ink: string
}

/** The stored logo: the derivative's bytes and its pixel size. */
export type BrandLogo = {
  png: Uint8Array
  width: number
  height: number
}

export type Brand = {
  name: string
  /** Null means "set the name as a wordmark", in both renderers. */
  logo: BrandLogo | null
  palette: BrandPalette
  contact: {
    address: string | null
    phone: string | null
    email: string | null
  }
}

/**
 * '#rrggbb' in lowercase, or null if `value` is not a colour.
 *
 * Accepts '#abc' and a missing '#', because people paste colours from
 * anywhere. The result is the only shape the column's CHECK accepts.
 */
export function normaliseBrandColor(value: string | null | undefined): string | null {
  const v = String(value ?? '').trim().toLowerCase().replace(/^#/, '')
  if (/^[0-9a-f]{6}$/.test(v)) return '#' + v
  if (/^[0-9a-f]{3}$/.test(v)) return '#' + v[0] + v[0] + v[1] + v[1] + v[2] + v[2]
  return null
}

/** 0-255 channels of a normalised colour. */
export function hexToRgb(hex: string): Rgb {
  const n = normaliseBrandColor(hex) ?? DEFAULT_BRAND_COLOR
  return [
    parseInt(n.slice(1, 3), 16),
    parseInt(n.slice(3, 5), 16),
    parseInt(n.slice(5, 7), 16),
  ]
}

/** WCAG relative luminance. */
function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG contrast ratio between two colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const la = luminance(hexToRgb(a))
  const lb = luminance(hexToRgb(b))
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * The palette for a company's colour, or for the default when it has none.
 *
 * 4.5:1 is WCAG AA for body text. The wordmark is large and could pass at 3:1,
 * but links in the body are not, and one threshold is one thing to explain.
 */
export function brandPalette(color: string | null | undefined): BrandPalette {
  const accent = normaliseBrandColor(color) ?? DEFAULT_BRAND_COLOR
  return {
    accent,
    onAccent: contrast('#ffffff', accent) >= contrast(INK, accent) ? '#ffffff' : INK,
    ink: contrast(accent, '#ffffff') >= 4.5 ? accent : INK,
  }
}

/** The colour's effect in words, for the Branding card. Null when there is nothing to say. */
export function brandColorNote(color: string | null | undefined): string | null {
  const accent = normaliseBrandColor(color)
  if (!accent) return null
  if (contrast(accent, '#ffffff') >= 4.5) return null
  return 'This colour is too light to read as text on white, so your company name and links ' +
    'are set in dark grey. It is still used for the header rule and buttons.'
}

// ---------------------------------------------------------------------------
// The derivative's format
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export type PngHeader = {
  width: number
  height: number
  bitDepth: number
  /** 0 grey, 2 RGB, 3 palette, 4 grey+alpha, 6 RGBA. */
  colourType: number
  interlaced: boolean
}

/**
 * Reads a PNG's IHDR, or null if these bytes are not a PNG.
 *
 * The IHDR is always the first chunk: 8 bytes of signature, 4 of length, 4 of
 * type, then width, height, depth, colour type, compression, filter, interlace.
 */
export function readPngHeader(bytes: Uint8Array): PngHeader | null {
  if (bytes.length < 33) return null
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return null
  const type = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15])
  if (type !== 'IHDR') return null
  const u32 = (o: number) =>
    ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0
  return {
    width: u32(16),
    height: u32(20),
    bitDepth: bytes[24],
    colourType: bytes[25],
    interlaced: bytes[28] !== 0,
  }
}

/**
 * Whether a PNG is in the one shape this app stores: 8-bit, RGB or grey, no
 * alpha, not interlaced, inside the box.
 *
 * THE PDF WRITER DEPENDS ON THIS. It passes the PNG's compressed scanlines
 * straight into the PDF with a PNG predictor, which PDF can only do for an
 * image with no alpha and no interlacing. lib/logo.ts produces this shape; this
 * is what checks it did, at upload and again when the brand is loaded.
 */
export function isStoredLogoShape(h: PngHeader | null): h is PngHeader {
  return Boolean(
    h &&
    h.bitDepth === 8 &&
    (h.colourType === 2 || h.colourType === 0) &&
    !h.interlaced &&
    h.width > 0 && h.width <= LOGO_MAX_WIDTH &&
    h.height > 0 && h.height <= LOGO_MAX_HEIGHT
  )
}
