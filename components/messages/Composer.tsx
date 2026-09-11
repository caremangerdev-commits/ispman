'use client'

import { AlertTriangle, Clock, Send, Users } from 'lucide-react'
import { useState, useTransition } from 'react'

import {
  previewAudience, sendBulkSms, type AudiencePreview,
} from '@/app/actions/sms'
import type { CustomerFilters } from '@/lib/customer-filter'
import { NO_FILTERS } from '@/lib/customer-filter'
import {
  DEFAULT_TEMPLATES, KIND_LABELS, PLACEHOLDERS, countSegments, unknownPlaceholders,
  type SmsKind,
} from '@/lib/sms/templates'
import { CUSTOMER_STATUSES, STATUS_LABELS, type CustomerStatus } from '@/lib/status'

const input =
  'w-full rounded-lg border border-gray-800 bg-gray-950 px-3 py-2 text-sm text-gray-200 ' +
  'outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30'
const label = 'block text-xs font-medium text-gray-400'

export type Option = { id: number; name: string }

/** "about 4 minutes" — a duration a person can plan around. */
function humanise(seconds: number): string {
  if (seconds < 60) return 'under a minute'
  const mins = Math.round(seconds / 60)
  if (mins < 60) return 'about ' + mins + ' minute' + (mins === 1 ? '' : 's')
  const hours = Math.floor(mins / 60)
  const rest = mins % 60
  return 'about ' + hours + ' hour' + (hours === 1 ? '' : 's') +
    (rest ? ' ' + rest + ' min' : '')
}

