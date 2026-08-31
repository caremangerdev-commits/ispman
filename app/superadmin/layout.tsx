import { Suspense, type ReactNode } from 'react'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowLeft, Shield } from 'lucide-react'

import { signOut } from '@/app/actions/auth'
import { Toast } from '@/components/ui/Toast'
import { displayName, getSession } from '@/lib/session'

/**
 * Super admin shell — deliberately separate from the tenant dashboard layout.
 *
 * The amber chrome is a standing reminder that everything below is
 * cross-company and bypasses tenant scoping.
 */
export default async function SuperAdminLayout({ children }: { children: ReactNode }) {
  const { profile } = await getSession()

  // Not a permission check: this is the platform-level flag. A company_admin
  // is the top of their own tenant and still must not land here.
  if (!profile.is_super_admin) {
    redirect('/dashboard?denied=view_super_admin_dashboard')
  }

  return (
    <div className="min-h-screen bg-gray-950">
      <header className="flex h-16 items-center gap-4 border-b border-amber-900/40 bg-gray-900 px-6">
        <span className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/20">
            <Shield className="h-4 w-4 text-amber-400" aria-hidden />
          </span>
          <span className="text-lg font-bold tracking-tight text-white">
            ISPMan <span className="text-amber-400">Platform</span>
          </span>
        </span>

        <nav className="ml-4 flex items-center gap-1 text-sm" aria-label="Super admin">
          {/* Overview is the only platform page built so far. */}
          <Link href="/superadmin" className="rounded-md px-3 py-1.5 text-gray-300 transition hover:bg-gray-800">
            Overview
          </Link>
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-1 text-xs font-medium text-gray-400 transition hover:text-gray-200"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            Back to dashboard
          </Link>
          <span className="text-xs text-gray-500">{displayName(profile)}</span>
          <form action={signOut}>
            <button
              type="submit"
              className="rounded-md bg-gray-800 px-2.5 py-1 text-xs font-medium text-gray-300 transition hover:bg-gray-700"
            >
              Log out
            </button>
          </form>
        </div>
      </header>

      <main className="p-6">{children}</main>

      {/* Reads ?toast= from the URL, so it needs a Suspense boundary. */}
      <Suspense fallback={null}>
        <Toast />
      </Suspense>
    </div>
  )
}
