import { Breadcrumb } from '@/components/ui/Breadcrumb'
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
}

export function Navbar({
  userName,
  userEmail,
  userRole,
  notifications,
  unreadCount,
}: NavbarProps) {
  const [first, last] = userName.split(' ')

  return (
    <header className="fixed inset-x-0 left-64 top-0 z-20 flex h-16 items-center gap-4 border-b border-gray-800 bg-gray-900 px-6">
      <Breadcrumb />

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
