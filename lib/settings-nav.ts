import { can, type Permission, type Role } from '@/lib/permissions'

export type SettingsIcon =
  | 'building' | 'gauge' | 'package' | 'tags' | 'users' | 'userCog' | 'messageSquare' | 'receipt'
  | 'network' | 'creditCard' | 'fileText'

/** The headings the Settings page groups its cards under, in order. */
export const SETTINGS_GROUPS = [
  { key: 'company', label: 'Company and staff' },
  { key: 'billing', label: 'Billing and payments' },
  { key: 'plans', label: 'Plans and services' },
  { key: 'network', label: 'Network and messages' },
] as const
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number]['key']

export type SettingsSection = {
  key: string
  group: SettingsGroup
  label: string
  href: string
  icon: SettingsIcon
  description: string
  permission: Permission
  /** Needs migration 0005. */
  needsCatalog?: boolean
  /** Needs migration 0021. */
  needsSms?: boolean
  /** Needs migration 0033. */
  needsTunnels?: boolean
  /** Needs migration 0034. */
  needsGateways?: boolean
}

/**
 * Shared between the settings mini-nav and the landing cards so the two can
 * never drift out of step.
 */
export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    key: 'company',
    group: 'company',
    label: 'General Settings',
    href: '/dashboard/settings/company',
    icon: 'building',
    description: 'Company name, logo and colours, time zone, currency and network settings.',
    permission: 'manage_company_settings',
  },
  {
    key: 'billing',
    group: 'billing',
    label: 'Billing',
    href: '/dashboard/settings/billing',
    icon: 'receipt',
    description: 'When bills run, the bill and cut-off days, the first month, and rates.',
    permission: 'manage_company_settings',
  },
  {
    // How the bill LOOKS and what only it says — "Bills" read like a list of
    // them (owner, 21 Oct 2026). Logo, colour and letterhead are the company's
    // identity everywhere, so they stay in General's Branding card.
    key: 'bill-design',
    group: 'billing',
    label: 'Bill Design',
    href: '/dashboard/settings/bill-design',
    icon: 'fileText',
    description: 'How bills look, tax details, invoice numbers, bank details and emailing bills.',
    permission: 'manage_company_settings',
  },
  {
    key: 'service-plans',
    group: 'plans',
    label: 'Service Plans',
    href: '/dashboard/settings/service-plans',
    icon: 'gauge',
    description: 'Internet plans, their speeds and monthly prices.',
    permission: 'manage_company_settings',
    needsCatalog: true,
  },
  {
    key: 'additional-services',
    group: 'plans',
    label: 'Additional Services',
    href: '/dashboard/settings/additional-services',
    icon: 'package',
    description: 'Add-ons such as TV, telephone or a static IP.',
    permission: 'manage_company_settings',
    needsCatalog: true,
  },
  {
    key: 'misc-categories',
    group: 'company',
    label: 'Misc Categories',
    href: '/dashboard/settings/misc-categories',
    icon: 'tags',
    description: 'Group customers as school, hotel, government and so on.',
    permission: 'manage_company_settings',
    needsCatalog: true,
  },
  {
    key: 'sms',
    group: 'network',
    label: 'Notifications',
    href: '/dashboard/settings/sms',
    icon: 'messageSquare',
    description: 'SMS and email to customers: which messages go, how, and what they say.',
    permission: 'manage_company_settings',
    needsSms: true,
  },
  {
    key: 'payments',
    group: 'billing',
    label: 'Online Payments',
    href: '/dashboard/settings/payments',
    icon: 'creditCard',
    description: 'Card payments from the customer portal, through Fygaro.',
    permission: 'manage_company_settings',
    needsGateways: true,
  },
  {
    key: 'users',
    group: 'company',
    label: 'Users',
    href: '/dashboard/settings/users',
    icon: 'userCog',
    description: 'Staff accounts and what each one can do.',
    permission: 'manage_users',
  },
  {
    key: 'tunnels',
    group: 'network',
    label: 'Router Tunnels',
    href: '/dashboard/settings/tunnels',
    icon: 'network',
    description: 'The secure link from each of your routers to ISPMan.',
    permission: 'manage_router_tunnels',
    needsTunnels: true,
  },
]

/**
 * Sections a role may open.
 *
 * Driven purely by the permission map, and that is the only rule — the sidebar,
 * this nav, the page guard and the server actions all read the same permission,
 * so granting a role `manage_users` opens every one of them at once. Do not add
 * a second check anywhere.
 *
 * `manage_company_settings` and `manage_users` both currently cover super_admin,
 * company_admin and manager.
 */
export function visibleSettings(role: Role): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((s) => can(role, s.permission))
}

export function canOpenSetting(role: Role, key: string): boolean {
  return visibleSettings(role).some((s) => s.key === key)
}
