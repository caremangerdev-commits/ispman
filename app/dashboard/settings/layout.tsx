import type { ReactNode } from 'react'
import { redirect } from 'next/navigation'

import { SettingsNav } from '@/components/settings/SettingsNav'
import { getSession } from '@/lib/session'
import { visibleSettings } from '@/lib/settings-nav'

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const { profile } = await getSession()
  const sections = visibleSettings(profile.role)

  // A role with no settings sections at all has no business here; bounce it
  // rather than render an empty shell. Individual pages guard themselves too.
  if (sections.length === 0) {
    redirect('/dashboard?denied=manage_company_settings')
  }

  return (
    <div className="flex gap-6">
      <SettingsNav sections={sections} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
