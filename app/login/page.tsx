import type { Metadata } from 'next'

import { safeReturnPath } from '@/lib/home'

import { LoginForm } from './login-form'

export const metadata: Metadata = {
  title: 'Sign in · ISPMan',
  description: 'Sign in to the ISPMan ISP management platform.',
}

export default async function LoginPage({ searchParams }: PageProps<'/login'>) {
  // Sanitised here so the form never carries an off-site target, and again on
  // the root page, which is the one that actually follows it.
  const redirectTo = safeReturnPath((await searchParams).redirectTo)

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
