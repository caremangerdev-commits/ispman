'use client'

import { Menu, PanelLeftClose, PanelLeftOpen } from 'lucide-react'

import { PageTitle } from '@/components/ui/PageTitle'
import { GlobalSearch } from '@/components/ui/GlobalSearch'
import { NotificationBell } from '@/components/ui/NotificationBell'
import { UserMenu } from '@/components/ui/UserMenu'
import { useShell } from '@/components/ui/Shell'
import { initials } from '@/lib/format'
import { SIDEBAR } from '@/lib/shell'
import type { NotificationRow } from '@/lib/types'

export type NavbarProps = {
  userName: string
  userEmail: string
  userRole: string
  notifications: NotificationRow[]
  unreadCount: number
  /**
   * Pushes this fixed header below the super admin "acting as" banner, which
   * is itself fixed to the very top. See components/platform/ActingBanner.tsx.
   */
  topOffset?: boolean
}

/**
 * A client component because its left edge follows the sidebar, which is state.
 * Everything it renders was already a client component; the props it takes were
 * already serialisable, so nothing crossed the boundary that did not before.
 */
export function Navbar({
  userName,
  userEmail,
  userRole,
  notifications,
  unreadCount,
  topOffset = false,
}: NavbarProps) {
  const [first, last] = userName.split(' ')
  const { setDrawerOpen, collapsed, toggleCollapsed } = useShell()

  return (
    <header
      className={
        'fixed inset-x-0 left-0 z-20 flex h-16 items-center gap-2 border-b ' +
        'border-gray-800 bg-gray-900 px-3 transition-[left] duration-200 sm:gap-4 lg:px-6 ' +
        (collapsed ? SIDEBAR.header.collapsed : SIDEBAR.header.expanded) + ' ' +
        (topOffset ? 'top-11' : 'top-0')
      }
    >
      {/* Opens the drawer. Below `lg` this is the ONLY way to the navigation
          other than the tab bar, so it is a 44px target, not an icon. */}
      <button
        type="button"
        onClick={() => setDrawerOpen(true)}
        aria-label="Open navigation"
        className="-ml-1 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-gray-400 transition hover:bg-gray-800 hover:text-white lg:hidden"
      >
        <Menu className="h-5 w-5" aria-hidden />
      </button>

      {/* The desktop counterpart: collapses the sidebar to an icon rail so a
          wide table gets the width back. */}
      <button
        type="button"
        onClick={toggleCollapsed}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-pressed={collapsed}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-lg text-gray-500 transition hover:bg-gray-800 hover:text-white lg:inline-flex"
      >
        {collapsed ? (
          <PanelLeftOpen className="h-4.5 w-4.5" aria-hidden />
        ) : (
          <PanelLeftClose className="h-4.5 w-4.5" aria-hidden />
        )}
      </button>

      {/* Hidden on the narrowest screens — the page's own heading says where
          you are, and the width is worth more to the search box. */}
      <span className="hidden sm:block">
        <PageTitle />
      </span>

      {/* Below `md` the tab bar's Find Customer is the way to a customer, and
          it lands on a page whose own search box is bigger than this one. */}
      <span className="hidden min-w-0 flex-1 md:block">
        <GlobalSearch />
      </span>

      <div className="ml-auto flex shrink-0 items-center gap-1 md:ml-0">
        <NotificationBell items={notifications} unread={unreadCount} />
        <UserMenu
          name={userName}
          email={userEmail}
          role={userRole}
          initials={initials(first, last)}
        />
      </div>
    </header>
  )
}
