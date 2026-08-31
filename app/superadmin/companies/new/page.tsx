import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

import { NewCompanyForm } from '@/components/platform/NewCompanyForm'

export const metadata: Metadata = { title: 'New Company · ISPMan' }

/**
 * Access is enforced by app/superadmin/layout.tsx, which checks the
 * is_super_admin flag, and again by createCompany's own authorizeSuperAdmin().
 */
export default function NewCompanyPage() {
  return (
    <div className="max-w-3xl space-y-4">
      <Link
        href="/superadmin"
        className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 transition hover:text-gray-300"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Back to platform overview
      </Link>

      <div>
        <h1 className="text-xl font-semibold tracking-tight text-white">New Company</h1>
        <p className="mt-0.5 text-sm text-gray-500">
          Creates the company, its settings, and a first admin who can sign in.
        </p>
      </div>

      <NewCompanyForm />
    </div>
  )
}
