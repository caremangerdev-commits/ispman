'use client'

import { useActionState, useState } from 'react'

import {
  requestCode, signInWithAccount, verifyCode, type LoginState,
} from '@/app/actions/portal'
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
  const [acctState, acctAction, acctPending] =
    useActionState<LoginState | null, FormData>(signInWithAccount, null)

  // Which way in is showing. It starts on the code because that is the better
  // proof; a failed attempt on the other tab keeps that tab up, so the error
  // is read beside the fields that caused it.
  const [tab, setTab] = useState<'code' | 'account'>('code')
  const onAccount = tab === 'account' || acctState?.phase === 'account'

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
      <div>
        <h1 className={styles.title}>Sign in</h1>
        <p className={styles.lede}>
          See your balance and pay your {companyName} account.
        </p>
      </div>

      <div className={styles.tabs} role="tablist" aria-label="How to sign in">
        <button
          type="button"
          role="tab"
          aria-selected={!onAccount}
          onClick={() => setTab('code')}
          className={styles.tab + (onAccount ? '' : ' ' + styles.tabOn)}
        >
          Text me a code
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={onAccount}
          onClick={() => setTab('account')}
          className={styles.tab + (onAccount ? ' ' + styles.tabOn : '')}
        >
          Account details
        </button>
      </div>

      {onAccount ? (
        <form action={acctAction} className={styles.stack}>
          <div>
            <label htmlFor="acct-phone" className={styles.label}>Mobile number</label>
            <input
              id="acct-phone"
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="876 000 0000"
              className={styles.input}
            />
          </div>
          <div>
            <label htmlFor="acct-number" className={styles.label}>Account number</label>
            <input
              id="acct-number"
              name="account_number"
              type="text"
              autoComplete="off"
              autoCapitalize="characters"
              placeholder="On your bill"
              className={styles.input}
            />
          </div>
          {acctState?.error ? (
            <p className={styles.error + ' ' + styles.mt0} role="alert">{acctState.error}</p>
          ) : null}
          <button type="submit" disabled={acctPending} className={styles.btn + ' ' + styles.flush}>
            {acctPending ? 'Checking…' : 'Sign in'}
          </button>
          <p className={styles.acctHelp}>
            Your account number is printed on your bill. To change the number on
            your account you will need a code by text.
          </p>
        </form>
      ) : (
        <form action={reqAction} className={styles.stack}>
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
      )}
    </section>
  )
}
