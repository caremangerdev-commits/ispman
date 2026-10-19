'use client'

import { useActionState } from 'react'

import { confirmPhoneChange, requestPhoneChange, type PhoneChangeState } from '@/app/actions/portal'
import styles from '@/components/portal/portal.module.css'

/**
 * Change-of-number: enter the new mobile, verify it by SMS, and only then is it
 * saved. Same two-phase shape as the sign-in. Thumb-first inputs.
 */
export function PhoneChangeForm() {
  const [reqState, reqAction, reqPending] = useActionState<PhoneChangeState | null, FormData>(requestPhoneChange, null)
  const [verState, verAction, verPending] = useActionState<PhoneChangeState | null, FormData>(confirmPhoneChange, null)

  const state = verState ?? reqState

  if (state?.phase === 'done') {
    return (
      <section className={styles.card + ' ' + styles.stack}>
        <p className={styles.notice + ' ' + styles.noticeOk}>Your phone number has been updated.</p>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- '/' is rewritten to /portal by proxy.ts; a full nav keeps that rewrite */}
        <a href="/" className={styles.btn + ' ' + styles.flush}>Back to my account</a>
      </section>
    )
  }

  const phase = state?.phase === 'code' ? 'code' : 'enter'
  const phone = state && 'phone' in state ? state.phone : ''

  if (phase === 'code') {
    return (
      <section className={styles.card}>
        <form action={verAction} className={styles.stack}>
          <div>
            <h1 className={styles.title}>Verify the new number</h1>
            <p className={styles.lede}>We texted a 6-digit code to the new number.</p>
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
          {verState?.phase === 'code' && verState.error ? (
            <p className={styles.error + ' ' + styles.mt0} role="alert">{verState.error}</p>
          ) : null}
          <button type="submit" disabled={verPending} className={styles.btn + ' ' + styles.flush}>
            {verPending ? 'Saving…' : 'Save new number'}
          </button>
          <button type="submit" form="phone-resend" disabled={reqPending} className={styles.textButton}>
            Send a new code
          </button>
        </form>
        <form id="phone-resend" action={reqAction} hidden>
          <input type="hidden" name="phone" value={phone} />
        </form>
      </section>
    )
  }

  return (
    <section className={styles.card}>
      <form action={reqAction} className={styles.stack}>
        <div>
          <h1 className={styles.title}>Change your number</h1>
          <p className={styles.lede}>
            Enter the new Jamaican mobile number. We’ll text it a code to confirm it’s yours.
          </p>
        </div>
        <div>
          <label htmlFor="portal-new-phone" className={styles.label}>New mobile number</label>
          <input
            id="portal-new-phone"
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            autoFocus
            placeholder="876 000 0000"
            className={styles.input}
          />
        </div>
        {reqState?.phase === 'enter' && reqState.error ? (
          <p className={styles.error + ' ' + styles.mt0} role="alert">{reqState.error}</p>
        ) : null}
        <button type="submit" disabled={reqPending} className={styles.btn + ' ' + styles.flush}>
          {reqPending ? 'Sending…' : 'Text me a code'}
        </button>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- '/' is rewritten to /portal by proxy.ts; a full nav keeps that rewrite */}
        <a href="/" className={styles.textButton}>Cancel</a>
      </form>
    </section>
  )
}
