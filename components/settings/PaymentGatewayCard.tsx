'use client'

import { useActionState, useId, useState } from 'react'
import { useFormStatus } from 'react-dom'

import { saveGateway, type GatewayFormResult } from '@/app/actions/payment-gateways'
import { settingsInput } from '@/components/settings/Modal'

/**
 * One gateway's settings on the Online Payments page. The page renders one card
 * per provider; a company pays through one at a time, so turning a card on
 * turns the others off (enforced in lib/data/payment-gateways.ts).
 *
 * SECRETS ARE WRITE-ONLY: the card is told only whether one is saved, never its
 * value. A field left blank keeps what is stored and is filled only to replace
 * it. The webhook URL is shown so an operator can paste it into the provider's
 * dashboard — it is not a secret, it only selects which company's key verifies
 * the delivery.
 *
 * THE COPY DIFFERS BY PROVIDER because the two work differently: Fygaro has one
 * standing payment button and one secret, Dime mints a checkout per payment and
 * has a separate webhook signing secret. Describing them in one set of generic
 * labels would leave an operator guessing which key goes where.
 */

export type GatewaySettings = {
  publicKey: string | null
  checkoutUrl: string | null
  enabled: boolean
  secretSet: boolean
  webhookSecretSet: boolean
}

export type PaymentGatewayCardProps = {
  provider: 'fygaro' | 'dime'
  available: boolean
  settings: GatewaySettings | null
  /** The absolute webhook URL to paste into the provider, e.g. https://host/api/payments/dime/12/webhook. */
  webhookUrl: string
  /** Where the payer is returned after paying, or null when the portal domain is unset. */
  returnUrl: string | null
}

const DIME_SANDBOX_API = 'https://sandbox.api.dimepay.app/dapi/v2'

function Notice({ state }: { state: GatewayFormResult | null }) {
  if (!state) return null
  return (
    <p
      role="alert"
      className={
        'rounded-lg border px-3 py-2 text-xs ' +
        (state.ok
          ? 'border-green-900/60 bg-green-950/40 text-green-300'
          : 'border-red-900/60 bg-red-950/50 text-red-300')
      }
    >
      {state.ok ? state.message : state.error}
    </p>
  )
}

function Save({ disabled }: { disabled?: boolean }) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {pending ? 'Saving…' : 'Save'}
    </button>
  )
}

function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-stretch gap-2">
      <input
        readOnly
        value={value}
        onFocus={(e) => e.currentTarget.select()}
        className={settingsInput + ' font-mono text-xs'}
      />
      <button
        type="button"
        onClick={() => {
          navigator.clipboard?.writeText(value).then(
            () => setCopied(true),
            () => setCopied(false)
          )
        }}
        className="shrink-0 rounded-lg border border-gray-700 px-3 text-xs font-semibold text-gray-300 transition hover:border-gray-500 hover:text-white"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] text-gray-600">{children}</p>
}

