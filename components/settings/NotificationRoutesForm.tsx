'use client'

import { AlertTriangle, CheckCircle2, Mail } from 'lucide-react'
import { useActionState, useState } from 'react'

import { saveNotificationRoutes, type SmsActionResult } from '@/app/actions/sms'
import type { NotifyKind, SmsSettings } from '@/lib/data/sms'
import { ROUTE_LABELS, ROUTES, routeUses, type Route } from '@/lib/messaging/routes'
import {
  AUTOMATED_KINDS, DEFAULT_EMAIL_BODIES, DEFAULT_EMAIL_SUBJECTS, KIND_LABELS, PLACEHOLDERS,
} from '@/lib/sms/templates'

const input =
  'w-full rounded-lg border border-gray-800 bg-gray-950 px-3 py-2 text-sm text-gray-200 ' +
  'outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30'
const label = 'block text-xs font-medium text-gray-400'

/**
 * Email, and which channel each message kind goes by.
 *
 * ITS OWN FORM AND ITS OWN ACTION, beside the SMS form rather than inside it.
 * The SMS form owns the phone pairing and the SMS wording; this one owns the
 * email sender, the routes and the email wording. Each saves what it shows,
 * so saving one cannot silently rewrite the other's fields with stale state.
 *
 * THE ROUTES ARE THE COMPANY'S DECISION. Every kind defaults to SMS, which is
 * what every company did before email existed, and nothing here nudges toward
 * email — the labels say exactly what each option does and the company picks.
 */
