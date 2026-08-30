import type { Metadata } from 'next'

import { LoginForm } from './login-form'

export const metadata: Metadata = {
  title: 'Sign in · ISPMan',
  description: 'Sign in to the ISPMan ISP management platform.',
}

/**
 * Only allow redirects back to a path on this site. Accepting an arbitrary
 * `redirectTo` would turn the login page into an open redirect.
 */
function safeRedirect(value: string | string[] | undefined): string {
  const target = Array.isArray(value) ? value[0] : value
  // Defaults to '/', which routes by role — see lib/home.ts#homePathFor.
  if (!target) return '/'
  // Reject absolute URLs and protocol-relative ("//evil.com") targets.
  if (!target.startsWith('/') || target.startsWith('//')) return '/'
  return target
}

export default async function LoginPage({ searchParams }: PageProps<'/login'>) {
  const redirectTo = safeRedirect((await searchParams).redirectTo)

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold tracking-tight text-white">
            ISP<span className="text-blue-500">Man</span>
          </h1>
          <p className="mt-2 text-sm text-slate-400">
            ISP management platform
          </p>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl shadow-black/40">
          <LoginForm redirectTo={redirectTo} />
        </div>

        <p className="mt-6 text-center text-xs text-slate-600">
          Authorised users only. Contact your administrator for access.
        </p>
      </div>
    </main>
  )
}
