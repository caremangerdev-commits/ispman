'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'

import { saveFygaroGateway, type GatewayFormResult } from '@/app/actions/payment-gateways'
import { settingsInput } from '@/components/settings/Modal'

/**
 * Fygaro gateway settings on the Online Payments page.
 *
 * The SECRET IS WRITE-ONLY: the card is told only whether one is saved, never
 * its value. The field is left blank to keep the stored secret and filled only
 * to replace it. The webhook URL is shown so an operator can paste it into
 * Fygaro's dashboard — it is not a secret, it only selects which company's key
 * verifies the delivery.
 */

export type PaymentGatewayCardProps = {
  available: boolean
  settings: {
    publicKey: string | null
    checkoutUrl: string | null
    enabled: boolean
    secretSet: boolean
  } | null
  /** The absolute webhook URL to paste into Fygaro, e.g. https://host/api/payments/fygaro/12/webhook. */
  webhookUrl: string
  /** The Return URL to set on the Fygaro button, or null when the portal domain is unset. */
  returnUrl: string | null
}

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

export function PaymentGatewayCard({ available, settings, webhookUrl, returnUrl }: PaymentGatewayCardProps) {
  const [state, action] = useActionState<GatewayFormResult | null, FormData>(saveFygaroGateway, null)
  const secretSet = Boolean(settings?.secretSet)

  return (
    <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-white">Fygaro</h2>
          <p className="mt-1 text-xs text-gray-500">
            Card payments from the customer portal. Paste the keys from your Fygaro payment-button
            and webhook settings, then turn it on.
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

      <form action={action} className="mt-4 space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="public_key" className="block text-xs font-medium text-gray-400">
            API public key
          </label>
          <input
            id="public_key"
            name="public_key"
            defaultValue={settings?.publicKey ?? ''}
            placeholder="pk_live_…"
            disabled={!available}
            className={settingsInput + ' font-mono'}
          />
          <p className="text-[11px] text-gray-600">Fygaro&apos;s API public key — the JWT key id. Not secret.</p>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="checkout_url" className="block text-xs font-medium text-gray-400">
            Payment button URL
          </label>
          <input
            id="checkout_url"
            name="checkout_url"
            type="url"
            defaultValue={settings?.checkoutUrl ?? ''}
            placeholder="https://www.fygaro.com/…/pay/…"
            disabled={!available}
            className={settingsInput + ' font-mono'}
          />
          <p className="text-[11px] text-gray-600">
            Your Variable-Amount payment button&apos;s link. A signed amount is appended per payment.
          </p>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="secret_key" className="block text-xs font-medium text-gray-400">
            Secret
          </label>
          <input
            id="secret_key"
            name="secret_key"
            type="password"
            autoComplete="off"
            placeholder={secretSet ? '•••••••• (saved — leave blank to keep)' : 'Paste the Fygaro secret'}
            disabled={!available}
            className={settingsInput + ' font-mono'}
          />
          <p className="text-[11px] text-gray-600">
            Signs the checkout link and verifies the webhook. Stored once and never shown again;
            {secretSet ? ' leave blank to keep the saved one.' : ' enter it to turn payments on.'}
          </p>
        </div>

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

        <Notice state={state} />
        <Save disabled={!available} />
      </form>

      <div className="mt-6 space-y-1.5 border-t border-gray-800 pt-4">
        <p className="text-xs font-medium text-gray-400">Webhook URL</p>
        <CopyField value={webhookUrl} />
        <p className="text-[11px] text-gray-600">
          Paste this into Fygaro&apos;s webhook settings. Fygaro POSTs here on every successful
          payment; the signature is checked against your secret above.
        </p>
      </div>

      <div className="mt-4 space-y-1.5">
        <p className="text-xs font-medium text-gray-400">Return URL</p>
        {returnUrl ? (
          <>
            <CopyField value={returnUrl} />
            <p className="text-[11px] text-gray-600">
              Set this as the Return URL on your Fygaro payment button. After paying, the customer
              is brought back here to a confirmation on their account — Fygaro adds the reference to
              it automatically.
            </p>
          </>
        ) : (
          <p className="text-[11px] text-gray-600">
            Available once the customer portal domain is configured on this server. Until then,
            customers stay on Fygaro&apos;s own confirmation after paying.
          </p>
        )}
      </div>
    </section>
  )
}