export function Composer({
  miscCategories, servicePlans, addresses, accessPoints, templates, canSendNow,
  blockedReason,
}: {
  miscCategories: Option[]
  servicePlans: Option[]
  addresses: string[]
  accessPoints: string[]
  templates: Record<Exclude<SmsKind, 'bulk'>, string>
  canSendNow: boolean
  blockedReason: string | null
}) {
  const [filters, setFilters] = useState<CustomerFilters>(NO_FILTERS)
  const [body, setBody] = useState('')
  const [preview, setPreview] = useState<AudiencePreview | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const seg = countSegments(body)
  const unknown = unknownPlaceholders(body)

  const patch = (p: Partial<CustomerFilters>) => {
    setFilters({ ...filters, ...p })
    // ANY change to the audience or the message invalidates a preview that was
    // already confirmed. Leaving a stale count on screen next to a Send button
    // is how somebody messages the wrong 400 people.
    setPreview(null)
  }

  function check() {
    setError(null)
    startTransition(async () => {
      try {
        setPreview(await previewAudience(filters, body))
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not work out who this would go to.')
      }
    })
  }

  function send() {
    setError(null)
    startTransition(async () => {
      const res = await sendBulkSms(filters, body)
      if (res.ok) {
        setResult(res.message)
        setPreview(null)
        setBody('')
        setFilters(NO_FILTERS)
      } else {
        setError(res.error)
      }
    })
  }

  const num = (v: number | null) => (v === null ? '' : String(v))
  const toNum = (v: string) => (v.trim() === '' ? null : Number(v))

  return (
    <div className="space-y-4">
      {blockedReason ? (
        <div className="rounded-xl border border-amber-900/50 bg-amber-950/30 px-4 py-3">
          <p className="text-sm font-semibold text-amber-300">Cannot send yet</p>
          <p className="mt-1 text-xs leading-relaxed text-amber-300/80">{blockedReason}</p>
        </div>
      ) : null}

      {result ? (
        <div className="rounded-xl border border-green-900/50 bg-green-950/30 px-4 py-3">
          <p className="text-sm font-semibold text-green-300">{result}</p>
          <p className="mt-1 text-xs text-green-300/80">
            Messages are queued and will go out at your configured rate. The batch below
            updates as they send.
          </p>
        </div>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {/* Who                                                               */}
      {/* ---------------------------------------------------------------- */}
      <section className="space-y-3 rounded-xl border border-gray-800 bg-gray-900 p-4">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-gray-500" aria-hidden />
          <p className="text-sm font-semibold text-gray-200">Who gets it</p>
        </div>
        {/* The same filters as the customer list, from the same module. A
            selection made here means exactly what it means there. */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label htmlFor="f-search" className={label}>Search</label>
            <input
              id="f-search" className={input + ' mt-1'}
              placeholder="Name, phone, address, account"
              value={filters.query}
              onChange={(e) => patch({ query: e.target.value })}
            />
          </div>

          <div>
            <label htmlFor="f-status" className={label}>Connection status</label>
            <select
              id="f-status" className={input + ' mt-1'}
              value={filters.status}
              onChange={(e) => patch({ status: e.target.value as CustomerStatus | 'all' })}
            >
              <option value="all">Any status</option>
              {CUSTOMER_STATUSES.map((s) => (
                <option key={s} value={s}>{STATUS_LABELS[s]}</option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="f-address" className={label}>Address</label>
            <select
              id="f-address" className={input + ' mt-1'}
              value={filters.address}
              onChange={(e) => patch({ address: e.target.value })}
            >
              <option value="">Anywhere</option>
              {addresses.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>

          {/* The AP outage case: everyone behind one tower loses service at
              once, and they are exactly who should be told. Hidden when no
              customer has one recorded. */}
          {accessPoints.length > 0 ? (
            <div>
              <label htmlFor="f-ap" className={label}>Access point</label>
              <select
                id="f-ap" className={input + ' mt-1'}
                value={filters.accessPoint}
                onChange={(e) => patch({ accessPoint: e.target.value })}
              >
                <option value="">Any access point</option>
                {accessPoints.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
          ) : null}

          {miscCategories.length > 0 ? (
            <div>
              <label htmlFor="f-category" className={label}>Category</label>
              <select
                id="f-category" className={input + ' mt-1'}
                value={num(filters.miscCategoryId)}
                onChange={(e) => patch({ miscCategoryId: toNum(e.target.value) })}
              >
                <option value="">Any category</option>
                {miscCategories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          ) : null}

          {servicePlans.length > 0 ? (
            <div>
              <label htmlFor="f-plan" className={label}>Service plan</label>
              <select
                id="f-plan" className={input + ' mt-1'}
                value={num(filters.servicePlanId)}
                onChange={(e) => patch({ servicePlanId: toNum(e.target.value) })}
              >
                <option value="">Any plan</option>
                {servicePlans.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          ) : null}

          <div>
            <label htmlFor="f-expiring" className={label}>Expiring within</label>
            <select
              id="f-expiring" className={input + ' mt-1'}
              value={num(filters.expiringWithinDays)}
              onChange={(e) => patch({ expiringWithinDays: toNum(e.target.value) })}
            >
              <option value="">Any expiry</option>
              <option value="0">Already expired</option>
              <option value="3">3 days</option>
              <option value="7">7 days</option>
              <option value="14">14 days</option>
              <option value="30">30 days</option>
            </select>
          </div>

          <div>
            <label htmlFor="f-owing" className={label}>Owing at least</label>
            <input
              id="f-owing" type="number" min={0} step={100} className={input + ' mt-1'}
              placeholder="Any balance"
              value={num(filters.owingAtLeast)}
              onChange={(e) => patch({ owingAtLeast: toNum(e.target.value) })}
            />
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* What                                                              */}
      {/* ---------------------------------------------------------------- */}
      <section className="space-y-3 rounded-xl border border-gray-800 bg-gray-900 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold text-gray-200">The message</p>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-gray-600">Start from:</span>
            {(Object.keys(templates) as Exclude<SmsKind, 'bulk'>[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => { setBody(templates[k] || DEFAULT_TEMPLATES[k]); setPreview(null) }}
                className="rounded border border-gray-800 bg-gray-950 px-2 py-1 text-[11px] text-gray-400 transition hover:border-gray-700 hover:text-gray-200"
              >
                {KIND_LABELS[k]}
              </button>
            ))}
          </div>
        </div>

        <textarea
          rows={4}
          value={body}
          onChange={(e) => { setBody(e.target.value); setPreview(null) }}
          placeholder="Type your message. Use {{first_name}} to personalise it."
          className={input + ' font-mono text-xs'}
        />

        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
          <span className="text-gray-600">
            {seg.characters} characters · {seg.segments} SMS per customer
            {seg.encoding === 'UCS2' ? ' · unicode (70 per SMS)' : ''}
          </span>
          <span className="text-gray-600">
            {Object.keys(PLACEHOLDERS).slice(0, 4).join('  ')}
          </span>
        </div>

        {unknown.length > 0 ? (
          <p className="rounded-lg bg-red-950/40 px-3 py-2 text-xs text-red-300">
            Unknown placeholder: {unknown.join(', ')}. It would be sent to customers
            exactly as written.
          </p>
        ) : null}

        {seg.encoding === 'UCS2' ? (
          <p className="rounded-lg bg-amber-950/30 px-3 py-2 text-xs text-amber-300/90">
            This contains a character outside the standard SMS set — usually a curly
            apostrophe pasted from Word. It cuts each message from 160 characters to 70
            and will cost more to send.
          </p>
        ) : null}
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Confirm. NOTHING SENDS until this has been seen.                  */}
      {/* ---------------------------------------------------------------- */}
      <section className="space-y-3 rounded-xl border border-gray-800 bg-gray-900 p-4">
        {!preview ? (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={check}
              disabled={pending || !body.trim() || unknown.length > 0}
              className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-semibold text-gray-200 transition hover:bg-gray-700 disabled:opacity-50"
            >
              {pending ? 'Checking…' : 'Check who this goes to'}
            </button>
            <span className="text-xs text-gray-600">
              You will see the exact recipients before anything is sent.
            </span>
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg bg-gray-950 p-3">
                <p className="text-2xl font-semibold text-white">{preview.matched}</p>
                <p className="text-[11px] text-gray-500">customers matched</p>
              </div>
              <div className="rounded-lg bg-gray-950 p-3">
                <p className="text-2xl font-semibold text-green-400">{preview.sendable}</p>
                <p className="text-[11px] text-gray-500">will receive it</p>
              </div>
              <div className="rounded-lg bg-gray-950 p-3">
                <p className="text-2xl font-semibold text-amber-400">
                  {preview.matched - preview.sendable}
                </p>
                <p className="text-[11px] text-gray-500">will be skipped</p>
              </div>
            </div>

            <p className="text-xs text-gray-500">
              <span className="text-gray-400">Audience:</span> {preview.audience}
            </p>

            {preview.skipped.length > 0 ? (
              <div className="rounded-lg bg-gray-950 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                  Why customers are skipped
                </p>
                <ul className="mt-1.5 space-y-1">
                  {preview.skipped.map((s) => (
                    <li key={s.reason} className="flex justify-between gap-3 text-xs">
                      <span className="text-gray-500">{s.reason}</span>
                      <span className="font-semibold text-gray-400">{s.count}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <p className="flex items-center gap-1.5 text-xs text-gray-500">
              <Clock className="h-3.5 w-3.5" aria-hidden />
              Sending will take {humanise(preview.estimatedSeconds)} at your configured
              rate{preview.segments > 1
                ? ' (each message is ' + preview.segments + ' SMS)'
                : ''}.
            </p>

            {preview.sendable === 0 ? (
              <p className="rounded-lg bg-amber-950/30 px-3 py-2 text-xs text-amber-300/90">
                Nobody in this selection has a phone number this system can text.
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-3 border-t border-gray-800 pt-3">
                <button
                  type="button"
                  onClick={send}
                  disabled={pending || !canSendNow}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-50"
                >
                  <Send className="h-4 w-4" aria-hidden />
                  {pending
                    ? 'Queueing…'
                    : 'Send to ' + preview.sendable + ' customer' +
                      (preview.sendable === 1 ? '' : 's')}
                </button>
                <button
                  type="button"
                  onClick={() => setPreview(null)}
                  className="text-xs text-gray-500 underline transition hover:text-gray-300"
                >
                  Change something
                </button>
              </div>
            )}
          </>
        )}

        {error ? (
          <p className="flex items-start gap-1.5 rounded-lg bg-red-950/40 px-3 py-2 text-xs text-red-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            {error}
          </p>
        ) : null}
      </section>
    </div>
  )
}
