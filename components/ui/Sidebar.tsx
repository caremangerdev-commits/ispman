'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  AlertTriangle, Building2, CalendarX2, CreditCard, FileText, Globe,
  LayoutDashboard, LifeBuoy, LogOut, MessageSquare, Network, Receipt, Router,
  Settings, Shield, Sliders, UserPlus, Users, UsersRound, Wifi, type LucideIcon,
} from 'lucide-react'

import { signOut } from '@/app/actions/auth'
import { initials } from '@/lib/format'
import type { IconKey, NavSection } from '@/lib/navigation'

const ICONS: Record<IconKey, LucideIcon> = {
  dashboard: LayoutDashboard,
  users: Users,
  userPlus: UserPlus,
  calendarX: CalendarX2,
  alertTriangle: AlertTriangle,
  creditCard: CreditCard,
  fileText: FileText,
  receipt: Receipt,
  network: Network,
  router: Router,
  lifeBuoy: LifeBuoy,
  messageSquare: MessageSquare,
  sliders: Sliders,
  settings: Settings,
  usersRound: UsersRound,
  building: Building2,
  globe: Globe,
  shield: Shield,
}

export type SidebarProps = {
  sections: NavSection[]
  companyName: string
  userName: string
  roleLabel: string
  /** This role's home — not always /dashboard. See lib/home.ts. */
  homeHref: string
}

export function Sidebar({
  sections, companyName, userName, roleLabel, homeHref,
}: SidebarProps) {
  const pathname = usePathname()
  const [first, last] = userName.split(' ')

  return (
    <aside className="fixed inset-y-0 left-0 z-30 flex w-64 flex-col border-r border-gray-800 bg-gray-900">
      {/* Logo doubles as the way home for roles whose nav has no Dashboard link. */}
      <Link
        href={homeHref}
        className="flex h-16 shrink-0 items-center gap-2.5 border-b border-gray-800 px-5 transition hover:bg-gray-800/40"
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600">
          <Wifi className="h-4.5 w-4.5 text-white" aria-hidden />
        </span>
        <span className="text-lg font-bold tracking-tight text-white">
          ISP<span className="text-blue-500">Man</span>
        </span>
      </Link>

      <nav className="flex-1 overflow-y-auto px-3 py-3" aria-label="Main">
        {sections.map((section) => (
          <div key={section.heading} className="mb-3">
            <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
              {section.heading}
            </p>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                // Compare pathname only: query-string links (Expired, Overdue)
                // share /dashboard/customers and must not all light up at once.
                const [path, qs] = item.href.split('?')
                const active = qs ? false : pathname === path
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={
                        'flex items-center gap-3 rounded-md border-l-2 px-3 py-1.5 text-sm transition ' +
                        (active
                          ? 'border-blue-500 bg-blue-500/10 font-medium text-blue-400'
                          : 'border-transparent text-gray-400 hover:bg-gray-800 hover:text-gray-200')
                      }
                    >
                      {(() => {
                        const Icon = ICONS[item.icon]
                        return <Icon className="h-4 w-4 shrink-0" aria-hidden />
                      })()}
                      {item.label}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="shrink-0 border-t border-gray-800 p-3">
        <div className="mb-3 flex items-center gap-2 rounded-md bg-gray-950/60 px-3 py-2">
          <Building2 className="h-4 w-4 shrink-0 text-gray-500" aria-hidden />
          <span className="truncate text-xs font-medium text-gray-300">{companyName}</span>
        </div>

        <div className="mb-2 flex items-center gap-3 px-1">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-semibold text-white">
            {initials(first, last)}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-gray-200">{userName}</span>
            <span className="block truncate text-xs text-gray-500">{roleLabel}</span>
          </span>
        </div>

        <form action={signOut}>
          <button
            type="submit"
            className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-gray-400 transition hover:bg-gray-800 hover:text-red-400"
          >
            <LogOut className="h-4 w-4" aria-hidden />
            Log out
          </button>
        </form>
      </div>
    </aside>
  )
}
