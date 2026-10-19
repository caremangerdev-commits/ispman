import 'server-only'

import sharp from 'sharp'

import {
  isStoredLetterheadShape, isStoredLogoShape, LETTERHEAD_MAX_HEIGHT, LETTERHEAD_MAX_WIDTH,
  LETTERHEAD_RECOMMENDED, LETTERHEAD_STORED_MAX_BYTES, LETTERHEAD_UPLOAD_MAX_BYTES,
  letterheadSizeError, LOGO_MAX_HEIGHT, LOGO_MAX_WIDTH, LOGO_UPLOAD_MAX_BYTES, readPngHeader,
  type BrandLetterhead, type BrandLogo,
} from '@/lib/brand'

/**
 * Turns whatever a person uploaded into THE ONE FILE this app keeps.
 *
 * ONE UPLOAD, ONE DERIVATIVE, TWO USES. The output is an 8-bit RGB PNG,
 * flattened onto white, not interlaced, inside 640x240. That single file is
 * embedded in every HTML email and drawn on every PDF letterhead. There is no
 * "email size" and "print size", because two renditions are two files that
 * can be out of step — a company that replaces its logo and sees the old one
 * on its bills.
 *
 * WHY FLATTENED ONTO WHITE.
 *   - The PDF writer (lib/letterhead-pdf.ts) is written by hand and embeds the
 *     PNG's scanlines as they are. PDF has no alpha in an image stream; alpha
 *     would mean decoding, splitting out a soft mask and re-encoding.
 *   - A transparent logo with dark lettering disappears when Gmail or Outlook
 *     repaint an email dark. On its own white ground it survives.
 *   The header band it sits in is white in both renderers, so nothing shows.
 *
 * WHY 640x240. The email draws it at most 200px wide, so 2x for a phone's
 * screen is 400; the letterhead draws it at most 170pt wide, which at 250 dpi
 * is about 590. 640 covers both from one file that is still tens of kilobytes,
 * which matters because it rides inside every message.
 *
 * The original is NOT kept. Nothing reads it, and a second object per company
 * is a second thing to delete.
 */

const ACCEPTED = new Set(['png', 'jpeg', 'webp'])

export type NormalisedLogo = BrandLogo

export async function normaliseLogo(
  input: Uint8Array
): Promise<{ ok: true; logo: NormalisedLogo } | { ok: false; error: string }> {
  if (input.length === 0) return { ok: false, error: 'Choose an image to upload.' }
  if (input.length > LOGO_UPLOAD_MAX_BYTES) {
    return { ok: false, error: 'The image is larger than 512 KB. Export a smaller one and try again.' }
  }

  let format: string | undefined
  try {
    // limitInputPixels: a 512 KB file can still declare a 30,000 x 30,000
    // canvas. 16 megapixels is far past any logo and far short of a problem.
    format = (await sharp(input, { limitInputPixels: 16_000_000 }).metadata()).format
  } catch {
    return { ok: false, error: 'That file could not be read as an image.' }
  }
  // Decided from the bytes, not from the name or the type the browser claimed.
  if (!format || !ACCEPTED.has(format)) {
    return { ok: false, error: 'Upload a PNG, JPEG or WebP image.' }
  }

  let png: Uint8Array
  try {
    const out = await sharp(input, { limitInputPixels: 16_000_000 })
      .rotate() // honour a camera's orientation tag, then drop it
      .flatten({ background: '#ffffff' })
      .resize({
        width: LOGO_MAX_WIDTH, height: LOGO_MAX_HEIGHT,
        fit: 'inside', withoutEnlargement: true,
      })
      // Three 8-bit channels whatever came in: a greyscale or 16-bit source
      // would otherwise come out as a PNG the PDF writer has to special-case.
      .toColourspace('srgb')
      .png({ compressionLevel: 9, palette: false, progressive: false })
      .toBuffer()
    png = new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
  } catch {
    return { ok: false, error: 'That image could not be processed. Try exporting it again as a PNG.' }
  }

  // Checked, not assumed. If a sharp upgrade ever changes what the pipeline
  // above emits, this refuses the upload instead of storing a logo that the
  // letterhead will silently fail to draw.
  const header = readPngHeader(png)
  if (!isStoredLogoShape(header)) {
    return { ok: false, error: 'That image could not be converted to the stored format.' }
  }

  return { ok: true, logo: { png, width: header.width, height: header.height } }
}

