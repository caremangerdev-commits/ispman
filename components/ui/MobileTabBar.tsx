'use client'

import { Menu, Users, Wallet } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { useShell } from '@/components/ui/Shell'

/**
 * The two things a cashier does standing at a customer's gate, plus the way
 * into everything else.
 *
 * Neither Find Customer nor Take Payment should be behind a drawer: they are
 * the whole job, they are done one-handed, and the drawer's trigger is in the
 * top-left corner — the furthest point on the screen from a right thumb. This
 * bar puts both in the thumb arc and leaves the drawer for the desk work.
 *
 * `lg:hidden`, so a desk user never sees it. Invisible to the print stylesheet
 * for free: it is not an ancestor of `.receipt-print`, so the `:has()` rule in
 * globals.css removes it from the printed page outright.
 */
export type TabBarItem = { href: string; label: string; icon: 'customers' | 'payment' }

const ICONS = { customers: Users, payment: Wallet }

export function MobileTabBar({ items }: { items: TabBarItem[] }) {
  const pathname = usePathname()
  const { setDrawerOpen } = useShell()

  // Nothing this role can reach here means nothing worth a bar; the drawer
  // alone is right for a manager who never takes money at a gate.
  if (items.length === 0) return null

  return (
    <nav
      aria-label="Quick actions"
      className={
        'fixed inset-x-0 bottom-0 z-30 grid border-t border-gray-800 bg-gray-900 lg:hidden ' +
        // The home indicator on a gesture-nav Android sits over the bottom
        // ~16px; without this the labels are underneath it.
        'pb-[env(safe-area-inset-bottom)] ' +
        (items.length === 1 ? 'grid-cols-2' : 'grid-cols-3')
      }
    >
      {items.map((item) => {
        const Icon = ICONS[item.icon]
        // Compared on the pathname alone, like the sidebar: /payments/new and
        // /customers are distinct pages, not query variants of one.
        const active = pathname === item.href

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={
              'flex min-h-14 flex-col items-center justify-center gap-1 px-2 py-2 text-[11px] font-medium transition ' +
              (active ? 'text-blue-400' : 'text-gray-400 active:bg-gray-800')
            }
          >
            <Icon className="h-5 w-5" aria-hidden />
            {item.label}
          </Link>
        )
      })}

      <button
        type="button"
        onClick={() => setDrawerOpen(true)}
        className="flex min-h-14 flex-col items-center justify-center gap-1 px-2 py-2 text-[11px] font-medium text-gray-400 transition active:bg-gray-800"
      >
        <Menu className="h-5 w-5" aria-hidden />
        Menu
      </button>
    </nav>
  )
}