export function PaymentGatewayCard({
  provider,
  available,
  settings,
  webhookUrl,
  returnUrl,
}: PaymentGatewayCardProps) {
  const [state, action] = useActionState<GatewayFormResult | null, FormData>(saveGateway, null)
  const uid = useId()
  const id = (name: string) => provider + '-' + name + '-' + uid

  const secretSet = Boolean(settings?.secretSet)
  const webhookSecretSet = Boolean(settings?.webhookSecretSet)
  const isDime = provider === 'dime'
  const label = isDime ? 'Dime Pay' : 'Fygaro'

  return (
    <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-white">{label}</h2>
          <p className="mt-1 text-xs text-gray-500">
            {isDime
              ? 'Card payments from the customer portal. Paste your Dime client key, API secret and webhook signing secret, then turn it on.'
              : 'Card payments from the customer portal. Paste the keys from your Fygaro payment-button and webhook settings, then turn it on.'}
          </p>
        </div>
        <span
          className={
            'shrink-0 rounded-full px-3 py-1 text-xs font-medium ' +
            (settings?.enabled ? 'bg-green-900/40 text-green-300' : 'bg-gray-800 text-gray-400')
          }
        >
          {settings?.enabled ? 'On' : 'Off'}
        </span>
      </div>

      {!available ? (
        <p className="mt-4 rounded-lg border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
          Needs migration 0034. Until it is applied nothing here is saved and the portal shows no
          online-payment button.
        </p>
      ) : null}

      {/*
        autoComplete="off" ON THE FORM AND EVERY FIELD, and "new-password" on
        the secrets.

        Chrome's password manager reads a card like this one as a login form —
        a text box followed by a password box — and fills them with the
        operator's own email and saved password. Caught on JMEDIA, 13 Nov 2026:
        the Fygaro card came up pre-filled with superadmin@ispman.com and a
        saved password. One absent-minded Save and the company's public key is
        an email address, its gateway secret is a staff password, and card
        payments stop working for that tenant until somebody notices.

        "new-password" is the only value Chrome reliably declines to autofill;
        plain "off" is advisory and it ignores it on password inputs.
      */}
      <form action={action} autoComplete="off" className="mt-4 space-y-4">
        <input type="hidden" name="provider" value={provider} />

        <div className="space-y-1.5">
          <label htmlFor={id('public_key')} className="block text-xs font-medium text-gray-400">
            {isDime ? 'Client key' : 'API public key'}
          </label>
          <input
            id={id('public_key')}
            name="public_key"
            defaultValue={settings?.publicKey ?? ''}
            placeholder={isDime ? 'Your Dime client key' : 'pk_live_…'}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            disabled={!available}
            className={settingsInput + ' font-mono'}
          />
          <Hint>
            {isDime
              ? 'Sent with every request as the X-Dime-Client header. Not secret.'
              : 'Fygaro’s API public key — the JWT key id. Not secret.'}
          </Hint>
        </div>

        <div className="space-y-1.5">
          <label htmlFor={id('secret_key')} className="block text-xs font-medium text-gray-400">
            {isDime ? 'API secret' : 'Secret'}
          </label>
          <input
            id={id('secret_key')}
            name="secret_key"
            type="password"
            autoComplete="new-password"
            placeholder={
              secretSet
                ? '•••••••• (saved — leave blank to keep)'
                : isDime
                  ? 'Paste the Dime secret key'
                  : 'Paste the Fygaro secret'
            }
            disabled={!available}
            className={settingsInput + ' font-mono'}
          />
          <Hint>
            {isDime
              ? 'Authorises the payment request to Dime. Never leaves this server.'
              : 'Signs the checkout link and verifies the webhook.'}{' '}
            Stored once and never shown again;
            {secretSet ? ' leave blank to keep the saved one.' : ' enter it to turn payments on.'}
          </Hint>
        </div>

        {isDime ? (
          <div className="space-y-1.5">
            <label
              htmlFor={id('webhook_secret')}
              className="block text-xs font-medium text-gray-400"
            >
              Webhook signing secret
            </label>
            <input
              id={id('webhook_secret')}
              name="webhook_secret"
              type="password"
              autoComplete="new-password"
              placeholder={
                webhookSecretSet
                  ? '•••••••• (saved — leave blank to keep)'
                  : 'Paste the signing secret'
              }
              disabled={!available}
              className={settingsInput + ' font-mono'}
            />
            <Hint>
              A different secret from the one above. Dime shows it once, when you add the webhook
              below, and again if you rotate it. Without it a payment could arrive and never be
              recorded, so Dime cannot be turned on until it is saved.
            </Hint>
          </div>
        ) : null}

        {isDime ? (
          <div className="space-y-1.5">
            <label htmlFor={id('checkout_url')} className="block text-xs font-medium text-gray-400">
              Environment
            </label>
            <select
              id={id('checkout_url')}
              name="checkout_url"
              defaultValue={settings?.checkoutUrl === DIME_SANDBOX_API ? DIME_SANDBOX_API : ''}
              disabled={!available}
              className={settingsInput}
            >
              <option value="">Live — take real payments</option>
              <option value={DIME_SANDBOX_API}>Sandbox — test with Dime’s test cards</option>
            </select>
            <Hint>
              Use Sandbox with your sandbox keys to prove the flow end to end before going live.
              A sandbox payment extends real service, so test on a test account.
            </Hint>
          </div>
        ) : (
          <div className="space-y-1.5">
            <label htmlFor={id('checkout_url')} className="block text-xs font-medium text-gray-400">
              Payment button URL
            </label>
            <input
              id={id('checkout_url')}
              name="checkout_url"
              type="url"
              defaultValue={settings?.checkoutUrl ?? ''}
              placeholder="https://www.fygaro.com/…/pay/…"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              disabled={!available}
              className={settingsInput + ' font-mono'}
            />
            <Hint>
              Your Variable-Amount payment button’s link. A signed amount is appended per payment.
            </Hint>
          </div>
        )}

        <label className="flex items-center gap-2 text-sm text-gray-300">
          <input
            type="checkbox"
            name="enabled"
            defaultChecked={settings?.enabled ?? false}
            disabled={!available}
            className="h-4 w-4 rounded border-gray-600 bg-gray-800 text-blue-600 focus:ring-blue-500/40"
          />
          Accept online payments from the portal
        </label>
        <Hint>
          Only one gateway takes payments at a time. Turning this on turns the other off and keeps
          its keys, so switching back is one tick.
        </Hint>

        <Notice state={state} />
        <Save disabled={!available} />
      </form>

      <div className="mt-6 space-y-1.5 border-t border-gray-800 pt-4">
        <p className="text-xs font-medium text-gray-400">Webhook URL</p>
        <CopyField value={webhookUrl} />
        <Hint>
          {isDime
            ? 'Add this as a webhook endpoint in Dime and subscribe it to the payment events. Dime shows the signing secret once when you create it — paste it above. Only a captured payment is recorded; the other events are acknowledged and ignored.'
            : 'Paste this into Fygaro’s webhook settings. Fygaro POSTs here on every successful payment; the signature is checked against your secret above.'}
        </Hint>
      </div>

      <div className="mt-4 space-y-1.5">
        <p className="text-xs font-medium text-gray-400">Return URL</p>
        {returnUrl ? (
          <>
            <CopyField value={returnUrl} />
            <Hint>
              {isDime
                ? 'Sent to Dime with every payment — nothing to configure. Shown here so you know where a payer lands.'
                : 'Set this as the Return URL on your Fygaro payment button. After paying, the customer is brought back here to a confirmation on their account — Fygaro adds the reference to it automatically.'}
            </Hint>
          </>
        ) : (
          <Hint>
            Available once the customer portal domain is configured on this server. Until then,
            customers stay on {label}’s own confirmation after paying.
          </Hint>
        )}
      </div>
    </section>
  )
}
