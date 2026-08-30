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
  // Scoped by company_id — another tenant's staff are never returned.
  const users = await listCompanyUsers(company.id)

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-white">Users</h1>
        <p className="mt-0.5 text-sm text-gray-500">Staff accounts for {company.name}.</p>
      </div>

      <UsersManager users={users} roles={ASSIGNABLE_ROLES} currentUserId={profile.id} />
    </div>
  )
}
