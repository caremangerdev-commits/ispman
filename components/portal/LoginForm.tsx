'use client'

import { useActionState } from 'react'

import { requestCode, verifyCode, type LoginState } from '@/app/actions/portal'
import styles from '@/components/portal/portal.module.css'

/**
 * The phone-and-code sign-in, in two phases driven by the server actions'
 * returned state. Phase 'phone' asks for the number and texts a code; phase
 * 'code' asks for the code. Built thumb-first: one field and one full-width
 * button per screen, large tap targets, and the native keyboards and SMS
 * autofill a phone gives for a tel field and a one-time-code field.
 *
 * Rendered inside components/portal/PortalShell, so the company's band heads
 * both phases and the first screen a customer sees is already the tenant's.
 */
export function LoginForm({ companyName }: { companyName: string }) {
  const [reqState, reqAction, reqPending] = useActionState<LoginState | null, FormData>(requestCode, null)
  const [verState, verAction, verPending] = useActionState<LoginState | null, FormData>(verifyCode, null)

  const phase = verState?.phase ?? reqState?.phase ?? 'phone'
  const phone =
    (verState && 'phone' in verState ? verState.phone : undefined) ??
    (reqState && 'phone' in reqState ? reqState.phone : undefined) ??
    ''

  if (phase === 'code') {
    return (
      <section className={styles.card}>
        <form action={verAction} className={styles.stack}>
          <div>
            <h1 className={styles.title}>Enter your code</h1>
            <p className={styles.lede}>We sent a 6-digit code by text. It expires in 10 minutes.</p>
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
            className={styles.input + ' ' + styles.inputCode}
          />
          {verState?.error ? <p className={styles.error + ' ' + styles.mt0} role="alert">{verState.error}</p> : null}
          <button type="submit" disabled={verPending} className={styles.btn + ' ' + styles.flush}>
            {verPending ? 'Checking…' : 'Sign in'}
          </button>
          {/* Submits the sibling resend form (a button's form= can target any form). */}
          <button type="submit" form="portal-resend" disabled={reqPending} className={styles.textButton}>
            Send a new code
          </button>
        </form>
        <form id="portal-resend" action={reqAction} hidden>
          <input type="hidden" name="phone" value={phone} />
        </form>
      </section>
    )
  }

  return (
    <section className={styles.card}>
      <form action={reqAction} className={styles.stack}>
        <div>
          <h1 className={styles.title}>Sign in</h1>
          <p className={styles.lede}>
            Sign in with the mobile number on your {companyName} account to see your balance and pay.
          </p>
        </div>
        <div>
          <label htmlFor="portal-phone" className={styles.label}>Mobile number</label>
          <input
            id="portal-phone"
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            autoFocus
            placeholder="876 000 0000"
            className={styles.input}
          />
        </div>
        {reqState?.error ? <p className={styles.error + ' ' + styles.mt0} role="alert">{reqState.error}</p> : null}
        <button type="submit" disabled={reqPending} className={styles.btn + ' ' + styles.flush}>
          {reqPending ? 'Sending…' : 'Text me a code'}
        </button>
      </form>
    </section>
  )
}
