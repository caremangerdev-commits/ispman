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
  | 'globe' | 'shield' | 'messageSquare'

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
    heading: 'Support',
    requireAny: ['view_support_tickets', 'create_ticket'],
    items: [
      { label: 'Tickets', href: '/dashboard/tickets', icon: 'lifeBuoy', permission: 'view_support_tickets' },
      { label: 'New Ticket', href: '/dashboard/tickets/new', icon: 'messageSquare', permission: 'create_ticket' },
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
 * The title shown in the header bar for a route.
 *
 * A static table of section titles, deliberately not record names — a customer
 * page reads "Customer Details" rather than the customer's name. Entries are
 * tried in order, so /dashboard/customers/new is matched before the [id] entry
 * that would otherwise swallow it.
 */
const TITLES: { match: RegExp; title: string }[] = [
  { match: /^\/dashboard\/customers\/new$/, title: 'Add Customer' },
  { match: /^\/dashboard\/customers\/[^/]+$/, title: 'Customer Details' },
  { match: /^\/dashboard\/customers$/, title: 'Customers' },
  { match: /^\/dashboard\/payments\/new$/, title: 'Record Payment' },
  { match: /^\/dashboard\/payments\/[^/]+$/, title: 'Payment Details' },
  { match: /^\/dashboard\/payments$/, title: 'Payments' },
  { match: /^\/dashboard\/tickets\/new$/, title: 'New Ticket' },
  { match: /^\/dashboard\/tickets\/[^/]+$/, title: 'Ticket Details' },
  { match: /^\/dashboard\/tickets$/, title: 'Tickets' },
  { match: /^\/dashboard\/checkoff/, title: 'Checkoff' },
  { match: /^\/dashboard\/settings/, title: 'Settings' },
  { match: /^\/dashboard$/, title: 'Dashboard' },
]

export function titleForPath(pathname: string): string {
  return TITLES.find((t) => t.match.test(pathname))?.title ?? 'Dashboard'
}

/**
 * The sections and items a role may see.
 *
 * A section survives only if the role holds one of its `requireAny`
 * permissions AND at least one of its items is individually permitted — so a
 * heading never renders above an empty list.
 */
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
