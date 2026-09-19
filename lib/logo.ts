import 'server-only'

import sharp from 'sharp'

import {
  isStoredLogoShape, LOGO_MAX_HEIGHT, LOGO_MAX_WIDTH, LOGO_UPLOAD_MAX_BYTES, readPngHeader,
  type BrandLogo,
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
