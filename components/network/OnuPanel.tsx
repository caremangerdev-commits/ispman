'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'

import { authoriseOnus, linkOnu, loadOnuDetail, onuCommand, type OnuDrop, type OnuSignalDay } from '@/app/actions/olts'
import { useCustomerSearch } from '@/components/customers/useCustomerSearch'
import { SignalBars } from '@/components/network/SignalBars'
import type { OnuCustomer } from '@/lib/data/customer-devices'
import type { UsageDay } from '@/lib/data/usage'
import type {
  OltAuthoriseResult, OltOnu, OltOnuAction, OltOnuDetail, OltPendingOnu,
} from '@/lib/olt/types'

/**
 * The ONU lists on an OLT's page: those waiting to be authorised, and those
 * already on.
 *
 * AUTHORISING DOES NOT ASK ANYTHING ABOUT THE ONU. One click registers it and
 * puts it on the OLT's VLAN, with the ONU itself left untagged — the setup for
 * a network whose ONUs have VLAN switched off. The only choice on the screen is
 * which VLAN, and that is remembered after the first time.
 *
 * "AUTHORISE ALL" WORKS IN SMALL BATCHES and keeps going until none are left,
 * showing the count as it falls. A whole PON port in one request would take
 * longer than a browser will wait.
 */

const th = 'py-2 pr-4 text-left text-[10px] font-medium uppercase tracking-wider text-gray-500'
const td = 'py-2 pr-4 text-xs text-gray-300'
const button =
  'rounded-md bg-blue-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-blue-500 disabled:opacity-50'

export type OnuLists = {
  pending: OltPendingOnu[]
  onus: OltOnu[]
  /** Serial number → the customer that ONU belongs to. */
  customers?: Record<string, OnuCustomer>
  /** Customer id → whether their router is logged in now, by RADIUS. */
  seen?: Record<number, { online: boolean; lastSeen: string | null }>
}

/** "5 min ago", "3 h ago", "4 days ago". */
function ago(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  if (mins < 60) return mins + ' min ago'
  const hours = Math.round(mins / 60)
  if (hours < 48) return hours + ' h ago'
  return Math.round(hours / 24) + ' days ago'
}

/**
 * Is the customer actually logged in. The OLT seeing their router's address
 * behind the ONU only says the ONU passes something; this is RADIUS saying the
 * router got on the internet.
 */
function Browsing({ seen, onuOnline }: { seen?: { online: boolean; lastSeen: string | null }; onuOnline: boolean }) {
  if (!seen) return null
  if (seen.online) return <span className="block text-[10px] text-green-400">Browsing now</span>
  return (
    <span className={'block text-[10px] ' + (onuOnline ? 'text-amber-300' : 'text-gray-500')}>
      {seen.lastSeen ? 'Not logged in · last online ' + ago(seen.lastSeen) : 'Never logged in'}
    </span>
  )
}

/**
 * How a PON port is named: "PON 8" rather than "gpon-olt_1/1/8" or "0/0/8".
 *
 * Every brand writes a port as numbers ending in the port itself: ZTE
 * gpon-olt_1/1/8, C-Data 0/0/8, GCOM 0/8. The last number is the port. On an
 * OLT with more than one PON card the same port number exists on each card,
 * so there the card is shown too: "PON 2/8" for port 8 on card 2.
 */
function portNamer(ports: string[]): (p: string) => string {
  const parts = (p: string) => p.split(/[^0-9]+/).filter(Boolean)
  const cards = new Set(ports.map((p) => parts(p).slice(0, -1).join('/')))
  return (p: string) => {
    const n = parts(p)
    if (n.length === 0) return p
    const port = n[n.length - 1]
    const card = n.length > 1 ? n[n.length - 2] : null
    return cards.size > 1 && card ? 'PON ' + card + '/' + port : 'PON ' + port
  }
}

