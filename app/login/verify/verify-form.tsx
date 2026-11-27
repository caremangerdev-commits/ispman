'use client'

import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'

import { createClient } from '@/lib/supabase/client'

export function VerifyForm({ redirectTo }: { redirectTo: string | null }) {
  const router = useRouter()
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoading(true)
    setError(null)
    const supabase = createClient()
    const { data: factors, error: listError } = await supabase.auth.mfa.listFactors()
    const factor = (factors?.totp ?? []).find((f) => f.status === 'verified')
    if (listError || !factor) {
      // No session, or no code set up: back to the password step.
      router.replace('/login')
      return
    }
    const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code: code.trim() })
    if (verifyError) {
      setError('That code did not match. Type the newest code from your app.')
      setLoading(false)
      return
    }
    router.replace(redirectTo ? '/?redirectTo=' + encodeURIComponent(redirectTo) : '/')
    router.refresh()
  }

  async function startOver() {
    await createClient().auth.signOut()
    router.replace('/login')
    router.refresh()
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="space-y-2">
        <label htmlFor="code" className="block text-sm font-medium text-slate-300">
          Code from your authenticator app
        </label>
        <input
          id="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          maxLength={6}
          required
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          className="block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-center font-mono text-lg tracking-[0.4em] text-white outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30"
        />
      </div>
      {error ? <p role="alert" className="text-sm text-red-400">{error}</p> : null}
      <button
        type="submit"
        disabled={loading || code.length !== 6}
        className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-60"
      >
        {loading ? 'Checking…' : 'Continue'}
      </button>
      <p className="text-center text-xs text-slate-500">
        Lost your phone? Ask your company admin to turn two-step login off for you.{' '}
        <button type="button" onClick={() => void startOver()} className="text-slate-400 underline hover:text-slate-200">
          Sign in as someone else
        </button>
      </p>
    </form>
  )
}
