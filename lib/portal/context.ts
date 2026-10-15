import 'server-only'

import { headers } from 'next/headers'

import { companyBySlug, type PortalCompany } from '@/lib/data/portal'
import { PORTAL_SLUG_HEADER } from './config'

/**
 * The company this portal request belongs to, resolved from the slug the proxy
 * stamped on the request from the subdomain. Null when there is no slug (the
 * request did not come through a tenant subdomain) or no company owns it.
 *
 * Pages and server actions both read it from here, so the tenant is decided in
 * exactly one place, the way lib/session.ts decides it for staff.
 */
export async function getPortalCompany(): Promise<PortalCompany | null> {
  const slug = (await headers()).get(PORTAL_SLUG_HEADER)
  if (!slug) return null
  return companyBySlug(slug)
}
