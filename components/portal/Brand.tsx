import type { BrandPalette } from '@/lib/brand'

/**
 * A tenant's brand as the PORTAL UI needs it: the palette and whether a logo
 * exists — never the logo bytes. The bytes stream from /api/portal/logo, so the
 * private bucket keeps its no-URL invariant and the browser can cache the image
 * across page navigations. lib/data/brand.ts#brandFor stays the one reader that
 * embeds bytes (email, PDF, that endpoint); this is display metadata only.
 *
 * NO directive: a plain presentational component, rendered on the server by the
 * portal pages and inside the client sign-in / composer forms alike.
 */
export type PortalBrand = { name: string; palette: BrandPalette; hasLogo: boolean }

/** The company's logo if it has one, else its name set in the readable ink colour. */
export function PortalWordmark({ brand, className }: { brand: PortalBrand; className?: string }) {
  if (brand.hasLogo) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- streamed from a private bucket via /api/portal/logo; there is no static URL for next/image
      <img
        src="/api/portal/logo"
        alt={brand.name}
        className={'h-9 w-auto max-w-[70%] object-contain ' + (className ?? '')}
      />
    )
  }
  return (
    <span className={'truncate text-lg font-bold ' + (className ?? '')} style={{ color: brand.palette.ink }}>
      {brand.name}
    </span>
  )
}

/**
 * The brand-colour rule beneath a header — the same motif the email shell and
 * the PDF letterhead draw, so a customer sees one brand across every channel.
 * Decorative: it uses the raw accent (a pale brand reads faint here, exactly as
 * it does on the letterhead), while text uses the contrast-safe ink.
 */
export function BrandRule({ brand }: { brand: PortalBrand }) {
  return <div className="h-0.5 w-full rounded-full" style={{ backgroundColor: brand.palette.accent }} />
}

/**
 * The className for a primary, brand-filled button. The caller adds
 * `style={{ backgroundColor: palette.accent, color: palette.onAccent }}` —
 * onAccent is already the readable choice (white, or dark on a pale brand), so
 * the button is never unreadable whatever colour a tenant picks.
 */
export const primaryButtonClass =
  'w-full rounded-xl px-4 py-4 text-lg font-semibold transition active:opacity-90 disabled:opacity-50'
