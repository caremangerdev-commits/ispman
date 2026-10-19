import type { CSSProperties } from 'react'

import type { BrandPalette } from '@/lib/brand'

/**
 * A tenant's brand as the PORTAL UI needs it: the palette and whether a logo
 * exists — never the logo bytes. The bytes stream from /api/portal/logo, so the
 * private bucket keeps its no-URL invariant and the browser can cache the image
 * across page navigations. lib/data/brand.ts#brandFor stays the one reader that
 * embeds bytes (email, PDF, that endpoint); this is display metadata only.
 *
 * NO DIRECTIVE: plain types and a helper, used by server pages and client
 * forms alike.
 */
export type PortalBrand = { name: string; palette: BrandPalette; hasLogo: boolean }

/**
 * The two custom properties every portal colour that belongs to the tenant
 * reads (components/portal/portal.module.css). `--brand-ink` is the palette's
 * onAccent — white or dark, whichever reads on the brand — so a pale yellow
 * tenant gets dark text on its band and buttons and a navy one gets white,
 * without any page deciding it.
 */
export function brandVars(palette: BrandPalette): CSSProperties {
  return { '--brand': palette.accent, '--brand-ink': palette.onAccent } as CSSProperties
}
