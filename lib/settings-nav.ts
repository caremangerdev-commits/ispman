import { can, type Permission, type Role } from '@/lib/permissions'

export type SettingsIcon =
  | 'building' | 'gauge' | 'package' | 'tags' | 'users' | 'userCog'

export type SettingsSection = {
  key: string
  label: string
  href: string
  icon: SettingsIcon
  description: string
  permission: Permission
  /** Needs migration 0005. */
  needsCatalog?: boolean
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
    description: 'Company profile, regional, billing and network defaults.',
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
    key: 'users',
    label: 'Users',
    href: '/dashboard/settings/users',
    icon: 'userCog',
    description: 'Staff accounts and the roles they hold.',
    permission: 'manage_users',
  },
]

/**
 * Sections a role may open.
 *
 * Driven purely by the permission map: `manage_company_settings` covers
 * super_admin, company_admin and manager, while Users sits behind
 * `manage_users` so managers cannot reach it.
 */
export function visibleSettings(role: Role): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((s) => can(role, s.permission))
}

export function canOpenSetting(role: Role, key: string): boolean {
  return visibleSettings(role).some((s) => s.key === key)
}
