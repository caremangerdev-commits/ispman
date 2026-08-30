import { can, canAny, type Permission, type Role } from '@/lib/permissions'

/**
 * Icon keys rather than component references, because the filtered nav is
 * built on the server and passed to a client component — React can only
 * serialize plain data across that boundary.
 */
export type IconKey =
  | 'dashboard' | 'users' | 'userPlus' | 'calendarX' | 'alertTriangle'
  | 'creditCard' | 'fileText' | 'receipt' | 'network' | 'router'
  | 'lifeBuoy' | 'sliders' | 'settings' | 'usersRound' | 'building'
  | 'globe' | 'shield'

export type NavItem = {
  label: string
  href: string
  icon: IconKey
  permission: Permission
}

export type NavSection = {
  heading: string
  /** Section is hidden unless the role holds at least one of these. */
  requireAny: Permission[]
  items: NavItem[]
}

const SECTIONS: NavSection[] = [
  {
    heading: 'Main',
    requireAny: ['view_dashboard_kpis'],
    items: [
      { label: 'Dashboard', href: '/dashboard', icon: 'dashboard', permission: 'view_dashboard_kpis' },
    ],
  },
  {
    heading: 'Customers',
    requireAny: ['view_customer_list', 'add_customer'],
    items: [
      { label: 'All Customers', href: '/dashboard/customers', icon: 'users', permission: 'view_customer_list' },
      { label: 'Add Customer', href: '/dashboard/customers/new', icon: 'userPlus', permission: 'add_customer' },
      { label: 'Expired', href: '/dashboard/customers?filter=expired', icon: 'calendarX', permission: 'view_customer_list' },
      { label: 'Disconnected', href: '/dashboard/customers?filter=disconnected', icon: 'alertTriangle', permission: 'view_customer_list' },
    ],
  },
  {
    heading: 'Billing',
    requireAny: ['view_all_payments', 'record_payment', 'view_checkoff'],
    items: [
      { label: 'Payments', href: '/dashboard/payments', icon: 'creditCard', permission: 'view_all_payments' },
      { label: 'Record Payment', href: '/dashboard/payments/new', icon: 'receipt', permission: 'record_payment' },
      { label: 'Checkoff', href: '/dashboard/checkoff', icon: 'fileText', permission: 'view_checkoff' },
    ],
  },
  {
    heading: 'Admin',
    requireAny: ['manage_users', 'manage_company_settings'],
    items: [
      // Staff accounts live under Settings; there is no separate /dashboard/users.
      { label: 'Users', href: '/dashboard/settings/users', icon: 'usersRound', permission: 'manage_users' },
      { label: 'Settings', href: '/dashboard/settings', icon: 'settings', permission: 'manage_company_settings' },
    ],
  },
  {
    heading: 'Super Admin',
    requireAny: ['view_super_admin_dashboard'],
    items: [
      { label: 'Platform Overview', href: '/superadmin', icon: 'globe', permission: 'view_super_admin_dashboard' },
    ],
  },
]

/**
 * The sections and items a role may see.
 *
 * A section survives only if the role holds one of its `requireAny`
 * permissions AND at least one of its items is individually permitted — so a
 * heading never renders above an empty list.
 */
/**
 * The section heading a route belongs to — "Billing", "Customers" and so on.
 *
 * Matched against the unfiltered section list rather than a role's visible nav,
 * so the page header names the same department whoever is looking at it. The
 * longest matching href wins, so /dashboard/payments/new resolves to Billing
 * via Record Payment rather than stopping at /dashboard.
 */
export function sectionForPath(pathname: string): string | null {
  let best: { heading: string; length: number } | null = null

  for (const section of SECTIONS) {
    for (const item of section.items) {
      const path = item.href.split('?')[0]
      const matches = pathname === path || pathname.startsWith(path + '/')
      if (!matches) continue
      if (!best || path.length > best.length) {
        best = { heading: section.heading, length: path.length }
      }
    }
  }

  return best?.heading ?? null
}

export function visibleNav(role: Role): NavSection[] {
  const sections = SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => can(role, item.permission)),
  })).filter((section) => canAny(role, section.requireAny) && section.items.length > 0)

  // A cashier's home is Record Payment (see lib/home.ts), so it leads their
  // nav rather than sitting under the payments history link. They have no
  // Dashboard entry at all — that item needs view_dashboard_kpis, which the
  // role does not hold, so it is already filtered out above.
  if (role === 'cashier') {
    return sections.map((section) =>
      section.heading === 'Billing'
        ? {
            ...section,
            items: [...section.items].sort((a, b) =>
              a.href === '/dashboard/payments/new' ? -1
                : b.href === '/dashboard/payments/new' ? 1
                : 0
            ),
          }
        : section
    )
  }

  return sections
}