export function NotificationRoutesForm({
  settings, emailConfigured, sendingDomain, emailCount, totalCount,
}: {
  settings: SmsSettings
  /** Whether the PLATFORM has an email provider. Without it the form explains and saves nothing. */
  emailConfigured: boolean
  sendingDomain: string | null
  /** Customers with a usable email address, so the company knows what a route would reach. */
  emailCount: number
  totalCount: number
}) {
  const [state, action, pending] = useActionState<SmsActionResult | null, FormData>(
    saveNotificationRoutes, null
  )
  const [enabled, setEnabled] = useState(settings.emailEnabled)
  const [routes, setRoutes] = useState<Record<NotifyKind | 'bulk', Route>>({ ...settings.routes })
  const [templates, setTemplates] = useState(settings.emailTemplates)

  const fieldError = (k: string) => (state?.ok === false ? state.fieldErrors?.[k] : undefined)
  const anyEmail = (Object.values(routes) as Route[]).some((r) => routeUses(r, 'email'))

  return (
    <form action={action} className="space-y-5">
      {/* --- Email, the channel ------------------------------------------- */}
      <div className="space-y-3 rounded-xl border border-gray-800 bg-gray-900 p-4">
        <div className="flex items-center gap-2">
          <Mail className="h-4 w-4 text-gray-500" aria-hidden />
          <p className="text-sm font-semibold text-gray-200">Email</p>
        </div>

        {!emailConfigured ? (
          <p className="flex items-start gap-2 rounded-lg border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-300/90">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            This server has no email provider configured. Ask your administrator. Routes that
            include email will fall back to SMS where they can, and skip the customer where they cannot.
          </p>
        ) : null}

        <label className="flex items-start gap-3">
          <input
            type="checkbox" name="email_enabled" checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-gray-700 bg-gray-950"
          />
          <span>
            <span className="block text-sm font-medium text-gray-200">Send email for this company</span>
            <span className="block text-xs text-gray-500">
              The master switch for email. While it is off, no route sends by email, whatever it says.
            </span>
          </span>
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="email_from_name" className={label}>Sender name</label>
            <input
              id="email_from_name" name="email_from_name"
              defaultValue={settings.emailFromName ?? ''}
              placeholder={settings.companyName}
              className={input + ' mt-1'}
            />
            <p className="mt-1 text-[11px] text-gray-600">
              Shown as the sender. Emails go from{' '}
              <span className="font-mono text-gray-500">notifications@{sendingDomain ?? 'the platform domain'}</span>.
            </p>
          </div>
          <div>
            <label htmlFor="email_reply_to" className={label}>Replies go to</label>
            <input
              id="email_reply_to" name="email_reply_to" type="email"
              defaultValue={settings.emailReplyTo ?? ''}
              placeholder={settings.companyEmail ?? 'your@company.com'}
              className={input + ' mt-1'}
            />
            {fieldError('email_reply_to') ? (
              <p className="mt-1 text-xs text-red-400">{fieldError('email_reply_to')}</p>
            ) : (
              <p className="mt-1 text-[11px] text-gray-600">
                Defaults to the company email on the General settings page.
              </p>
            )}
          </div>
        </div>

        <p className="text-xs text-gray-500">
          {emailCount.toLocaleString()} of {totalCount.toLocaleString()} customers have an email
          address this system can send to.
        </p>
      </div>

      {/* --- Which channel for which message ------------------------------ */}
      <div className="space-y-4 rounded-xl border border-gray-800 bg-gray-900 p-4">
        <div>
          <p className="text-sm font-semibold text-gray-200">Which channel for which message</p>
          <p className="mt-1 text-xs text-gray-500">
            Your choice, per message. The wording for SMS is on the left of this page; the email
            wording is below each route that uses email.
          </p>
        </div>

        {([...AUTOMATED_KINDS, 'bulk'] as (NotifyKind | 'bulk')[]).map((kind) => {
          const usesEmail = routeUses(routes[kind], 'email')
          return (
            <div key={kind} className="space-y-2 border-t border-gray-800 pt-3 first:border-0 first:pt-0">
              <div className="grid gap-2 sm:grid-cols-[1fr_2fr] sm:items-center">
                <p className="text-sm font-medium text-gray-200">
                  {kind === 'bulk' ? 'Messages from the messaging page' : KIND_LABELS[kind]}
                </p>
                <select
                  name={'route_' + kind}
                  value={routes[kind]}
                  onChange={(e) => setRoutes({ ...routes, [kind]: e.target.value as Route })}
                  className={input}
                >
                  {ROUTES.map((r) => <option key={r} value={r}>{ROUTE_LABELS[r]}</option>)}
                </select>
              </div>
              {fieldError('route_' + kind) ? (
                <p className="text-xs text-red-400">{fieldError('route_' + kind)}</p>
              ) : null}

              {usesEmail && kind !== 'bulk' ? (
                <div className="space-y-2 sm:ml-[33%] sm:pl-2">
                  <div>
                    <label htmlFor={'subj-' + kind} className={label}>Email subject</label>
                    <input
                      id={'subj-' + kind} name={'email_' + kind + '_subject'}
                      value={templates[kind].subject}
                      onChange={(e) => setTemplates({ ...templates, [kind]: { ...templates[kind], subject: e.target.value } })}
                      className={input + ' mt-1'}
                    />
                    {fieldError('email_' + kind + '_subject') ? (
                      <p className="mt-1 text-xs text-red-400">{fieldError('email_' + kind + '_subject')}</p>
                    ) : null}
                  </div>
                  <div>
                    <label htmlFor={'body-' + kind} className={label}>Email wording</label>
                    <textarea
                      id={'body-' + kind} name={'email_' + kind + '_body'} rows={6}
                      value={templates[kind].body}
                      onChange={(e) => setTemplates({ ...templates, [kind]: { ...templates[kind], body: e.target.value } })}
                      className={input + ' mt-1 font-mono text-xs'}
                    />
                    <div className="mt-1 flex justify-end text-[11px]">
                      <button
                        type="button"
                        onClick={() => setTemplates({
                          ...templates,
                          [kind]: { subject: DEFAULT_EMAIL_SUBJECTS[kind], body: DEFAULT_EMAIL_BODIES[kind] },
                        })}
                        className="text-gray-500 underline transition hover:text-gray-300"
                      >
                        Reset to default
                      </button>
                    </div>
                    {fieldError('email_' + kind + '_body') ? (
                      <p className="text-xs text-red-400">{fieldError('email_' + kind + '_body')}</p>
                    ) : null}
                    {kind === 'payment_receipt' ? (
                      <p className="mt-1 text-[11px] text-gray-600">
                        The receipt PDF is attached to this email automatically.
                      </p>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {usesEmail && kind === 'bulk' ? (
                <p className="text-[11px] text-gray-600 sm:ml-[33%] sm:pl-2">
                  The subject is typed when the message is sent.
                </p>
              ) : null}
            </div>
          )
        })}

        {anyEmail ? (
          <div className="rounded-lg bg-gray-950 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Placeholders</p>
            <dl className="mt-1.5 grid gap-x-4 gap-y-1 text-[11px] sm:grid-cols-2">
              {Object.entries(PLACEHOLDERS).map(([token, what]) => (
                <div key={token} className="flex gap-2">
                  <dt className="font-mono text-blue-400">{token}</dt>
                  <dd className="text-gray-500">{what}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}
      </div>

      {state ? (
        <p
          className={
            'flex items-center gap-2 rounded-lg px-3 py-2 text-xs ' +
            (state.ok ? 'bg-green-950/30 text-green-300' : 'bg-red-950/40 text-red-300')
          }
        >
          {state.ok ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> : <AlertTriangle className="h-3.5 w-3.5" aria-hidden />}
          {state.ok ? state.message : state.error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-60"
      >
        {pending ? 'Saving…' : 'Save notification settings'}
      </button>
    </form>
  )
}
