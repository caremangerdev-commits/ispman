'use client'

import { useActionState } from 'react'

import { confirmPhoneChange, requestPhoneChange, type PhoneChangeState } from '@/app/actions/portal'
import { primaryButtonClass } from '@/components/portal/Brand'
import type { BrandPalette } from '@/lib/brand'

/**
 * Change-of-number: enter the new mobile, verify it by SMS, and only then is it
 * saved. Same two-phase shape as the sign-in. Thumb-first inputs.
 */
export function PhoneChangeForm({ palette }: { palette: BrandPalette }) {
  const [reqState, reqAction, reqPending] = useActionState<PhoneChangeState | null, FormData>(requestPhoneChange, null)
  const [verState, verAction, verPending] = useActionState<PhoneChangeState | null, FormData>(confirmPhoneChange, null)

  const state = verState ?? reqState

  if (state?.phase === 'done') {
    return (
      <div className="flex flex-col gap-4">
        <p className="rounded-xl bg-green-50 px-4 py-4 text-base text-green-800">
          Your phone number has been updated.
        </p>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- '/' is rewritten to /portal by proxy.ts; a full nav keeps that rewrite */}
        <a href="/" className="w-full rounded-xl border border-neutral-300 px-4 py-4 text-center text-lg font-medium">
          Back to my account
        </a>
      </div>
    )
  }

  const phase = state?.phase === 'code' ? 'code' : 'enter'
  const phone = state && 'phone' in state ? state.phone : ''

  if (phase === 'code') {
    return (
      <>
        <form action={verAction} className="flex flex-col gap-5">
          <div>
            <h1 className="text-2xl font-semibold">Verify the new number</h1>
            <p className="mt-1 text-base text-neutral-500">We texted a 6-digit code to the new number.</p>
          </div>
          <input type="hidden" name="phone" value={phone} />
          <input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={6}
            autoFocus
            placeholder="______"
            aria-label="6-digit code"
            className="w-full rounded-xl border border-neutral-300 px-4 py-4 text-center text-3xl tracking-[0.4em] tabular-nums outline-none focus:border-neutral-900"
          />
          {verState?.phase === 'code' && verState.error ? (
            <p className="text-base text-red-600">{verState.error}</p>
          ) : null}
          <button type="submit" disabled={verPending} className={primaryButtonClass} style={{ backgroundColor: palette.accent, color: palette.onAccent }}>
            {verPending ? 'Saving…' : 'Save new number'}
          </button>
          <button type="submit" form="phone-resend" disabled={reqPending} className="w-full py-2 text-base text-neutral-500 underline">
            Send a new code
          </button>
        </form>
        <form id="phone-resend" action={reqAction} className="hidden">
          <input type="hidden" name="phone" value={phone} />
        </form>
      </>
    )
  }

  return (
    <form action={reqAction} className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold">Change your number</h1>
        <p className="mt-1 text-base text-neutral-500">Enter the new Jamaican mobile number. We’ll text it a code to confirm it’s yours.</p>
      </div>
      <input
        name="phone"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        autoFocus
        placeholder="876 000 0000"
        aria-label="New mobile number"
        className="w-full rounded-xl border border-neutral-300 px-4 py-4 text-xl outline-none focus:border-neutral-900"
      />
      {reqState?.phase === 'enter' && reqState.error ? (
        <p className="text-base text-red-600">{reqState.error}</p>
      ) : null}
      <button type="submit" disabled={reqPending} className={primaryButtonClass} style={{ backgroundColor: palette.accent, color: palette.onAccent }}>
        {reqPending ? 'Sending…' : 'Text me a code'}
      </button>
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- '/' is rewritten to /portal by proxy.ts; a full nav keeps that rewrite */}
      <a href="/" className="w-full py-2 text-center text-base text-neutral-500 underline">Cancel</a>
    </form>
  )
}
