import type { Role } from '@/lib/permissions'

/**
 * Where a role lands after signing in, and what "home" means for them.
 *
 * Single source of truth: the root page, the /dashboard guard and the sidebar
 * logo all read this, so a role's home is defined in exactly one place.
 *
 * NOTE ON THE PROXY: this cannot live in proxy.ts. The proxy runs on nearly
 * every request with only the Supabase auth session, which carries an email —
 * not a role. Resolving the role means querying the `users` table, so putting
 * it in the proxy would add a database round trip to every navigation, and
 * proxy.ts is explicitly documented as an optimistic check rather than an
 * authorization boundary. Instead the proxy sends a signed-in user to `/`, and
 * the root page (a server component that already has the session) routes them
 * here.
 */
export function homePathFor(
  profile: {
    role: Role
    is_super_admin: boolean
  },
  /**
   * True while a super admin is switched into a tenant (session.actingAs).
   *
   * Without this, "home" for them stays /superadmin, and the sidebar logo and
   * the root route would both throw them out of the tenant they just entered —
   * the switch would appear to drop itself on the first click.
   */
  isActingInTenant = false
): string {
  // Home while switched is the tenant they are acting in. The switch itself is
  // left alone: leaving the tenant is the banner's Exit button, deliberately,
  // so it is always a decision rather than a side effect of navigation.
  if (isActingInTenant) return '/dashboard'

  // Platform access is gated on the flag, not the role string — see
  // app/superadmin/layout.tsx. Keying on the role instead would bounce a
  // role:'super_admin' account with the flag off straight back out.
  if (profile.is_super_admin) return '/superadmin'

  // A cashier's whole job is taking payments, so the record-payment screen is
  // their home rather than a dashboard they have no KPI access to.
  if (profile.role === 'cashier') return '/dashboard/payments/new'

  return '/dashboard'
}

/** True when this role has no analytics dashboard of its own. */
export function skipsDashboard(role: Role): boolean {
  return role === 'cashier'
}
