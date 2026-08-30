import { Suspense, type ReactNode } from 'react'

import { Navbar } from '@/components/ui/Navbar'
import { PageHeading } from '@/components/ui/PageHeading'
import { getGeneralSettings } from '@/lib/data/company'
import { Sidebar } from '@/components/ui/Sidebar'
import { Toast } from '@/components/ui/Toast'
import { getNotifications } from '@/lib/data/dashboard'
import { homePathFor } from '@/lib/home'
import { visibleNav } from '@/lib/navigation'
import { ROLE_LABELS } from '@/lib/permissions'
import { displayName, getSession } from '@/lib/session'

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  // proxy.ts already performed an optimistic redirect; this is the real
  // authorization boundary. It resolves both the tenant that scopes every
  // query below and the role that decides what navigation renders.
  const { profile, company, authUser } = await getSession()
  const [{ items, unread }, settings] = await Promise.all([
    getNotifications(company.id),
    getGeneralSettings(company.id),
  ])

  const name = displayName(profile)

  return (
    <div className="min-h-screen bg-gray-950">
      <Sidebar
        sections={visibleNav(profile.role)}
        companyName={company.name}
        userName={name}
        roleLabel={ROLE_LABELS[profile.role]}
        homeHref={homePathFor(profile)}
      />

      <Navbar
        userName={name}
        userEmail={authUser.email ?? profile.email}
        userRole={ROLE_LABELS[profile.role]}
        notifications={items}
        unreadCount={unread}
      />

      <main className="ml-64 pt-16">
        <div className="p-6">
          {/* Same heading on every page: company + department large, who is
              signed in beneath it. */}
          <PageHeading
            companyName={company.name}
            userName={name}
            roleLabel={ROLE_LABELS[profile.role]}
            timezone={settings.timezone}
          />
          {children}
        </div>
      </main>

      {/* Reads ?toast= from the URL, so it needs a Suspense boundary. */}
      <Suspense fallback={null}>
        <Toast />
      </Suspense>
    </div>
  )
}
