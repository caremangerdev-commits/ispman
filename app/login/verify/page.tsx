import type { Metadata } from 'next'

import { safeReturnPath } from '@/lib/home'

import { VerifyForm } from './verify-form'

export const metadata: Metadata = {
  title: 'Enter your code · ISPMan',
}

/**
 * The second step of signing in, for staff who have two-step login on. The
 * password is already accepted (a level-1 session exists); getSession sends
 * every page here until the code is given. Under /login, so the proxy lets it
 * through, and not /login itself, which a signed-in user is sent away from.
 */
export default async function VerifyPage({ searchParams }: PageProps<'/login/verify'>) {
  const redirectTo = safeReturnPath((await searchParams).redirectTo)

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold tracking-tight text-white">
            ISP<span className="text-blue-500">Man</span>
          </h1>
          <p className="mt-2 text-sm text-slate-400">Two-step login</p>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl shadow-black/40">
          <VerifyForm redirectTo={redirectTo} />
        </div>
      </div>
    </main>
  )
}
