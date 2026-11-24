'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'

import { loadOutages, notifyOutage, type PonOutage } from '@/app/actions/olts'

/**
 * PON ports that went down on this OLT, and who was on them.
 *
 * TELLING THE CUSTOMERS IS ONE PRESS. The background check already knows
 * which ONUs went down together and whose they are; this turns that into an
 * outage for exactly those customers — a text now (if outage messages are on),
 * a notice on their portal page, and a second text when the port comes back,
 * sent by the same check that saw it fail.
 */

const DEFAULT_MESSAGE =
  'We know about a fault on the fibre line serving your area and are working to fix it. ' +
  'We will text you when your service is back.'

const portName = (p: string) => 'PON ' + (p.split(/[^0-9]+/).filter(Boolean).pop() ?? p)
const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
function lasted(from: string, to: string | null, nowMs: number): string {
  const mins = Math.max(0, Math.round(((to ? new Date(to).getTime() : nowMs) - new Date(from).getTime()) / 60000))
  if (mins < 60) return mins + ' min'
  if (mins < 48 * 60) return Math.floor(mins / 60) + ' h ' + (mins % 60) + ' min'
  return Math.round(mins / 1440) + ' days'
}

function Outage({ outage, nowMs, canManage, onDone }: { outage: PonOutage; nowMs: number; canManage: boolean; onDone: () => void }) {
  const [open, setOpen] = useState(!outage.endedAt)
  const [writing, setWriting] = useState(false)
  const [message, setMessage] = useState(DEFAULT_MESSAGE)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const ongoing = !outage.endedAt

  const send = async () => {
    setBusy(true)
    const res = await notifyOutage({ outageId: outage.id, message })
    setBusy(false)
    setNote(res.ok ? { ok: true, text: res.message } : { ok: false, text: res.error })
    if (res.ok) {
      setWriting(false)
      onDone()
    }
  }

  return (
    <li className={'rounded-lg border p-4 ' + (ongoing ? 'border-red-400/60 bg-red-950/20' : 'border-gray-800')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-white">
            {portName(outage.port)}{' '}
            <span className={ongoing ? 'text-red-400' : 'text-gray-500'}>
              {ongoing ? '· down now, ' + lasted(outage.startedAt, null, nowMs) : '· back after ' + lasted(outage.startedAt, outage.endedAt, nowMs)}
            </span>
          </p>
          <p className="mt-0.5 text-xs text-gray-400">
            Went down {when(outage.startedAt)}
            {outage.endedAt ? ', back ' + when(outage.endedAt) : ''} · {outage.onus} ONUs ·{' '}
            {outage.customers.length} {outage.customers.length === 1 ? 'customer' : 'customers'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="rounded-md bg-gray-800 px-2.5 py-1 text-[11px] font-medium text-gray-200 hover:bg-gray-700"
          >
            {open ? 'Hide customers' : 'Show customers'}
          </button>
          {outage.incidentId ? (
            <Link
              href="/dashboard/incidents"
              className="rounded-md bg-gray-800 px-2.5 py-1 text-[11px] font-medium text-emerald-300 hover:bg-gray-700"
            >
              Customers told · view outage
            </Link>
          ) : canManage && outage.customers.length > 0 ? (
            <button
              type="button"
              onClick={() => setWriting(!writing)}
              className="rounded-md bg-blue-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-blue-500"
            >
              Text these customers
            </button>
          ) : null}
        </div>
      </div>

      {writing ? (
        <div className="mt-3 space-y-2">
          <label className="block text-[11px] text-gray-400" htmlFor={'outage-msg-' + outage.id}>
            Message to the {outage.customers.length} customers. Your company name goes in front.
          </label>
          <textarea
            id={'outage-msg-' + outage.id}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={3}
            maxLength={300}
            className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 focus:border-blue-500 focus:outline-none"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void send()}
              disabled={busy || message.trim().length < 10}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-60"
            >
              {busy ? 'Sending…' : 'Send to ' + outage.customers.length}
            </button>
            <button type="button" onClick={() => setWriting(false)} className="text-xs text-gray-400 hover:text-gray-200">
              Cancel
            </button>
          </div>
          <p className="text-[11px] text-gray-500">
            They also see the outage on their portal page. When the port comes back, ISPMan closes it and texts them
            that the service is restored.
          </p>
        </div>
      ) : null}
      {note ? (
        <p className={'mt-3 rounded-lg px-3 py-2 text-xs ' + (note.ok ? 'bg-emerald-950/40 text-emerald-300' : 'bg-red-950/40 text-red-300')}>
          {note.text}
        </p>
      ) : null}

      {open ? (
        outage.customers.length ? (
          <ul className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
            {outage.customers.map((c) => (
              <li key={c.id} className="flex justify-between gap-2">
                <Link href={'/dashboard/customers/' + c.id} className="truncate text-blue-400 hover:underline">
                  {c.name}
                </Link>
                <span className="shrink-0 font-mono text-gray-500">{c.phone ?? '—'}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-xs text-gray-500">None of these ONUs is linked to a customer yet.</p>
        )
      ) : null}
    </li>
  )
}

export function OutagePanel({ oltId, canManage }: { oltId: number; canManage: boolean }) {
  const [outages, setOutages] = useState<PonOutage[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nowMs, setNowMs] = useState(0)

  const load = useCallback(async () => {
    const res = await loadOutages(oltId)
    setNowMs(Date.now())
    if (res.ok) setOutages(res.outages)
    else setError(res.error)
  }, [oltId])
  useEffect(() => {
    const t = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(t)
  }, [load])

  if (error) return <p className="py-4 text-xs text-red-300">{error}</p>
  if (!outages) return <p className="py-6 text-sm text-gray-500">Loading…</p>
  if (outages.length === 0) {
    return (
      <p className="py-6 text-sm text-gray-500">
        No PON port has gone down since ISPMan started recording. When most of the ONUs on one port drop at once,
        it shows here with the customers on it, and the bell tells you straight away.
      </p>
    )
  }
  return (
    <ul className="space-y-3 py-2">
      {outages.map((o) => (
        <Outage key={o.id} outage={o} nowMs={nowMs} canManage={canManage} onDone={() => void load()} />
      ))}
    </ul>
  )
}
