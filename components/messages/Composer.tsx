'use client'

import { AlertTriangle, AtSign, Clock, Filter, Globe, Send, Users } from 'lucide-react'
import { useState, useTransition } from 'react'

import {
  previewAudience, sendBulkSms, sendDirectSms, type AudiencePreview,
} from '@/app/actions/sms'
import type { CustomerFilters } from '@/lib/customer-filter'
import { NO_FILTERS } from '@/lib/customer-filter'
import { isEmail } from '@/lib/email'
import {
  CHANNEL_LABELS, ROUTE_LABELS, ROUTES, routeUses, type Channel, type Route,
} from '@/lib/messaging/routes'
import { classifyPhone, PHONE_SKIP_REASON } from '@/lib/phone'
import {
  DEFAULT_TEMPLATES, KIND_LABELS, PLACEHOLDERS, countSegments, customerPlaceholders,
  unknownPlaceholders, type SmsKind,
} from '@/lib/sms/templates'
import { CUSTOMER_STATUSES, STATUS_LABELS, type CustomerStatus } from '@/lib/status'

const input =
  'w-full rounded-lg border border-gray-800 bg-gray-950 px-3 py-2 text-sm text-gray-200 ' +
  'outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30'
const label = 'block text-xs font-medium text-gray-400'

export type Option = { id: number; name: string }

/**
 * Who a message is for. Three answers, chosen up front.
 *
 * `all` and `filters` are the same server call with different inputs — every
 * filter empty IS "everyone" — but they are separate choices here because
 * "clear every box and know that empty means all" is not a thing to work out
 * during an outage. `direct` is a different call: one typed-in number or
 * address, no customer record behind it.
 */
