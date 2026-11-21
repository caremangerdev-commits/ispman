'use client'

import Link from 'next/link'
import { useState } from 'react'

import { authoriseOnus, linkOnu, loadOnuDetail, onuCommand, type OnuSignalDay } from '@/app/actions/olts'
import { useCustomerSearch } from '@/components/customers/useCustomerSearch'
import { SignalBars } from '@/components/network/SignalBars'
import type { OnuCustomer } from '@/lib/data/customer-devices'
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
}

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
  oltId, onu, customer, canManage, onChanged,
}: {
  oltId: number
  onu: OltOnu
  customer: OnuCustomer | null
  canManage: boolean
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<OltOnuDetail | null>(null)
  const [history, setHistory] = useState<OnuSignalDay[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [mode, setMode] = useState<'view' | 'rename' | 'remove' | 'link'>('view')
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
      setName(res.detail.name ?? '')
      setDescription(res.detail.description ?? '')
    } else {
      setNote({ ok: false, text: res.error })
    }
  }
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
  }

  const rx = signal(detail?.onuRx ?? null)
  const small =
    'rounded-md bg-gray-800 px-2.5 py-1 text-[11px] font-medium text-gray-200 hover:bg-gray-700 disabled:opacity-50'
  const field =
    'w-full rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-100 focus:border-blue-500 focus:outline-none'

  return (
    <>
      <tr className="border-t border-gray-800">
        <td className={td + ' font-mono'}>{onu.id}</td>
        <td className={td + ' font-mono'}>{onu.sn ?? '—'}</td>
        <td className={td}>
          {owner ? (
            <Link href={'/dashboard/customers/' + owner.customerId} className="text-blue-400 hover:underline">
              {owner.name}
            </Link>
          ) : (
            <span className="text-gray-600">Not linked</span>
          )}
        </td>
        <td className={td + (onu.online ? ' text-green-400' : ' text-red-400')}>
          {onu.online ? 'Online' : 'Offline (' + onu.phase + ')'}
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
          <td colSpan={7} className="pb-4">
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

                  <SignalHistory days={history} />

                  {detail.history.length ? (
                    <div className="mt-4">
                      <p className="mb-1 text-[10px] uppercase tracking-wider text-gray-500">
                        Recent ups and downs
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
                  <button type="button" onClick={() => setMode('rename')} disabled={!!busy} className={small}>
                    Rename
                  </button>
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
  oltId, view, lists, loading, error, canManage, vlans, defaultVlan, onReload,
}: {
  oltId: number
  view: 'authorised' | 'offline' | 'pending'
  lists: OnuLists | null
  loading: boolean
  error: string | null
  canManage: boolean
  /** VLANs that exist on the OLT, to choose from. */
  vlans: number[]
  defaultVlan: number | null
  onReload: () => void
}) {
  const [vlan, setVlan] = useState<number | null>(defaultVlan)
  const [busy, setBusy] = useState<string | null>(null)
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
      // Keep asking while there is work left and the last round achieved
      // something. If a round authorises nothing, stop: repeating it would
      // only fail the same way again.
      for (let round = 0; round < 40; round += 1) {
        const res = await authoriseOnus({ oltId, vlan, items })
        if (!res.ok) {
          setProblem(res.error)
          break
        }
        all.push(...res.results)
        setOutcomes([...all])
        const worked = res.results.filter((r) => r.ok).length
        if (items !== 'all' || res.remaining === 0 || worked === 0) break
        setProgress(res.remaining + ' still to do…')
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

  const failed = outcomes.filter((o) => !o.ok)
  const succeeded = outcomes.filter((o) => o.ok)

  if (view === 'pending') {
    return (
      <div className="py-2">
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
        {failed.map((o) => (
          <p key={o.sn} className="mb-2 rounded-lg bg-red-950/30 px-3 py-2 text-xs text-red-300">
            {o.sn}: {o.error}
          </p>
        ))}

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
                {lists.pending.map((p) => (
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

  const shown = view === 'offline' ? lists.onus.filter((o) => !o.online) : lists.onus
  return (
    <div className="py-2">
      <div className="flex items-center justify-between pb-3">
        <p className="text-xs text-gray-500">
          {view === 'offline'
            ? shown.length + ' of ' + lists.onus.length + ' authorized ONUs are not in service'
            : lists.onus.filter((o) => o.online).length + ' of ' + lists.onus.length + ' online'}
        </p>
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
                  onu={o}
                  customer={(o.sn && lists.customers?.[o.sn.toUpperCase()]) || null}
                  canManage={canManage}
                  onChanged={onReload}
                />
              ))}
            </tbody>
          </table>
          <p className="pt-3 text-[11px] leading-relaxed text-gray-500">
            RX is the signal the ONU receives. TX is the ONU&apos;s own signal as it reaches the OLT.
            Both in dBm; closer to zero is stronger. A customer is filled in when the OLT sees
            their router behind the ONU.
          </p>
        </div>
      )}
    </div>
  )
}
