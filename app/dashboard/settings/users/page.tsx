import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { UsersManager } from '@/components/settings/UsersManager'
import { ASSIGNABLE_ROLES, listCompanyUsers } from '@/lib/data/users'
import { getSession } from '@/lib/session'
import { canOpenSetting } from '@/lib/settings-nav'

export const metadata: Metadata = { title: 'Users · ISPMan' }

/** Same rule as the nav, so the URL cannot be used to bypass the menu. */
async function guard() {
  const session = await getSession()
  if (!canOpenSetting(session.profile.role, 'users')) {
    redirect('/dashboard?denied=manage_users')
  }
  return session
}

export default async function UsersPage() {
  const { company, profile } = await guard()
  // Scoped by company_id — another tenant's staff are never returned — and by
  // the caller's role, which keeps admin rows out of a manager's payload
  // entirely rather than rendering them locked.
  const users = await listCompanyUsers(company.id, profile.role)

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500">Staff accounts for {company.name}.</p>

      <UsersManager
        users={users}
        roles={ASSIGNABLE_ROLES}
        currentUserId={profile.id}
        viewerRole={profile.role}
      />
    </div>
  )
}
