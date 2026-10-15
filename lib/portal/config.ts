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

/** The request header the proxy stamps the resolved slug onto. */
export const PORTAL_SLUG_HEADER = 'x-portal-slug'
