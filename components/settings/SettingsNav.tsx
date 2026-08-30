'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  ArrowLeft, Building2, Gauge, Package, Tags, UserCog, Users,
  type LucideIcon,
} from 'lucide-react'

import type { SettingsIcon, SettingsSection } from '@/lib/settings-nav'

const ICONS: Record<SettingsIcon, LucideIcon> = {
  building: Building2,
  gauge: Gauge,
  package: Package,
  tags: Tags,
  users: Users,
  userCog: UserCog,
}

export function SettingsNav({ sections }: { sections: SettingsSection[] }) {
  const pathname = usePathname()

  return (
    <nav className="w-56 shrink-0" aria-label="Settings">
      <Link
        href="/dashboard"
        className="mb-3 inline-flex items-center gap-1.5 text-xs font-medium text-gray-500 transition hover:text-gray-300"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Back to Dashboard
      </Link>

      <div className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900 p-2">
        <Link
          href="/dashboard/settings"
          aria-current={pathname === '/dashboard/settings' ? 'page' : undefined}
          className={
            'mb-1 block rounded-md px-3 py-2 text-sm transition ' +
            (pathname === '/dashboard/settings'
              ? 'bg-blue-500/10 font-medium text-blue-400'
              : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200')
          }
        >
          All Settings
        </Link>

        <ul className="space-y-0.5">
          {sections.map((s) => {
            const Icon = ICONS[s.icon]
            // startsWith, so a nested settings route keeps its parent lit.
            const active = pathname === s.href || pathname.startsWith(s.href + '/')
            return (
              <li key={s.key}>
                <Link
                  href={s.href}
                  aria-current={active ? 'page' : undefined}
                  className={
                    'flex items-center gap-2.5 rounded-md border-l-2 px-3 py-2 text-sm transition ' +
                    (active
                      ? 'border-blue-500 bg-blue-500/10 font-medium text-blue-400'
                      : 'border-transparent text-gray-400 hover:bg-gray-800 hover:text-gray-200')
                  }
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden />
                  {s.label}
                </Link>
              </li>
            )
          })}
        </ul>
      </div>
    </nav>
  )
}
