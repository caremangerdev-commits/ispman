'use client'

import { useActionState } from 'react'

import { requestCode, verifyCode, type LoginState } from '@/app/actions/portal'
import { BrandRule, PortalWordmark, primaryButtonClass, type PortalBrand } from '@/components/portal/Brand'

/**
 * The phone-and-code sign-in, in two phases driven by the server actions'
 * returned state. Phase 'phone' asks for the number and texts a code; phase
 * 'code' asks for the code. Built thumb-first: one field and one full-width
 * button per screen, large tap targets, and the native keyboards and SMS
 * autofill a phone gives for a tel field and a one-time-code field.
 *
 * The company's logo (or its name as a wordmark) and brand rule head both
 * phases, so the first screen a customer sees is already the tenant's brand.
 */
export function LoginForm({ companyName, brand }: { companyName: string; brand: PortalBrand }) {
  const [reqState, reqAction, reqPending] = useActionState<LoginState | null, FormData>(requestCode, null)
  const [verState, verAction, verPending] = useActionState<LoginState | null, FormData>(verifyCode, null)

  const phase = verState?.phase ?? reqState?.phase ?? 'phone'
  const phone =
    (verState && 'phone' in verState ? verState.phone : undefined) ??
    (reqState && 'phone' in reqState ? reqState.phone : undefined) ??
    ''

  const header = (
    <div className="flex flex-col gap-3">
      <PortalWordmark brand={brand} />
      <BrandRule brand={brand} />
    </div>
  )

  if (phase === 'code') {
    return (
      <>
        <form action={verAction} className="flex flex-col gap-5">
          {header}
          <div>
            <h1 className="text-2xl font-semibold">Enter your code</h1>
            <p className="mt-1 text-base text-neutral-500">
              We sent a 6-digit code by text. It expires in 10 minutes.
            </p>
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
          {verState?.error ? <p className="text-base text-red-600">{verState.error}</p> : null}
          <button
            type="submit"
            disabled={verPending}
            className={primaryButtonClass}
            style={{ backgroundColor: brand.palette.accent, color: brand.palette.onAccent }}
          >
            {verPending ? 'Checking…' : 'Sign in'}
          </button>
          {/* Submits the sibling resend form (a button's form= can target any form). */}
          <button
            type="submit"
            form="portal-resend"
            disabled={reqPending}
            className="w-full py-2 text-base text-neutral-500 underline"
          >
            Send a new code
          </button>
        </form>
        <form id="portal-resend" action={reqAction} className="hidden">
          <input type="hidden" name="phone" value={phone} />
        </form>
      </>
    )
  }

  return (
    <form action={reqAction} className="flex flex-col gap-5">
      {header}
      <div>
        <h1 className="text-2xl font-semibold">Sign in</h1>
        <p className="mt-1 text-base text-neutral-500">
          Sign in with the mobile number on your {companyName} account to see your balance and pay.
        </p>
      </div>
      <input
        name="phone"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        autoFocus
        placeholder="876 000 0000"
        aria-label="Mobile number"
        className="w-full rounded-xl border border-neutral-300 px-4 py-4 text-xl outline-none focus:border-neutral-900"
      />
      {reqState?.error ? <p className="text-base text-red-600">{reqState.error}</p> : null}
      <button
        type="submit"
        disabled={reqPending}
        className={primaryButtonClass}
        style={{ backgroundColor: brand.palette.accent, color: brand.palette.onAccent }}
      >
        {reqPending ? 'Sending…' : 'Text me a code'}
      </button>
    </form>
  )
}
