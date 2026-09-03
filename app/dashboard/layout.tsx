import { Suspense, type ReactNode } from 'react'

import { ActingBanner, ACTING_BANNER_OFFSET } from '@/components/platform/ActingBanner'
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
  //
  // `company` is the ACTING company: for a verified super admin who has entered
  // a tenant it is that tenant, and everything below — nav, notifications,
  // settings, every page — follows it. `profile` is untouched by the switch, so
  // the operator is still themselves, with their own role and their own user id.
  const { profile, company, authUser, actingAs } = await getSession()
  const [{ items, unread }, settings] = await Promise.all([
    getNotifications(company.id),
    getGeneralSettings(company.id),
  ])

  const name = displayName(profile)
  const acting = actingAs !== null

  return (
    <div className="min-h-screen bg-gray-950">
      {/* In the layout, so it is on every dashboard page rather than only the
          one the operator entered on. */}
      {actingAs ? <ActingBanner company={actingAs} /> : null}

      <Sidebar
        sections={visibleNav(profile.role)}
        companyName={company.name}
        userName={name}
        roleLabel={ROLE_LABELS[profile.role]}
        // While switched, home is the tenant — otherwise the logo would throw
        // a super admin straight back out to /superadmin. See lib/home.ts.
        homeHref={homePathFor(profile, acting)}
        topOffset={acting}
      />

      <Navbar
        userName={name}
        userEmail={authUser.email ?? profile.email}
        userRole={ROLE_LABELS[profile.role]}
        notifications={items}
        unreadCount={unread}
        topOffset={acting}
      />

      <main className={'ml-64 ' + (acting ? ACTING_BANNER_OFFSET.navbarAndBanner : 'pt-16')}>
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
