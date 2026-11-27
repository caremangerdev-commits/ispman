'use client'

import { useEffect, useState } from 'react'

import { Modal, settingsInput } from '@/components/settings/Modal'
import { createClient } from '@/lib/supabase/client'

type Factor = { id: string; status: string; friendly_name?: string | null }
type Enrolling = { factorId: string; qr: string; secret: string }

/**
 * Two-step login for the signed-in staff member: a 6-digit code from an
 * authenticator app (Google Authenticator, Microsoft Authenticator, Authy) on
 * top of the password. Runs on Supabase Auth's own TOTP factors, through the
 * browser client, so the secret never passes through ISPMan's server code.
 * Once on, getSession (lib/session.ts) sends a login without the code to
 * /login/verify.
 */
export function TwoStepModal({ onClose }: { onClose: () => void }) {
  const supabase = createClient()
  const [factors, setFactors] = useState<Factor[] | null>(null)
  const [enrolling, setEnrolling] = useState<Enrolling | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  const load = async () => {
    const { data, error } = await supabase.auth.mfa.listFactors()
    if (error) {
      setNote({ ok: false, text: error.message })
      setFactors([])
      return
    }
    setFactors((data?.totp ?? []) as Factor[])
  }

  useEffect(() => {
    const t = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const verified = (factors ?? []).filter((f) => f.status === 'verified')
  const on = verified.length > 0

  const start = async () => {
    setBusy(true)
    setNote(null)
    // An unfinished set-up from before would block a new one with the same name.
    for (const f of (factors ?? []).filter((x) => x.status !== 'verified')) {
      await supabase.auth.mfa.unenroll({ factorId: f.id })
    }
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'ISPMan ' + Date.now() })
    setBusy(false)
    if (error || !data) {
      setNote({ ok: false, text: error?.message ?? 'Could not start set-up.' })
      return
    }
    setEnrolling({ factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret })
  }

  const confirm = async () => {
    if (!enrolling) return
    setBusy(true)
    setNote(null)
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: enrolling.factorId, code: code.trim() })
    setBusy(false)
    if (error) {
      setNote({ ok: false, text: 'That code did not match. Check the time on your phone is right, and type the newest code.' })
      return
    }
    setEnrolling(null)
    setCode('')
    setNote({ ok: true, text: 'Two-step login is on. Next time you sign in, ISPMan asks for a code from the app.' })
    await load()
  }

  const turnOff = async () => {
    setBusy(true)
    setNote(null)
    for (const f of verified) {
      const { error } = await supabase.auth.mfa.unenroll({ factorId: f.id })
      if (error) {
        setBusy(false)
        setNote({ ok: false, text: 'Could not turn it off: ' + error.message + ' Sign out and in again with your code, then try again.' })
        return
      }
    }
    setBusy(false)
    setNote({ ok: true, text: 'Two-step login is off.' })
    await load()
  }

  const primary = 'rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-60'
  const quiet = 'rounded-lg bg-gray-800 px-4 py-2 text-sm font-semibold text-gray-300 transition hover:bg-gray-700 disabled:opacity-60'

  return (
    <Modal title="Two-step login" onClose={onClose}>
      <div className="space-y-4 text-sm">
        {factors === null ? <p className="text-gray-400">Reading…</p> : null}

        {factors !== null && !enrolling ? (
          on ? (
            <>
              <p className="text-gray-300">
                <span className="font-semibold text-emerald-400">On.</span> Signing in needs your password and a code from
                your authenticator app.
              </p>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={onClose} className={quiet}>Close</button>
                <button type="button" onClick={() => void turnOff()} disabled={busy} className={quiet + ' hover:text-red-300'}>
                  {busy ? 'Turning off…' : 'Turn off'}
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-gray-300">
                Off. Turn it on and signing in will also need a 6-digit code from an app on your phone, so a stolen
                password is not enough to get into ISPMan.
              </p>
              <p className="text-gray-400">
                You need an authenticator app: Google Authenticator, Microsoft Authenticator or Authy. All are free.
              </p>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={onClose} className={quiet}>Close</button>
                <button type="button" onClick={() => void start()} disabled={busy} className={primary}>
                  {busy ? 'Starting…' : 'Turn on'}
                </button>
              </div>
            </>
          )
        ) : null}

        {enrolling ? (
          <>
            <p className="text-gray-300">1. In the app, add an account and scan this code.</p>
            <div className="flex justify-center">
              {/* Supabase returns the QR as an SVG data URI. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={enrolling.qr} alt="QR code for your authenticator app" className="h-44 w-44 rounded-lg bg-white p-2" />
            </div>
            <p className="text-xs text-gray-500">
              Can&apos;t scan? Type this key into the app instead:{' '}
              <span className="select-all break-all font-mono text-gray-300">{enrolling.secret}</span>
            </p>
            <div className="space-y-1.5">
              <label htmlFor="two-step-code" className="block text-xs font-medium text-gray-400">
                2. Type the 6-digit code the app shows
              </label>
              <input
                id="two-step-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                className={settingsInput + ' font-mono tracking-widest'}
              />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setEnrolling(null)} className={quiet}>Cancel</button>
              <button type="button" onClick={() => void confirm()} disabled={busy || code.length !== 6} className={primary}>
                {busy ? 'Checking…' : 'Turn on'}
              </button>
            </div>
          </>
        ) : null}

        {note ? (
          <p className={'rounded-lg px-3 py-2 text-xs ' + (note.ok ? 'bg-emerald-950/40 text-emerald-300' : 'bg-red-950/30 text-red-300')}>
            {note.text}
          </p>
        ) : null}
      </div>
    </Modal>
  )
}