type Audience = 'all' | 'filters' | 'direct'

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
  miscCategories, servicePlans, addresses, accessPoints, cutOffDates,
  hasBothConnectionTypes, templates, allowForeign, defaultRoute, channelsAvailable,
  readyChannels, canSendNow, blockedReason,
}: {
  miscCategories: Option[]
  servicePlans: Option[]
  addresses: string[]
  accessPoints: string[]
  cutOffDates: number[]
  hasBothConnectionTypes: boolean
  templates: Record<Exclude<SmsKind, 'bulk'>, string>
  /** The company's overseas-sending switch, so a typed number is judged by the
   *  same rule the server will apply. */
  allowForeign: boolean
  /** The company's route for messages from this page, preselected. */
  defaultRoute: Route
  /** False before migration 0022: SMS is the only channel and no choice is offered. */
  channelsAvailable: boolean
  /** Channels this company can send on right now. */
  readyChannels: Channel[]
  canSendNow: boolean
  blockedReason: string | null
}) {
  const [audience, setAudience] = useState<Audience>('all')
  const [filters, setFilters] = useState<CustomerFilters>(NO_FILTERS)
  const [route, setRoute] = useState<Route>(channelsAvailable ? defaultRoute : 'sms')
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [preview, setPreview] = useState<AudiencePreview | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const seg = countSegments(body)
  const unknown = unknownPlaceholders(body)
  const needsCustomer = audience === 'direct' ? customerPlaceholders(body) : []

  // A typed-in address: an @ makes it an email, anything else is judged as a
  // phone — the same split the server makes.
  const directIsEmail = to.includes('@')
  const verdict = classifyPhone(to)
  const phoneUsable = verdict.kind === 'jamaica' || (verdict.kind === 'foreign' && allowForeign)
  const directChannel: Channel = directIsEmail ? 'email' : 'sms'
  const directUsable = directIsEmail
    ? isEmail(to.trim()) && readyChannels.includes('email')
    : phoneUsable && readyChannels.includes('sms')
  const directProblem =
    to.trim() === '' ? null
      : directIsEmail
        ? !isEmail(to.trim()) ? 'That is not a valid email address'
          : !readyChannels.includes('email') ? 'Email is not available for this company' : null
        : !readyChannels.includes('sms') ? 'SMS is not available for this company'
          : phoneUsable ? null
            : verdict.kind === 'jamaica' ? null
              : PHONE_SKIP_REASON[verdict.kind]

  // Whether the message needs a subject: an email route on a customer send,
  // or a typed-in email address.
  const wantsSubject = audience === 'direct' ? directIsEmail : channelsAvailable && routeUses(route, 'email')

  // ANY change to the audience, the route or the message invalidates a preview
  // that was already confirmed. Leaving a stale count on screen next to a Send
  // button is how somebody messages the wrong 400 people.
  const patch = (p: Partial<CustomerFilters>) => {
    setFilters({ ...filters, ...p })
    setPreview(null)
  }

  const choose = (next: Audience) => {
    setAudience(next)
    setPreview(null)
    setError(null)
    // "Everyone" means every filter empty — the same call the filtered path
    // makes, with nothing to clear first.
    if (next === 'all') setFilters(NO_FILTERS)
  }

  const effectiveFilters = audience === 'all' ? NO_FILTERS : filters

  function check() {
    setError(null)
    startTransition(async () => {
      try {
        setPreview(await previewAudience(effectiveFilters, body, route))
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not work out who this would go to.')
      }
    })
  }

  function send() {
    setError(null)
    startTransition(async () => {
      const res = audience === 'direct'
        ? await sendDirectSms(to, body, subject)
        : await sendBulkSms(effectiveFilters, body, route, subject)
      if (res.ok) {
        setResult(res.message)
        setPreview(null)
        setBody('')
        setSubject('')
        setFilters(NO_FILTERS)
        setTo('')
      } else {
        setError(res.error)
      }
    })
  }

  const num = (v: number | null) => (v === null ? '' : String(v))
  const toNum = (v: string) => (v.trim() === '' ? null : Number(v))

  const messageReady = Boolean(body.trim()) && unknown.length === 0 && (!wantsSubject || Boolean(subject.trim()))

  const audienceChoice = (
    value: Audience, Icon: typeof Users, title: string, hint: string
  ) => (
    <button
      type="button"
      onClick={() => choose(value)}
      aria-pressed={audience === value}
      className={
        'flex flex-1 items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition ' +
        (audience === value
          ? 'border-blue-500 bg-blue-500/10'
          : 'border-gray-800 bg-gray-950 hover:border-gray-700')
      }
    >
      <Icon
        className={'mt-0.5 h-4 w-4 shrink-0 ' + (audience === value ? 'text-blue-400' : 'text-gray-500')}
        aria-hidden
      />
      <span className="min-w-0">
        <span className={'block text-sm font-semibold ' + (audience === value ? 'text-white' : 'text-gray-300')}>
          {title}
        </span>
        <span className="block text-[11px] leading-snug text-gray-500">{hint}</span>
      </span>
    </button>
  )

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

        <div className="flex flex-col gap-2 sm:flex-row">
          {audienceChoice(
            'all', Globe, 'All customers',
            'Everyone this company can reach.'
          )}
          {audienceChoice(
            'filters', Filter, 'Some customers',
            'Pick them by access point, address, status or plan.'
          )}
          {audienceChoice(
            'direct', AtSign, channelsAvailable ? 'One number or email' : 'One phone number',
            'A technician, a supplier, or your own phone to test.'
          )}
        </div>

        {audience !== 'direct' && channelsAvailable ? (
          // THE COMPANY'S CHOICE, preselected from its settings and changeable
          // per send. The preview says how many each channel reaches.
          <div className="border-t border-gray-800 pt-3">
            <label htmlFor="f-route" className={label}>Send by</label>
            <select
              id="f-route" className={input + ' mt-1 max-w-md'}
              value={route}
              onChange={(e) => { setRoute(e.target.value as Route); setPreview(null) }}
            >
              {ROUTES.map((r) => <option key={r} value={r}>{ROUTE_LABELS[r]}</option>)}
            </select>
          </div>
        ) : null}

        {audience === 'filters' ? (
          // The same filters as the customer list, from the same module. A
          // selection made here means exactly what it means there.
          <div className="grid gap-3 border-t border-gray-800 pt-3 sm:grid-cols-2 lg:grid-cols-3">
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

            {cutOffDates.length > 0 ? (
              <div>
                <label htmlFor="f-cutoff" className={label}>Cut-off day</label>
                <select
                  id="f-cutoff" className={input + ' mt-1'}
                  value={num(filters.cutOffDate)}
                  onChange={(e) => patch({ cutOffDate: toNum(e.target.value) })}
                >
                  <option value="">Any cut-off day</option>
                  {cutOffDates.map((d) => (
                    <option key={d} value={d}>Cut-off {d}</option>
                  ))}
                </select>
              </div>
            ) : null}

            {hasBothConnectionTypes ? (
              <div>
                <label htmlFor="f-conn" className={label}>Connection</label>
                <select
                  id="f-conn" className={input + ' mt-1'}
                  value={filters.connectionType ?? ''}
                  onChange={(e) => patch({
                    connectionType: e.target.value === '' ? null : e.target.value as 'wireless' | 'wired',
                  })}
                >
                  <option value="">Wireless &amp; wired</option>
                  <option value="wireless">Wireless</option>
                  <option value="wired">Wired</option>
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

            <div>
              <label htmlFor="f-search" className={label}>Search</label>
              <input
                id="f-search" className={input + ' mt-1'}
                placeholder="Name, phone, address, account"
                value={filters.query}
                onChange={(e) => patch({ query: e.target.value })}
              />
              <p className="mt-1 text-[11px] text-gray-600">
                Narrows the filters above. It is the usual reason a selection comes to nobody.
              </p>
            </div>
          </div>
        ) : null}

        {audience === 'direct' ? (
          <div className="border-t border-gray-800 pt-3">
            <label htmlFor="d-to" className={label}>
              {channelsAvailable ? 'Phone number or email address' : 'Phone number'}
            </label>
            <input
              id="d-to" type="text" inputMode={channelsAvailable ? 'email' : 'tel'} autoComplete="off"
              className={input + ' mt-1 max-w-sm font-mono'}
              placeholder={channelsAvailable ? '876-555-1234 or name@example.com' : '876-555-1234'}
              value={to}
              onChange={(e) => { setTo(e.target.value); setError(null) }}
            />
            {directProblem ? (
              <p className="mt-1 text-xs text-amber-300/90">{directProblem}.</p>
            ) : directUsable ? (
              <p className="mt-1 text-xs text-gray-500">
                Will be sent by {CHANNEL_LABELS[directChannel]} to{' '}
                <span className="font-mono text-gray-300">
                  {directIsEmail ? to.trim().toLowerCase() : '+' + verdict.e164}
                </span>
                {!directIsEmail && verdict.recovered ? ' — the first of the two numbers you typed' : ''}.
              </p>
            ) : (
              <p className="mt-1 text-[11px] text-gray-600">
                Not looked up against your customers — it goes to exactly this address.
              </p>
            )}
          </div>
        ) : null}
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

        {wantsSubject ? (
          <div>
            <label htmlFor="m-subject" className={label}>Email subject</label>
            <input
              id="m-subject" className={input + ' mt-1'}
              placeholder="Service interruption tonight"
              value={subject}
              onChange={(e) => { setSubject(e.target.value); setPreview(null) }}
            />
            <p className="mt-1 text-[11px] text-gray-600">
              Only the email gets a subject. The message below is the text of both.
            </p>
          </div>
        ) : null}

        <textarea
          rows={4}
          value={body}
          onChange={(e) => { setBody(e.target.value); setPreview(null) }}
          placeholder={
            audience === 'direct'
              ? 'Type your message.'
              : 'Type your message. Use {{first_name}} to personalise it.'
          }
          className={input + ' font-mono text-xs'}
        />

        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
          <span className="text-gray-600">
            {seg.characters} characters · {seg.segments} SMS
            {audience === 'direct' ? '' : ' per customer'}
            {seg.encoding === 'UCS2' ? ' · unicode (70 per SMS)' : ''}
          </span>
          <span className="text-gray-600">
            {audience === 'direct'
              ? '{{company}}'
              : Object.keys(PLACEHOLDERS).slice(0, 4).join('  ')}
          </span>
        </div>

        {unknown.length > 0 ? (
          <p className="rounded-lg bg-red-950/40 px-3 py-2 text-xs text-red-300">
            Unknown placeholder: {unknown.join(', ')}. It would be sent
            exactly as written.
          </p>
        ) : null}

        {needsCustomer.length > 0 ? (
          <p className="rounded-lg bg-amber-950/30 px-3 py-2 text-xs text-amber-300/90">
            {needsCustomer.join(', ')} can only be filled in from a customer record, and a
            typed-in address has none. Remove it, or choose a customer audience.
          </p>
        ) : null}

        {seg.encoding === 'UCS2' ? (
          <p className="rounded-lg bg-amber-950/30 px-3 py-2 text-xs text-amber-300/90">
            This contains a character outside the standard SMS set — usually a curly
            apostrophe pasted from Word. It cuts each SMS from 160 characters to 70
            and will cost more to send. Email is unaffected.
          </p>
        ) : null}
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Confirm. NOTHING SENDS until this has been seen.                  */}
      {/* ---------------------------------------------------------------- */}
      <section className="space-y-3 rounded-xl border border-gray-800 bg-gray-900 p-4">
        {audience === 'direct' ? (
          // One address needs no headcount: the recipient is already on screen
          // and the button repeats it. That IS the confirmation.
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={send}
              disabled={
                pending || !canSendNow || !messageReady || !directUsable ||
                needsCustomer.length > 0
              }
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-50"
            >
              <Send className="h-4 w-4" aria-hidden />
              {pending
                ? 'Queueing…'
                : directUsable
                  ? 'Send to ' + (directIsEmail ? to.trim().toLowerCase() : '+' + verdict.e164)
                  : 'Send'}
            </button>
            <span className="text-xs text-gray-600">
              {!directIsEmail && seg.segments > 1 ? seg.segments + ' SMS. ' : ''}
              Goes out with the next dispatch, usually within a minute.
            </span>
          </div>
        ) : !preview ? (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={check}
              disabled={pending || !messageReady}
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
                <p className="text-[11px] text-gray-500">
                  will receive it
                  {preview.byChannel.length > 1 || channelsAvailable
                    ? ' — ' + preview.byChannel.map((c) => c.count + ' by ' + c.label).join(', ')
                    : ''}
                </p>
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
              {channelsAvailable ? (
                <>
                  <span className="mx-2 text-gray-700">·</span>
                  <span className="text-gray-400">Send by:</span> {ROUTE_LABELS[route]}
                </>
              ) : null}
            </p>

            {preview.unavailable.length > 0 ? (
              <div className="rounded-lg border border-amber-900/50 bg-amber-950/30 px-3 py-2.5">
                {preview.unavailable.map((u) => (
                  <p key={u.channel} className="text-xs text-amber-300/90">
                    {CHANNEL_LABELS[u.channel]}: {u.reason}
                  </p>
                ))}
              </div>
            ) : null}

            {/* Nobody matched, and a filter is why. Named, so the fix is one
                change and not a guess across nine boxes. */}
            {preview.matched === 0 && preview.emptyReasons.length > 0 ? (
              <div className="rounded-lg border border-amber-900/50 bg-amber-950/30 px-3 py-2.5">
                <p className="text-xs font-semibold text-amber-300">
                  A filter is excluding everyone
                </p>
                <ul className="mt-1 space-y-0.5">
                  {preview.emptyReasons.map((r) => (
                    <li key={r} className="text-xs text-amber-300/90">{r}</li>
                  ))}
                </ul>
                <button
                  type="button"
                  onClick={() => choose('all')}
                  className="mt-2 text-xs text-amber-200 underline transition hover:text-white"
                >
                  Send to all customers instead
                </button>
              </div>
            ) : null}

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

            {preview.sendable > 0 ? (
              <p className="flex items-center gap-1.5 text-xs text-gray-500">
                <Clock className="h-3.5 w-3.5" aria-hidden />
                Sending will take {humanise(preview.estimatedSeconds)} at your configured
                rate{preview.segments > 1
                  ? ' (each SMS is ' + preview.segments + ' parts)'
                  : ''}.
              </p>
            ) : null}

            {preview.sendable === 0 ? (
              <div className="flex flex-wrap items-center gap-3">
                {preview.matched > 0 ? (
                  <p className="rounded-lg bg-amber-950/30 px-3 py-2 text-xs text-amber-300/90">
                    Nobody in this selection can be reached this way.
                  </p>
                ) : null}
                <button
                  type="button"
                  onClick={() => setPreview(null)}
                  className="text-xs text-gray-500 underline transition hover:text-gray-300"
                >
                  Change something
                </button>
              </div>
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
