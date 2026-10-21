import { can, type Permission, type Role } from '@/lib/permissions'

export type SettingsIcon =
  | 'building' | 'gauge' | 'package' | 'tags' | 'users' | 'userCog' | 'messageSquare' | 'receipt'
  | 'network' | 'creditCard' | 'fileText'

export type SettingsSection = {
  key: string
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
    label: 'General Settings',
    href: '/dashboard/settings/company',
    icon: 'building',
    description: 'Company profile, branding, regional and network settings.',
    permission: 'manage_company_settings',
  },
  {
    key: 'billing',
    label: 'Billing',
    href: '/dashboard/settings/billing',
    icon: 'receipt',
    description: 'Billing model and engine, bill and cut-off days, first period, rates and thresholds.',
    permission: 'manage_company_settings',
  },
  {
    // How the bill LOOKS and what only it says — "Bills" read like a list of
    // them (owner, 21 Oct 2026). Logo, colour and letterhead are the company's
    // identity everywhere, so they stay in General's Branding card.
    key: 'bill-design',
    label: 'Bill Design',
    href: '/dashboard/settings/bill-design',
    icon: 'fileText',
    description: 'The bill template (Statement, Ledger or Receipt), tax line and rate, tax and registration numbers, invoice prefix, bank details, and emailing bills.',
    permission: 'manage_company_settings',
  },
  {
    key: 'service-plans',
    label: 'Service Plans',
    href: '/dashboard/settings/service-plans',
    icon: 'gauge',
    description: 'Speed tiers and their monthly pricing.',
    permission: 'manage_company_settings',
    needsCatalog: true,
  },
  {
    key: 'additional-services',
    label: 'Additional Services',
    href: '/dashboard/settings/additional-services',
    icon: 'package',
    description: 'Add-ons such as TV, telephone or a static IP.',
    permission: 'manage_company_settings',
    needsCatalog: true,
  },
  {
    key: 'misc-categories',
    label: 'Misc Categories',
    href: '/dashboard/settings/misc-categories',
    icon: 'tags',
    description: 'Classify customers as school, hotel, government and so on.',
    permission: 'manage_company_settings',
    needsCatalog: true,
  },
  {
    key: 'sms',
    label: 'Notifications',
    href: '/dashboard/settings/sms',
    icon: 'messageSquare',
    description: 'SMS and email: pair a phone, choose which messages send and by which channel, and edit their wording.',
    permission: 'manage_company_settings',
    needsSms: true,
  },
  {
    key: 'payments',
    label: 'Online Payments',
    href: '/dashboard/settings/payments',
    icon: 'creditCard',
    description: 'The Fygaro gateway that takes card payments from the portal: credentials, the webhook URL, and the on/off switch.',
    permission: 'manage_company_settings',
    needsGateways: true,
  },
  {
    key: 'users',
    label: 'Users',
    href: '/dashboard/settings/users',
    icon: 'userCog',
    description: 'Staff accounts and the roles they hold.',
    permission: 'manage_users',
  },
  {
    key: 'tunnels',
    label: 'Router Tunnels',
    href: '/dashboard/settings/tunnels',
    icon: 'network',
    description: "WireGuard tunnels that carry each router's RADIUS to the server, from an address that never changes.",
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