/**
 * A small JPEG of the stored letterhead for the settings page, as a data URI.
 * The stored file is up to 2400 pixels wide and would weigh down every load of
 * General Settings inlined whole; the page only needs to show what it is.
 */
export async function letterheadPreviewUri(png: Uint8Array): Promise<string | null> {
  try {
    const out = await sharp(png).resize({ width: 900, withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer()
    return 'data:image/jpeg;base64,' + out.toString('base64')
  } catch {
    return null
  }
}

/**
 * The same treatment for a letterhead: one stored file, the shape the PDF
 * writer passes straight through, refused when it would print badly.
 *
 * REFUSED, NOT FIXED. An image the wrong shape for the zone is not cropped or
 * padded to fit: cropping cuts off somebody's address, and padding a square logo
 * to 7:1 is what the generated block already does better. The person is told
 * the size they uploaded and the size that works (lib/brand.ts#letterheadSizeError).
 *
 * Flattened onto white like the logo, and for the same reason: PDF image
 * streams carry no alpha, and the zone it sits in is the white page.
 */
export async function normaliseLetterhead(
  input: Uint8Array
): Promise<{ ok: true; letterhead: BrandLetterhead } | { ok: false; error: string }> {
  if (input.length === 0) return { ok: false, error: 'Choose an image to upload.' }
  if (input.length > LETTERHEAD_UPLOAD_MAX_BYTES) {
    return {
      ok: false,
      error: 'The image is larger than ' + Math.floor(LETTERHEAD_UPLOAD_MAX_BYTES / 1024) +
        ' KB. Export it as a JPEG, or as a PNG without transparency, and try again.',
    }
  }

  let meta: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>
  try {
    meta = await sharp(input, { limitInputPixels: 40_000_000 }).metadata()
  } catch {
    return { ok: false, error: 'That file could not be read as an image.' }
  }
  if (!meta.format || !ACCEPTED.has(meta.format)) {
    return { ok: false, error: 'Upload a PNG, JPEG or WebP image.' }
  }

  // EXIF orientations 5-8 are quarter turns: the image as it will be drawn is
  // the stored one with its sides swapped. Checked as drawn, not as stored.
  const turned = (meta.orientation ?? 1) >= 5
  const width = (turned ? meta.height : meta.width) ?? 0
  const height = (turned ? meta.width : meta.height) ?? 0
  const sizeError = letterheadSizeError(width, height)
  if (sizeError) return { ok: false, error: sizeError }

  let png: Uint8Array
  try {
    const out = await sharp(input, { limitInputPixels: 40_000_000 })
      .rotate()
      .flatten({ background: '#ffffff' })
      .resize({
        width: LETTERHEAD_MAX_WIDTH, height: LETTERHEAD_MAX_HEIGHT,
        fit: 'inside', withoutEnlargement: true,
      })
      .toColourspace('srgb')
      .png({ compressionLevel: 9, palette: false, progressive: false })
      .toBuffer()
    png = new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
  } catch {
    return { ok: false, error: 'That image could not be processed. Try exporting it again as a PNG or JPEG.' }
  }

  if (png.length > LETTERHEAD_STORED_MAX_BYTES) {
    return {
      ok: false,
      error: 'That image is too detailed to store as a letterhead (a photograph across the whole strip ' +
        'is the usual cause). Simplify the background, or export it at ' + LETTERHEAD_RECOMMENDED.width +
        ' x ' + LETTERHEAD_RECOMMENDED.height + ' px.',
    }
  }

  const header = readPngHeader(png)
  if (!isStoredLetterheadShape(header)) {
    return { ok: false, error: 'That image could not be converted to the stored format.' }
  }
  return { ok: true, letterhead: { png, width: header.width, height: header.height } }
}
