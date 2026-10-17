import 'server-only'

import type { PortalBrand } from '@/components/portal/Brand'
import { brandPalette } from '@/lib/brand'
import { getSchemaCapabilities } from '@/lib/schema'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * The tenant's brand for a portal PAGE: the palette and whether a logo exists.
 *
 * Deliberately does NOT download the logo. The page only needs to know a logo
 * is there (to render the <img> instead of the wordmark); the bytes stream from
 * /api/portal/logo, which the browser caches, rather than being re-fetched from
 * storage on every page render. brandFor() remains the one reader that embeds
 * bytes — this is a lighter, display-only read of the same two columns.
 *
 * Never throws for a missing piece: no branding migration, no row, no colour
 * each reads as "the default colour, no logo", the correct closed default.
 */
export async function getPortalBrand(companyId: number, companyName: string): Promise<PortalBrand> {
  const caps = await getSchemaCapabilities()
  if (!caps.branding) {
    return { name: companyName, palette: brandPalette(null), hasLogo: false }
  }

  const { data } = await tenantClient()
    .from('settings')
    .select('brand_color, logo_path')
    .eq('company_id', companyId)
    .maybeSingle()

  const row = (data as { brand_color?: string | null; logo_path?: string | null } | null) ?? null
  return {
    name: companyName,
    palette: brandPalette(row?.brand_color),
    hasLogo: Boolean(row?.logo_path),
  }
}
