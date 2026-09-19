import 'server-only'

import {
  brandPalette, isStoredLogoShape, normaliseBrandColor, readPngHeader,
  type Brand, type BrandLogo,
} from '@/lib/brand'
import { getSchemaCapabilities } from '@/lib/schema'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * Loading and storing a company's brand.
 *
 * brandFor() IS THE ONLY READER. The email shell and the PDF letterhead are
 * both handed what it returns; neither goes to `settings` or to the bucket
 * itself. A second reader would be a second opinion about what "no logo" or
 * "no colour" means, and those are exactly the cases that would differ.
 *
 * THE BUCKET IS PRIVATE AND STAYS THAT WAY. Nothing here ever produces a URL.
 * An email carries the logo's bytes inline (CID), a PDF embeds them, and the
 * settings page is handed them as a data URI by the server — so there is no
 * link to expire, to be blocked by Outlook, or to be forwarded.
 *
 * Every path is built from a company id THE CALLER RESOLVED FROM A SESSION (or
 * from the dispatcher's own walk over `companies`). Never from the client: the
 * service role has no policy backstop here, as lib/supabase/tenant.ts says of
 * table reads.
 */

export const BRAND_BUCKET = 'company-assets'

type BrandSettingsRow = { logo_path?: string | null; brand_color?: string | null }

type CompanyRow = {
  name: string | null
  email: string | null
  phone: string | null
  address: string | null
}

/** The object path for a company's new logo. Timestamped: see migration 0023. */
function newLogoPath(companyId: number): string {
  return companyId + '/logo-' + Date.now() + '.png'
}

/**
 * Whether a stored path belongs to this company.
 *
 * `logo_path` is only ever written by storeLogo() below, so this should always
 * hold. It is checked anyway, because the alternative is trusting a text
 * column to decide which tenant's object the service role downloads.
 */
function ownsPath(companyId: number, path: string): boolean {
  return path.startsWith(companyId + '/') && !path.includes('..')
}

async function downloadLogo(companyId: number, path: string): Promise<BrandLogo | null> {
  if (!ownsPath(companyId, path)) {
    console.error('[brand] company %d has a logo_path outside its own folder: %s', companyId, path)
    return null
  }

  const { data, error } = await tenantClient().storage.from(BRAND_BUCKET).download(path)
  if (error || !data) {
    console.error('[brand] could not download %s: %s', path, error?.message ?? 'no data')
    return null
  }

  const png = new Uint8Array(await data.arrayBuffer())
  const header = readPngHeader(png)
  // Re-checked on the way out as well as on the way in: the letterhead embeds
  // these bytes without decoding them, so the wrong shape must become "no
  // logo" here rather than a corrupt PDF there.
  if (!isStoredLogoShape(header)) {
    console.error('[brand] %s is not in the stored logo format; using the wordmark', path)
    return null
  }
  return { png, width: header.width, height: header.height }
}

/**
 * A company's brand, complete. NEVER THROWS FOR A MISSING PIECE.
 *
 * No logo, a logo that will not download, no colour, migration 0023 not
 * applied: each of those is the wordmark in the default colour, not an error.
 * A payment receipt must not fail to send because a PNG could not be fetched.
 */
export async function brandFor(companyId: number): Promise<Brand> {
  const caps = await getSchemaCapabilities()
  const db = tenantClient()

  const [companyRes, settingsRes] = await Promise.all([
    db.from('companies').select('name, email, phone, address').eq('id', companyId).maybeSingle(),
    caps.branding
      ? db.from('settings').select('logo_path, brand_color').eq('company_id', companyId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ])

  if (settingsRes.error) {
    console.error('[brand] settings read failed for company %d: %s', companyId, settingsRes.error.message)
  }

  const company = (companyRes.data as unknown as CompanyRow | null) ?? null
  const settings = (settingsRes.data as unknown as BrandSettingsRow | null) ?? null

  const logo = settings?.logo_path ? await downloadLogo(companyId, settings.logo_path) : null

  return {
    name: (company?.name ?? '').trim(),
    logo,
    palette: brandPalette(settings?.brand_color),
    contact: {
      address: company?.address?.trim() || null,
      phone: company?.phone?.trim() || null,
      email: company?.email?.trim() || null,
    },
  }
}

/** The chosen colour as stored, or null for "the default". For the Branding card. */
export async function getBrandColor(companyId: number): Promise<string | null> {
  const caps = await getSchemaCapabilities()
  if (!caps.branding) return null
  const { data } = await tenantClient()
    .from('settings').select('brand_color').eq('company_id', companyId).maybeSingle()
  return normaliseBrandColor((data as BrandSettingsRow | null)?.brand_color)
}

/**
 * Stores a normalised logo and points the company at it.
 *
 * NEW OBJECT, THEN THE POINTER, THEN DELETE THE OLD ONE — in that order, so
 * every moment in between has a `logo_path` that names an object that exists.
 * A failure after the upload leaves an orphan object, which costs a few
 * kilobytes; the other order would leave a company pointing at nothing.
 */
export async function storeLogo(
  companyId: number,
  logo: BrandLogo
): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = tenantClient()
  const storage = db.storage.from(BRAND_BUCKET)

  const { data: before } = await db
    .from('settings').select('logo_path').eq('company_id', companyId).maybeSingle()
  const oldPath = (before as BrandSettingsRow | null)?.logo_path ?? null

  const path = newLogoPath(companyId)
  const { error: uploadError } = await storage.upload(path, logo.png, {
    contentType: 'image/png',
    upsert: false,
  })
  if (uploadError) {
    const missing = /bucket not found/i.test(uploadError.message)
    return {
      ok: false,
      error: missing
        ? 'Logo storage is not set up on this system yet. Ask your administrator to apply migration 0023.'
        : 'Could not store the logo: ' + uploadError.message,
    }
  }

  const { data: updated, error: updateError } = await db
    .from('settings').update({ logo_path: path }).eq('company_id', companyId).select('id')
  if (updateError || !updated || updated.length === 0) {
    await storage.remove([path])
    return {
      ok: false,
      error: updateError
        ? 'Could not save the logo: ' + updateError.message
        : 'Save your company settings once before adding a logo.',
    }
  }

  if (oldPath && oldPath !== path && ownsPath(companyId, oldPath)) {
    const { error } = await storage.remove([oldPath])
    if (error) console.error('[brand] could not delete the replaced logo %s: %s', oldPath, error.message)
  }
  return { ok: true }
}

/** Removes the logo. The pointer first: a company must never name a deleted object. */
export async function clearLogo(
  companyId: number
): Promise<{ ok: true; removed: boolean } | { ok: false; error: string }> {
  const db = tenantClient()

  const { data: before } = await db
    .from('settings').select('logo_path').eq('company_id', companyId).maybeSingle()
  const oldPath = (before as BrandSettingsRow | null)?.logo_path ?? null
  if (!oldPath) return { ok: true, removed: false }

  const { error } = await db.from('settings').update({ logo_path: null }).eq('company_id', companyId)
  if (error) return { ok: false, error: 'Could not remove the logo: ' + error.message }

  if (ownsPath(companyId, oldPath)) {
    const { error: removeError } = await db.storage.from(BRAND_BUCKET).remove([oldPath])
    if (removeError) console.error('[brand] could not delete %s: %s', oldPath, removeError.message)
  }
  return { ok: true, removed: true }
}
