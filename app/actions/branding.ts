'use server'

import { revalidatePath } from 'next/cache'

import { logEvent } from '@/lib/audit'
import { DEFAULT_BRAND_COLOR, LOGO_UPLOAD_MAX_BYTES, normaliseBrandColor } from '@/lib/brand'
import { clearLogo, getBrandColor, storeLogo } from '@/lib/data/brand'
import { normaliseLogo } from '@/lib/logo'
import { can } from '@/lib/permissions'
import { getSchemaCapabilities } from '@/lib/schema'
import { getSession } from '@/lib/session'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * The Branding card's three actions: upload a logo, remove it, set the colour.
 *
 * SEPARATE FROM saveCompanyProfile ON PURPOSE. That form posts forty fields on
 * every save; a file input inside it would re-upload the logo each time
 * somebody changed the grace period, and one oversized image would fail the
 * whole settings save with a body-size error that names neither.
 *
 * Same gate as the rest of the page — company_admin only — and the company id
 * is the session's, never the form's: it becomes a storage path.
 *
 * EVERY CHANGE IS LOGGED. What customers see on their bills is worth being
 * able to answer "who changed it, and when" about.
 */

export type BrandingResult = { ok: true; message: string } | { ok: false; error: string }

const NOT_APPLIED = 'Branding is not set up on this system yet. Ask your administrator to apply migration 0023.'

async function guard() {
  const session = await getSession()
  if (!can(session.profile.role, 'manage_company_settings')) {
    throw new Error('Forbidden: role "' + session.profile.role + '" cannot edit company settings.')
  }
  return session
}

function revalidate() {
  revalidatePath('/dashboard/settings/company')
}

export async function uploadCompanyLogo(
  _prev: BrandingResult | null,
  formData: FormData
): Promise<BrandingResult> {
  const { company } = await guard()
  if (!(await getSchemaCapabilities()).branding) return { ok: false, error: NOT_APPLIED }

  const file = formData.get('logo')
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: 'Choose an image to upload.' }
  // Checked before the bytes are read into memory. The browser checks too, but
  // a server action is a public POST endpoint.
  if (file.size > LOGO_UPLOAD_MAX_BYTES) {
    return { ok: false, error: 'The image is larger than 512 KB. Export a smaller one and try again.' }
  }

  const normalised = await normaliseLogo(new Uint8Array(await file.arrayBuffer()))
  if (!normalised.ok) return { ok: false, error: normalised.error }

  const stored = await storeLogo(company.id, normalised.logo)
  if (!stored.ok) return { ok: false, error: stored.error }

  await logEvent({
    type: 'company_logo_updated',
    details: 'Company logo uploaded (' + normalised.logo.width + 'x' + normalised.logo.height + ')',
    tag: '[branding]',
  })

  revalidate()
  return { ok: true, message: 'Logo saved. It is on every email and document from now on.' }
}

export async function removeCompanyLogo(): Promise<BrandingResult> {
  const { company } = await guard()
  if (!(await getSchemaCapabilities()).branding) return { ok: false, error: NOT_APPLIED }

  const cleared = await clearLogo(company.id)
  if (!cleared.ok) return { ok: false, error: cleared.error }

  if (cleared.removed) {
    await logEvent({ type: 'company_logo_removed', details: 'Company logo removed', tag: '[branding]' })
  }

  revalidate()
  return { ok: true, message: 'Logo removed. Your company name is shown in its place.' }
}

export async function saveBrandColor(
  _prev: BrandingResult | null,
  formData: FormData
): Promise<BrandingResult> {
  const { company } = await guard()
  if (!(await getSchemaCapabilities()).branding) return { ok: false, error: NOT_APPLIED }

  // Empty means "back to the default", which is stored as NULL so that a later
  // change to the platform default reaches every company that never chose.
  const raw = formData.get('brand_color')
  const typed = typeof raw === 'string' ? raw.trim() : ''
  const color = typed ? normaliseBrandColor(typed) : null
  if (typed && !color) return { ok: false, error: 'Enter a colour as six hex digits, like #0f766e.' }

  const before = await getBrandColor(company.id)
  if (before === color) return { ok: true, message: 'Brand colour saved.' }

  const db = tenantClient()
  const { data: existing } = await db
    .from('settings').select('id').eq('company_id', company.id).maybeSingle()

  const { error } = existing
    ? await db.from('settings').update({ brand_color: color }).eq('company_id', company.id)
    : await db.from('settings').insert({ company_id: company.id, brand_color: color })
  if (error) return { ok: false, error: 'Could not save the colour: ' + error.message }

  await logEvent({
    type: 'brand_color_changed',
    details:
      'Brand colour changed from ' + (before ?? 'the default (' + DEFAULT_BRAND_COLOR + ')') +
      ' to ' + (color ?? 'the default (' + DEFAULT_BRAND_COLOR + ')'),
    tag: '[branding]',
  })

  revalidate()
  return { ok: true, message: 'Brand colour saved.' }
}
