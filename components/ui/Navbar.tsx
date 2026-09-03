import { PageTitle } from '@/components/ui/PageTitle'
import { GlobalSearch } from '@/components/ui/GlobalSearch'
import { NotificationBell } from '@/components/ui/NotificationBell'
import { UserMenu } from '@/components/ui/UserMenu'
import { initials } from '@/lib/format'
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

export function Navbar({
  userName,
  userEmail,
  userRole,
  notifications,
  unreadCount,
  topOffset = false,
}: NavbarProps) {
  const [first, last] = userName.split(' ')

  return (
    <header
      className={
        'fixed inset-x-0 left-64 z-20 flex h-16 items-center gap-4 border-b ' +
        'border-gray-800 bg-gray-900 px-6 ' + (topOffset ? 'top-11' : 'top-0')
      }
    >
      <PageTitle />

      <GlobalSearch />

      <div className="flex shrink-0 items-center gap-1">
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