/** Show one PON port's ONUs. Hidden when they are all on one port. */
function PortFilter({ ports, value, onChange }: { ports: string[]; value: string; onChange: (p: string) => void }) {
  const list = [...new Set(ports.filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  )
  const portLabel = portNamer(list)
  if (list.length < 2 && !value) return null
  return (
    <label className="flex items-center gap-2 text-xs text-gray-400">
      Show
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-100"
      >
        <option value="">All PON ports ({ports.length})</option>
        {list.map((p) => (
          <option key={p} value={p}>
            {portLabel(p)} ({ports.filter((x) => x === p).length})
          </option>
        ))}
      </select>
    </label>
  )
}

/** V-SOL ONUs, as the OLT names their maker. */
const isVsol = (vendor: string | null | undefined) => /^VSOL$/i.test(vendor ?? '')

/**
 * Pick the customer an ONU belongs to, for the ones ISPMan could not match by
 * itself — an ONU that is offline, or one with a switch behind it.
 */
function CustomerPicker({ onPick, busy }: { onPick: (id: number, name: string) => void; busy: boolean }) {
  const search = useCustomerSearch()
  return (
    <div className="relative max-w-sm">
      <input
        value={search.query}
        onChange={(e) => search.onQueryChange(e.target.value)}
        placeholder="Search the customer by name, phone or MAC"
        disabled={busy}
        className="w-full rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-100 focus:border-blue-500 focus:outline-none"
      />
      {search.showList ? (
        <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md border border-gray-700 bg-gray-900 shadow-xl">
          {search.results.length === 0 ? (
            <li className="px-2 py-1.5 text-xs text-gray-500">No customer matches.</li>
          ) : (
            search.results.slice(0, 8).map((c) => {
              const label = [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Customer #' + c.id
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => {
                      search.clear()
                      onPick(c.id, label)
                    }}
                    className="block w-full px-2 py-1.5 text-left text-xs text-gray-200 hover:bg-gray-800"
                  >
                    {label}
                    {c.address ? <span className="text-gray-500"> · {c.address}</span> : null}
                  </button>
                </li>
              )
            })
          )}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * How good a connection is, from what the ONU receives.
 *
 * The usual working limits for GPON: better than -25 dBm is comfortable, -25
 * to -27 works but has no margin left for a dirty connector or a bent fibre,
 * and below -27 the ONU will drop. Shown in words as well as colour.
 */
function signal(rx: number | null): { text: string; tone: string } {
  if (rx === null) return { text: 'No reading', tone: 'text-gray-500' }
  if (rx >= -25) return { text: rx.toFixed(1) + ' dBm · Good', tone: 'text-green-400' }
  if (rx >= -27) return { text: rx.toFixed(1) + ' dBm · Weak', tone: 'text-amber-300' }
  return { text: rx.toFixed(1) + ' dBm · Too low', tone: 'text-red-400' }
}

/**
 * An ONU's signal day by day. The line is the last reading of each day and the
 * band behind it runs from that day's weakest to its strongest.
 *
 * WHAT TO LOOK FOR IS THE SLOPE. A steady line near the limit is a long drop
 * that has always been that way; a line that falls week after week is a
 * connector going bad or a fibre being bent, and it will cut out.
 */
function SignalHistory({ days }: { days: OnuSignalDay[] }) {
  const points = days.filter((d) => d.last !== null)
  if (points.length < 2) {
    return (
      <p className="mt-4 text-[11px] text-gray-500">
        Signal history builds up from today, one point a day. It shows here after two days of readings.
      </p>
    )
  }
  const W = 560
  const H = 90
  const top = -8
  const bottom = -32
  const x = (i: number) => (points.length === 1 ? 0 : (i / (points.length - 1)) * W)
  const y = (v: number) => ((top - Math.max(bottom, Math.min(top, v))) / (top - bottom)) * H
  const line = points.map((d, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(d.last as number).toFixed(1)).join(' ')
  const band =
    points.map((d, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(d.max ?? (d.last as number)).toFixed(1)).join(' ') +
    ' ' +
    points
      .map((d, i) => ({ d, i }))
      .reverse()
      .map(({ d, i }) => 'L' + x(i).toFixed(1) + ' ' + y(d.min ?? (d.last as number)).toFixed(1))
      .join(' ') +
    ' Z'
  const first = points[0]
  const latest = points[points.length - 1]
  const change = (latest.last as number) - (first.last as number)
  return (
    <div className="mt-4">
      <p className="mb-1 text-[10px] uppercase tracking-wider text-gray-500">
        Signal at the ONU, last {points.length} days
      </p>
      <svg
        viewBox={'0 0 ' + W + ' ' + H}
        className="h-24 w-full max-w-xl"
        role="img"
        aria-label={
          'Signal from ' + (first.last as number).toFixed(1) + ' dBm on ' + first.day + ' to ' +
          (latest.last as number).toFixed(1) + ' dBm on ' + latest.day
        }
        preserveAspectRatio="none"
      >
        <rect x="0" y={y(-27)} width={W} height={H - y(-27)} className="fill-red-500/10" />
        <line x1="0" x2={W} y1={y(-27)} y2={y(-27)} className="stroke-red-500/50" strokeDasharray="4 4" strokeWidth="1" />
        <path d={band} className="fill-blue-500/15" />
        <path d={line} className="fill-none stroke-blue-400" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <p className="text-[11px] text-gray-500">
        {first.day}: {(first.last as number).toFixed(1)} dBm · {latest.day}: {(latest.last as number).toFixed(1)} dBm ·{' '}
        <span className={change <= -1.5 ? 'text-amber-300' : ''}>
          {Math.abs(change) < 0.5 ? 'steady' : (change < 0 ? 'down ' : 'up ') + Math.abs(change).toFixed(1) + ' dB'}
        </span>
        . The dashed line is -27 dBm, where the connection drops.
      </p>
    </div>
  )
}

/** "3 h 12 min", "4 min", "2 days". */
function lasted(fromIso: string, toIso: string | null, nowMs: number): string {
  const mins = Math.max(0, Math.round(((toIso ? new Date(toIso).getTime() : nowMs) - new Date(fromIso).getTime()) / 60000))
  if (mins < 60) return mins + ' min'
  if (mins < 48 * 60) return Math.floor(mins / 60) + ' h ' + (mins % 60) + ' min'
  return Math.round(mins / 1440) + ' days'
}

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })

/**
 * Every time this ONU went down, as ISPMan's background check saw it: when,
 * why, for how long, and whether it went down alone.
 *
 * ALONE OR WITH OTHERS IS THE QUESTION THAT MATTERS. Down alone with "lost
 * power" is the customer's plug; down alone with "lost fibre" is their drop
 * cable or connector; down with ten others on the same port is the fibre to
 * the street, and nothing at the house will fix it.
 */
function DropHistory({ drops, nowMs }: { drops: OnuDrop[]; nowMs: number }) {
  if (drops.length === 0) {
    return (
      <p className="mt-4 text-[11px] text-gray-500">
        No drops recorded. ISPMan records each drop from now on, checked every five minutes.
      </p>
    )
  }
  const week = drops.filter((d) => nowMs - new Date(d.downAt).getTime() < 7 * 86400000).length
  return (
    <div className="mt-4">
      <p className="mb-1 text-[10px] uppercase tracking-wider text-gray-500">
        Drops · {week} in the last 7 days{drops.length >= 50 ? ' · last 50 shown' : ''}
      </p>
      <ul className="divide-y divide-gray-800/70 rounded-md border border-gray-800 text-[11px]">
        {drops.slice(0, 12).map((d) => (
          <li key={d.downAt} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-1.5">
            <span className="w-32 shrink-0 text-gray-300">{when(d.downAt)}</span>
            <span className={/power/i.test(d.cause ?? '') ? 'text-amber-300' : 'text-red-300'}>{d.cause ?? 'Went offline'}</span>
            <span className="text-gray-400">
              {d.upAt ? 'down ' + lasted(d.downAt, d.upAt, nowMs) : 'still down, ' + lasted(d.downAt, null, nowMs)}
            </span>
            <span className={d.together >= 2 ? 'text-red-300' : 'text-gray-500'}>
              {d.together === 0 ? 'alone' : 'with ' + d.together + ' other' + (d.together === 1 ? '' : 's') + ' on this port'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * What the customer on this ONU downloaded and uploaded each day: from the
 * router's queue for that customer, the same figures as their account page.
 */
function UsageHistory({ days }: { days: UsageDay[] | null }) {
  if (!days) {
    return (
      <p className="mt-4 text-[11px] text-gray-500">
        Data history shows here once this ONU is linked to a customer whose router queue ISPMan reads.
      </p>
    )
  }
  const W = 560
  const H = 90
  const max = Math.max(1, ...days.map((d) => d.rx + d.tx))
  const bar = W / days.length
  const total = days.reduce((a, d) => a + d.rx, 0)
  const totalUp = days.reduce((a, d) => a + d.tx, 0)
  const busiest = days.reduce((a, d) => (d.rx > a.rx ? d : a), days[0])
  return (
    <div className="mt-4">
      <p className="mb-1 text-[10px] uppercase tracking-wider text-gray-500">Data used, last {days.length} days</p>
      <svg
        viewBox={'0 0 ' + W + ' ' + H}
        className="h-24 w-full max-w-xl"
        role="img"
        aria-label={'Downloaded ' + amount(total) + ' and uploaded ' + amount(totalUp) + ' over ' + days.length + ' days'}
        preserveAspectRatio="none"
      >
        {days.map((d, i) => {
          const down = (d.rx / max) * H
          const up = (d.tx / max) * H
          return (
            <g key={d.day}>
              <title>{d.day + ': ' + amount(d.rx) + ' down, ' + amount(d.tx) + ' up'}</title>
              <rect x={i * bar + 0.5} y={H - down - up} width={Math.max(1, bar - 1)} height={down} className="fill-blue-400/80" />
              <rect x={i * bar + 0.5} y={H - up} width={Math.max(1, bar - 1)} height={up} className="fill-emerald-400/80" />
            </g>
          )
        })}
      </svg>
      <p className="text-[11px] text-gray-500">
        <span className="text-blue-400">■</span> Download {amount(total)} ·{' '}
        <span className="text-emerald-400">■</span> Upload {amount(totalUp)} · busiest day {busiest.day} ({amount(busiest.rx)} down)
      </p>
    </div>
  )
}

const speed = (bps: number | null): string => {
  if (bps === null) return '—'
  if (bps >= 1e6) return (bps / 1e6).toFixed(1) + ' Mbps'
  if (bps >= 1e3) return (bps / 1e3).toFixed(0) + ' kbps'
  return bps + ' bps'
}

/** A byte count since the OLT last cleared its counters. */
const amount = (bytes: number | null): string => {
  if (bytes === null) return '—'
  if (bytes >= 1e12) return (bytes / 1e12).toFixed(2) + ' TB'
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB'
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + ' MB'
  return Math.round(bytes / 1e3) + ' kB'
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-gray-500">{label}</dt>
      <dd className={'mt-0.5 text-xs ' + (tone ?? 'text-gray-200')}>{value}</dd>
    </div>
  )
}

/**
 * One authorised ONU. The row is the summary; opening it reads the ONU's
 * signal and history from the OLT there and then, and offers what can be done
 * to it.
 *
 * REMOVE ASKS FIRST, AND SAYS WHAT IT DOES. It takes the customer off the
 * network until the ONU is authorised again, which is the right thing when an
 * ONU is being moved and a bad thing to do by a slip of the mouse.
 */
function OnuRow({
  oltId, brand, onu, customer, seen, canManage, onChanged, focused = false,
}: {
  oltId: number
  brand: string
  onu: OltOnu
  customer: OnuCustomer | null
  seen?: { online: boolean; lastSeen: string | null }
  canManage: boolean
  onChanged: () => void
  /** The ONU the search led here: opened, read, and scrolled to. */
  focused?: boolean
}) {
  const [open, setOpen] = useState(focused)
  const rowRef = useRef<HTMLTableRowElement>(null)
  const [detail, setDetail] = useState<OltOnuDetail | null>(null)
  const [history, setHistory] = useState<OnuSignalDay[]>([])
  const [drops, setDrops] = useState<OnuDrop[]>([])
  const [usage, setUsage] = useState<UsageDay[] | null>(null)
  // The moment of the last reading, so "still down for 2 h" is measured from
  // something fixed rather than the clock at each render.
  const [readAt, setReadAt] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [mode, setMode] = useState<'view' | 'rename' | 'remove' | 'link' | 'disable' | 'vsol'>('view')
  // What this screen last did, until the list is read again.
  const [disabledNow, setDisabledNow] = useState<boolean | null>(null)
  const isDisabled = disabledNow ?? detail?.disabled ?? onu.disabled ?? false
  // A link made on this screen shows at once, without reading the OLT again.
  const [picked, setPicked] = useState<OnuCustomer | null>(null)
  const owner = picked ?? customer
  const link = async (customerId: number, customerName: string) => {
    if (!onu.sn) return
    setBusy('link')
    setNote(null)
    const res = await linkOnu({ oltId, serial: onu.sn, onuRef: onu.id, model: onu.type, customerId })
    setBusy(null)
    setMode('view')
    if (res.ok) setPicked({ customerId, name: customerName, linkedBy: 'manual' })
    else setNote({ ok: false, text: res.error })
  }
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  const read = async () => {
    setBusy('read')
    const res = await loadOnuDetail(oltId, onu.id)
    setBusy(null)
    if (res.ok) {
      setDetail(res.detail)
      setHistory(res.signal)
      setDrops(res.drops)
      setUsage(res.usage)
      setReadAt(Date.now())
      setName(res.detail.name ?? '')
      setDescription(res.detail.description ?? '')
    } else {
      setNote({ ok: false, text: res.error })
    }
  }
  useEffect(() => {
    if (!focused) return
    const t = window.setTimeout(() => {
      rowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      void read()
    }, 0)
    return () => window.clearTimeout(t)
    // Once, when the row first appears for the ONU searched for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused])

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && !detail && !busy) void read()
  }
  const act = async (action: OltOnuAction) => {
    setBusy(action.kind)
    setNote(null)
    const res = await onuCommand({ oltId, onuId: onu.id, action })
    setBusy(null)
    setMode('view')
    setNote(res.ok ? { ok: true, text: res.message } : { ok: false, text: res.error })
    if (res.ok && action.kind === 'remove') onChanged()
    if (res.ok && action.kind === 'rename') void read()
    if (res.ok && (action.kind === 'disable' || action.kind === 'enable')) {
      setDisabledNow(action.kind === 'disable')
      void read()
    }
  }

  const rx = signal(detail?.onuRx ?? null)
  const small =
    'rounded-md bg-gray-800 px-2.5 py-1 text-[11px] font-medium text-gray-200 hover:bg-gray-700 disabled:opacity-50'
  const field =
    'w-full rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-100 focus:border-blue-500 focus:outline-none'

  return (
    <>
      <tr ref={rowRef} className={'border-t border-gray-800' + (focused ? ' bg-blue-950/40' : '')}>
        <td className={td + ' font-mono'}>{onu.id}</td>
        <td className={td + ' font-mono'}>{onu.sn ?? '—'}</td>
        <td className={td + ' font-mono text-[11px]'}>
          {onu.macs && onu.macs.length ? (
            <span title={onu.macs.join('\n')}>
              {onu.macs[0]}
              {onu.macs.length > 1 ? <span className="text-gray-500"> +{onu.macs.length - 1}</span> : null}
            </span>
          ) : (
            <span className="text-gray-600">—</span>
          )}
        </td>
        <td className={td}>
          {owner ? (
            <Link href={'/dashboard/customers/' + owner.customerId} className="text-blue-400 hover:underline">
              {owner.name}
            </Link>
          ) : (
            <span className="text-gray-600">Not linked</span>
          )}
          {owner && !picked ? <Browsing seen={seen} onuOnline={onu.online} /> : null}
        </td>
        <td
          className={
            td +
            (isDisabled || (onu.online && /fail/i.test(onu.phase))
              ? ' text-amber-300'
              : onu.online
                ? ' text-green-400'
                : ' text-red-400')
          }
        >
          {isDisabled
            ? 'Disabled'
            : onu.online
              ? /fail/i.test(onu.phase)
                ? 'Online, settings not applied'
                : 'Online'
              : 'Offline (' + onu.phase + ')'}
        </td>
        <td className={td}>
          <SignalBars label="RX" dbm={onu.rx ?? null} side="onu" />
        </td>
        <td className={td}>
          <SignalBars label="TX" dbm={onu.tx ?? null} side="olt" />
        </td>
        <td className={td + ' text-right'}>
          <button type="button" onClick={toggle} className={small} aria-expanded={open}>
            {open ? 'Close' : 'Open'}
          </button>
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={8} className="pb-4">
            <div className="rounded-lg border border-gray-800 bg-gray-950/60 p-4">
              {busy === 'read' && !detail ? (
                <p className="text-xs text-gray-500">Reading the ONU…</p>
              ) : detail ? (
                <>
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
                    <Fact label="Name" value={detail.name ?? '—'} />
                    <Fact label="Signal at the ONU" value={rx.text} tone={rx.tone} />
                    <Fact
                      label="Signal at the OLT"
                      value={detail.oltRx === null ? 'No reading' : detail.oltRx.toFixed(1) + ' dBm'}
                    />
                    <Fact label="Distance" value={detail.distance ?? '—'} />
                    <Fact label="Online for" value={detail.online ? detail.onlineFor ?? '—' : 'Offline'} />
                    <Fact label="Make" value={detail.vendor ?? '—'} />
                    <Fact label="Model" value={detail.model ?? '—'} />
                    <Fact label="Firmware" value={detail.firmware ?? '—'} />
                  </dl>
                  {detail.description ? (
                    <p className="mt-3 text-xs text-gray-400">Note: {detail.description}</p>
                  ) : null}

                  {detail.traffic ? (
                    <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
                      <Fact label="Download now" value={speed(detail.traffic.downBps)} />
                      <Fact label="Upload now" value={speed(detail.traffic.upBps)} />
                      <Fact label="Downloaded" value={amount(detail.traffic.downBytes)} />
                      <Fact label="Uploaded" value={amount(detail.traffic.upBytes)} />
                    </dl>
                  ) : null}

                  <div className="grid gap-x-8 lg:grid-cols-2">
                    <SignalHistory days={history} />
                    <UsageHistory days={usage} />
                  </div>
                  <DropHistory drops={drops} nowMs={readAt} />

                  {detail.history.length ? (
                    <div className="mt-4">
                      <p className="mb-1 text-[10px] uppercase tracking-wider text-gray-500">
                        The OLT&apos;s own record
                      </p>
                      <ul className="space-y-0.5 text-[11px] text-gray-400">
                        {detail.history.slice(0, 5).map((h) => (
                          <li key={h.up}>
                            Up {h.up}
                            {h.down ? ' · down ' + h.down : ' · still up'}
                            {h.cause ? ' · ' + h.cause : ''}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </>
              ) : null}

              {canManage && mode === 'view' ? (
                <div className="mt-4 flex flex-wrap gap-2">
                  <button type="button" onClick={() => void read()} disabled={!!busy} className={small}>
                    {busy === 'read' ? 'Reading…' : 'Read again'}
                  </button>
                  <button type="button" onClick={() => void act({ kind: 'reboot' })} disabled={!!busy} className={small}>
                    {busy === 'reboot' ? 'Rebooting…' : 'Reboot'}
                  </button>
                  {isDisabled ? (
                    <button
                      type="button"
                      onClick={() => void act({ kind: 'enable' })}
                      disabled={!!busy}
                      className={small + ' text-green-300'}
                    >
                      {busy === 'enable' ? 'Enabling…' : 'Enable'}
                    </button>
                  ) : (
                    <button type="button" onClick={() => setMode('disable')} disabled={!!busy} className={small + ' text-amber-300'}>
                      Disable
                    </button>
                  )}
                  <button type="button" onClick={() => setMode('rename')} disabled={!!busy} className={small}>
                    Rename
                  </button>
                  {brand === 'gcom' && isVsol(detail?.vendor) ? (
                    <button type="button" onClick={() => setMode('vsol')} disabled={!!busy} className={small}>
                      Set up for V-SOL
                    </button>
                  ) : null}
                  {onu.sn ? (
                    <button type="button" onClick={() => setMode('link')} disabled={!!busy} className={small}>
                      {owner ? 'Change customer' : 'Link to a customer'}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setMode('remove')}
                    disabled={!!busy}
                    className={small + ' text-red-300'}
                  >
                    Remove
                  </button>
                </div>
              ) : null}

              {mode === 'vsol' ? (
                <div className="mt-4 space-y-2 rounded-md border border-amber-900/60 bg-amber-950/30 p-3">
                  <p className="text-xs text-amber-200">
                    This sets the two things a V-SOL ONU needs on this OLT before it passes traffic, on
                    this ONU only. The OLT is asked who made the ONU first, and nothing is changed unless
                    it says V-SOL. The same settings on any other make cut the customer off.
                  </p>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => void act({ kind: 'vsol-fix' })} disabled={!!busy} className={button}>
                      {busy === 'vsol-fix' ? 'Setting up…' : 'Set up for V-SOL'}
                    </button>
                    <button type="button" onClick={() => setMode('view')} className={small}>Cancel</button>
                  </div>
                </div>
              ) : null}

              {mode === 'rename' ? (
                <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto]">
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className={field} maxLength={60} />
                  <input
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Note (address, pole, customer)"
                    className={field}
                    maxLength={120}
                  />
                  <button
                    type="button"
                    onClick={() => void act({ kind: 'rename', name, description })}
                    disabled={!!busy || (!name.trim() && !description.trim())}
                    className={button}
                  >
                    {busy === 'rename' ? 'Saving…' : 'Save'}
                  </button>
                  <button type="button" onClick={() => setMode('view')} className={small}>Cancel</button>
                  <p className="text-[11px] text-gray-500 sm:col-span-4">
                    The OLT stores these as single words, so spaces are saved as dashes.
                  </p>
                </div>
              ) : null}

              {mode === 'link' ? (
                <div className="mt-4 space-y-2">
                  <p className="text-xs text-gray-400">
                    {owner
                      ? 'Linked to ' + owner.name + (owner.linkedBy === 'auto' ? ', matched by ISPMan.' : '.') + ' Pick another customer to change it.'
                      : 'Pick the customer this ONU is installed for.'}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <CustomerPicker onPick={(id, n) => void link(id, n)} busy={busy === 'link'} />
                    <button type="button" onClick={() => setMode('view')} className={small}>Cancel</button>
                  </div>
                </div>
              ) : null}

              {mode === 'disable' ? (
                <div className="mt-4 rounded-lg border border-amber-900/50 bg-amber-950/20 p-3">
                  <p className="text-xs text-amber-100">
                    Disable {owner ? owner.name + "'s ONU" : onu.sn ?? onu.id}? It stays registered with all its
                    settings, but the customer has no service until you enable it again.
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={() => void act({ kind: 'disable' })}
                      disabled={!!busy}
                      className="rounded-md bg-amber-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-amber-500 disabled:opacity-50"
                    >
                      {busy === 'disable' ? 'Disabling…' : 'Yes, disable it'}
                    </button>
                    <button type="button" onClick={() => setMode('view')} className={small}>Cancel</button>
                  </div>
                </div>
              ) : null}

              {mode === 'remove' ? (
                <div className="mt-4 rounded-lg border border-red-900/50 bg-red-950/20 p-3">
                  <p className="text-xs text-red-200">
                    Remove {onu.sn ?? onu.id} from the OLT? The customer on it loses service until
                    the ONU is authorized again.
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={() => void act({ kind: 'remove' })}
                      disabled={!!busy}
                      className="rounded-md bg-red-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-red-500 disabled:opacity-50"
                    >
                      {busy === 'remove' ? 'Removing…' : 'Yes, remove it'}
                    </button>
                    <button type="button" onClick={() => setMode('view')} className={small}>Cancel</button>
                  </div>
                </div>
              ) : null}

              {note ? (
                <p
                  className={
                    'mt-3 rounded-lg px-3 py-2 text-xs ' +
                    (note.ok ? 'bg-emerald-950/40 text-emerald-300' : 'bg-red-950/30 text-red-300')
                  }
                >
                  {note.text}
                </p>
              ) : null}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  )
}

export function OnuPanel({
  oltId, brand, view, lists, loading, error, canManage, vlans, defaultVlan, onReload, freshness = null, focus = null,
}: {
  oltId: number
  brand: string
  view: 'authorised' | 'offline' | 'pending'
  lists: OnuLists | null
  loading: boolean
  error: string | null
  canManage: boolean
  /** VLANs that exist on the OLT, to choose from. */
  vlans: number[]
  defaultVlan: number | null
  onReload: () => void
  /** Set while the list is the saved one, not yet a live reading: its age in words. */
  freshness?: string | null
  /** Open on this ONU (from the ONU search): its port filtered, its row open. */
  focus?: { port: string; serial: string } | null
}) {
  const [vlan, setVlan] = useState<number | null>(defaultVlan)
  const [busy, setBusy] = useState<string | null>(null)
  // One PON port at a time, or all of them.
  const [port, setPort] = useState<string>(focus?.port ?? '')
  const [progress, setProgress] = useState<string | null>(null)
  const [outcomes, setOutcomes] = useState<OltAuthoriseResult[]>([])
  const [problem, setProblem] = useState<string | null>(null)

  const run = async (items: { port: string; sn: string }[] | 'all', label: string) => {
    if (!vlan) {
      setProblem('Choose the VLAN to put them on first.')
      return
    }
    setBusy(label)
    setProblem(null)
    setOutcomes([])
    const all: OltAuthoriseResult[] = []
    try {
      // ONE BAD ONU DOES NOT STOP THE REST. Each round is handed the serials
      // that already failed, so it moves on to ONUs not yet tried; the run
      // ends when every waiting ONU has been tried once, with the failures
      // listed and their reasons. It stops early only if the OLT itself stops
      // answering.
      const failedSn: string[] = []
      for (let round = 0; round < 80; round += 1) {
        const res = await authoriseOnus({ oltId, vlan, items, skip: failedSn })
        if (!res.ok) {
          setProblem(
            res.error + (all.length ? ' Stopped after ' + all.filter((r) => r.ok).length + ' authorized.' : '')
          )
          break
        }
        all.push(...res.results)
        failedSn.push(...res.results.filter((r) => !r.ok).map((r) => r.sn))
        setOutcomes([...all])
        if (items !== 'all' || res.results.length === 0 || res.remaining === 0) break
        setProgress(
          all.filter((r) => r.ok).length + ' done' + (failedSn.length ? ', ' + failedSn.length + ' failed' : '') +
            ', ' + res.remaining + ' to go…'
        )
      }
    } finally {
      setBusy(null)
      setProgress(null)
      onReload()
    }
  }

  if (loading && !lists) return <p className="px-1 py-6 text-sm text-gray-500">Reading the OLT…</p>
  if (error && !lists) {
    return (
      <div className="px-1 py-4">
        <p className="rounded-lg bg-red-950/30 px-3 py-2 text-xs text-red-300">{error}</p>
        <button type="button" onClick={onReload} className={button + ' mt-3'}>Try again</button>
      </div>
    )
  }
  if (!lists) return null

  // Shown until the live reading lands: the list is real, just a few minutes old.
  const banner =
    freshness || (loading && lists) ? (
      <p className="mb-2 flex items-center gap-2 text-[11px] text-gray-500">
        <span className={'inline-block h-1.5 w-1.5 rounded-full ' + (loading ? 'animate-pulse bg-blue-400' : 'bg-gray-500')} />
        {freshness
          ? 'Showing the reading from ' + freshness + '. Updating from the OLT…'
          : 'Updating from the OLT…'}
      </p>
    ) : null

  const failed = outcomes.filter((o) => !o.ok)
  const succeeded = outcomes.filter((o) => o.ok)

  if (view === 'pending') {
    return (
      <div className="py-2">
        {banner}
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
          <label className="flex items-center gap-2 text-xs text-gray-400">
            Put them on VLAN
            {vlans.length ? (
              <select
                value={vlan ?? ''}
                onChange={(e) => setVlan(Number(e.target.value) || null)}
                className="rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-100"
              >
                <option value="">Choose…</option>
                {vlans.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            ) : (
              <input
                type="number"
                min={1}
                max={4094}
                value={vlan ?? ''}
                onChange={(e) => setVlan(Number(e.target.value) || null)}
                className="w-20 rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-100"
              />
            )}
          </label>
          <div className="flex items-center gap-2">
            <PortFilter ports={lists.pending.map((p) => p.port)} value={port} onChange={setPort} />
            <button type="button" onClick={onReload} disabled={loading || !!busy} className={button + ' bg-gray-700 hover:bg-gray-600'}>
              {loading ? 'Reading…' : 'Look again'}
            </button>
            {canManage && lists.pending.length > 0 ? (
              <button type="button" onClick={() => run('all', 'all')} disabled={!!busy} className={button}>
                {busy === 'all' ? progress ?? 'Authorizing…' : 'Authorize all (' + lists.pending.length + ')'}
              </button>
            ) : null}
          </div>
        </div>

        {problem ? <p className="mb-3 rounded-lg bg-red-950/30 px-3 py-2 text-xs text-red-300">{problem}</p> : null}
        {succeeded.length ? (
          <p className="mb-3 rounded-lg bg-emerald-950/40 px-3 py-2 text-xs text-emerald-300">
            {succeeded.length} authorized: {succeeded.map((o) => o.sn).join(', ')}
          </p>
        ) : null}
        {failed.length ? (
          <div className="mb-3 rounded-lg bg-red-950/30 px-3 py-2 text-xs text-red-300">
            <p className="font-semibold">
              {failed.length} could not be authorized. The rest carried on without them.
            </p>
            <ul className="mt-1 space-y-0.5">
              {failed.map((o) => (
                <li key={o.sn}>
                  <span className="font-mono">{o.sn}</span>: {o.error}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {lists.pending.length === 0 ? (
          <p className="px-1 py-6 text-sm text-gray-500">
            No ONUs are waiting. A new ONU appears here within a few seconds of being plugged into
            a working PON port.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className={th}>PON port</th>
                  <th className={th}>Serial number</th>
                  <th className={th}>Model</th>
                  <th className={th}></th>
                </tr>
              </thead>
              <tbody>
                {(port ? lists.pending.filter((p) => p.port === port) : lists.pending).map((p) => (
                  <tr key={p.port + p.sn} className="border-t border-gray-800">
                    <td className={td + ' font-mono'}>{p.port}</td>
                    <td className={td + ' font-mono'}>{p.sn}</td>
                    <td className={td}>{p.model ?? '—'}</td>
                    <td className={td + ' text-right'}>
                      {canManage ? (
                        <button
                          type="button"
                          onClick={() => run([{ port: p.port, sn: p.sn }], p.sn)}
                          disabled={!!busy}
                          className={button}
                        >
                          {busy === p.sn ? 'Authorizing…' : 'Authorize'}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="pt-3 text-[11px] leading-relaxed text-gray-500">
          Authorizing registers the ONU and carries its traffic on the VLAN above inside the OLT.
          Nothing is set on the ONU itself, so it works with VLAN switched off.
        </p>
      </div>
    )
  }

  const onPort = port ? lists.onus.filter((o) => o.port === port) : lists.onus
  const shown = view === 'offline' ? onPort.filter((o) => !o.online) : onPort
  return (
    <div className="py-2">
      {banner}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-3">
        <div className="flex flex-wrap items-center gap-3">
          <PortFilter ports={lists.onus.map((o) => o.port)} value={port} onChange={setPort} />
          <p className="text-xs text-gray-500">
            {view === 'offline'
              ? shown.length + ' of ' + onPort.length + ' authorized ONUs are not in service'
              : onPort.filter((o) => o.online).length + ' of ' + onPort.length + ' online'}
          </p>
        </div>
        <button type="button" onClick={onReload} disabled={loading} className={button + ' bg-gray-700 hover:bg-gray-600'}>
          {loading ? 'Reading…' : 'Look again'}
        </button>
      </div>
      {shown.length === 0 ? (
        <p className="px-1 py-6 text-sm text-gray-500">
          {view === 'offline' ? 'No authorized ONUs are offline.' : 'No ONUs have been authorized on this OLT yet.'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className={th}>ONU</th>
                <th className={th}>Serial number</th>
                <th className={th}>MAC</th>
                <th className={th}>Customer</th>
                <th className={th}>Status</th>
                <th className={th}>RX</th>
                <th className={th}>TX</th>
                <th className={th}></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((o) => (
                <OnuRow
                  key={o.id}
                  oltId={oltId}
                  brand={brand}
                  onu={o}
                  customer={(o.sn && lists.customers?.[o.sn.toUpperCase()]) || null}
                  seen={(() => {
                    const c = o.sn ? lists.customers?.[o.sn.toUpperCase()] : undefined
                    return c ? lists.seen?.[c.customerId] : undefined
                  })()}
                  canManage={canManage}
                  onChanged={onReload}
                  focused={Boolean(focus && o.sn && o.sn.toUpperCase() === focus.serial)}
                />
              ))}
            </tbody>
          </table>
          <p className="pt-3 text-[11px] leading-relaxed text-gray-500">
            RX is the signal the ONU receives. TX is the ONU&apos;s own signal as it reaches the OLT.
            Both in dBm; closer to zero is stronger. A customer is filled in when the OLT sees
            their router behind the ONU. That alone does not mean they can browse: under the name,
            Browsing now means their router is logged in.
          </p>
        </div>
      )}
    </div>
  )
}
