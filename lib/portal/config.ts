/**
 * Which host is a tenant portal, and which tenant.
 *
 * The portal answers on a subdomain per tenant: ezmze.<suffix>, jmedia.<suffix>,
 * where <suffix> is PORTAL_HOST_SUFFIX (e.g. ".pay.example.com"). The staff app
 * keeps the bare domain. One env, so the whole portal is inert until DNS is
 * pointed and the suffix is set — a safe closed default while the domain is TBC.
 *
 * This only extracts the slug from the host; whether a company actually owns
 * that slug is lib/data/portal.ts#companyBySlug, against the database.
 */

/** The configured portal suffix, normalised to a leading dot, or null. */
export function portalHostSuffix(): string | null {
  const raw = (process.env.PORTAL_HOST_SUFFIX ?? '').trim().toLowerCase()
  if (!raw) return null
  return raw.startsWith('.') ? raw : '.' + raw
}

/**
 * The tenant slug a host resolves to, or null when the host is not a tenant
 * portal (the staff app, or the suffix is unset).
 *
 * ezmze.pay.example.com with suffix .pay.example.com -> "ezmze".
 * A bare pay.example.com (the suffix itself, no label) is NOT a tenant and
 * returns null, so the apex can serve a landing page later without pretending
 * to be a company.
 */
export function portalSlugFromHost(host: string | null | undefined): string | null {
  const suffix = portalHostSuffix()
  if (!suffix || !host) return null

  // Strip any port, lowercase: "EZMZE.Pay.Example.com:443" -> "ezmze.pay.example.com".
  const h = host.trim().toLowerCase().split(':')[0]
  if (!h.endsWith(suffix)) return null

  const label = h.slice(0, -suffix.length)
  // One level only: a single label with no dots. "ezmze" yes, "a.b" no.
  if (!label || label.includes('.')) return null
  // Slugs are the same shape the migration backfills.
  if (!/^[a-z0-9-]+$/.test(label)) return null

  return label
}

/** The registrable portal domain — the suffix without its leading dot. */
export function portalBaseDomain(): string | null {
  const suffix = portalHostSuffix()
  return suffix ? suffix.slice(1) : null
}

/**
 * The customer-facing portal URL for a tenant slug, or null when the portal is
 * not configured (no suffix) or the company has no slug. Used in SMS so a
 * message is a tap into the right tenant's portal, not a URL to remember.
 */
export function portalUrlFor(slug: string | null | undefined): string | null {
  const suffix = portalHostSuffix()
  if (!suffix || !slug) return null
  return 'https://' + slug + suffix
}

/**
 * True for the portal apex AND every tenant subdomain under it — the whole set
 * of hosts that must go to the portal and never to staff auth.
 *
 * Requires a DOTTED base (a real domain like pay.ispman.online). In dev the base
 * is "localhost", where the bare staff host and the portal apex are the same
 * thing; gating on a dot keeps `localhost` routing to the staff app there while
 * tenant subdomains (ezmze.localhost) still match through portalSlugFromHost.
 */
export function isPortalHost(host: string | null | undefined): boolean {
  const base = portalBaseDomain()
  if (!base || !base.includes('.') || !host) return false
  const h = host.trim().toLowerCase().split(':')[0]
  return h === base || h.endsWith('.' + base)
}

/**
 * The host the client actually asked for.
 *
 * Behind Apache (ProxyPass to port 3000) the `Host` header can be the upstream
 * target, so the original host travels in `X-Forwarded-Host`; prefer it. Only
 * Apache can reach the app's port, so that header is not client-spoofable here.
 */
export function externalHost(headers: Headers): string | null {
  const xfh = headers.get('x-forwarded-host')
  const raw = (xfh ?? headers.get('host') ?? '').split(',')[0].trim()
  return raw || null
}

/** The request header the proxy stamps the resolved slug onto. */
export const PORTAL_SLUG_HEADER = 'x-portal-slug'
