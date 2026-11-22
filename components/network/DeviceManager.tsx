'use client'

import { Modal } from '@/components/settings/Modal'
import Link from 'next/link'
import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'

import { assignToSite } from '@/app/actions/sites'
import {
  addDevice, addFoundDevices, discoverDevices, removeDevice, setDeviceKind,
  type DeviceActionResult, type DiscoverResult, type FoundDevice,
} from '@/app/actions/devices'
import { DeviceIcon } from '@/components/network/DeviceIcon'
import { DEVICE_BRANDS, DEVICE_KINDS, kindLabel } from '@/lib/network/classify'

/**
 * Every device on the network in one list, with two ways to add more: find
 * what is already out there, or type one in.
 *
 * ROUTERS AND OLTS APPEAR HERE BUT ARE ADDED ELSEWHERE. ISPMan logs in to
 * those, so each has its own setup and its own page; this list links to them.
 * Choosing Router or OLT in the type dropdown says so and points the way,
 * rather than offering a form that could not do the job.
 */

export type SiteOption = { id: number; name: string }

export type InventoryRow = {
  key: string
  kind: string
  name: string
  brand: string | null
  model: string | null
  ip: string | null
  mac: string | null
  where: string | null
  /** The customer this device is installed for, if it is linked to one. */
  customer?: { id: number; name: string } | null
  /** Set for routers and OLTs: the page that manages them. */
  href: string | null
  /** Set for rows that live in the devices table and can be edited here. */
  deviceId: number | null
  status: 'up' | 'down' | null
  /** How to put this row at a site: which table, which id. */
  place: { table: 'device' | 'olt' | 'router'; id: number }
  siteId: number | null
  /** Backhauls: the site at the far end. */
  linksToSiteId: number | null
}

const input =
  'w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 ' +
  'placeholder:text-gray-600 focus:border-blue-500 focus:outline-none'
const label = 'mb-1 block text-xs font-medium text-gray-400'
const small =
  'rounded-md bg-gray-800 px-2.5 py-1 text-[11px] font-medium text-gray-200 hover:bg-gray-700 disabled:opacity-50'
const primary =
  'rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-60'
const th = 'px-4 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-gray-500'
const td = 'px-4 py-2.5 text-xs text-gray-300'

function Submit({ children, pending }: { children: string; pending: string }) {
  const status = useFormStatus()
  return (
    <button type="submit" disabled={status.pending} className={primary}>
      {status.pending ? pending : children}
    </button>
  )
}

function Note({ state }: { state: DeviceActionResult | null }) {
  if (!state) return null
  return (
    <p
      role="status"
      className={
        'mt-3 rounded-lg px-3 py-2 text-xs ' +
        (state.ok ? 'bg-emerald-950/40 text-emerald-300' : 'bg-red-950/40 text-red-300')
      }
    >
      {state.ok ? state.message : state.error}
    </p>
  )
}

/* ------------------------------ Add by hand ------------------------------ */

function AddForm({ onDone }: { onDone: () => void }) {
  const [state, action] = useActionState(async (prev: DeviceActionResult | null, fd: FormData) => {
    const res = await addDevice(prev, fd)
    if (res.ok) onDone()
    return res
  }, null)
  const [kind, setKind] = useState('ap')

  return (
    <form action={action} className="space-y-4">
      <div className="flex items-center gap-4">
        <DeviceIcon kind={kind} className="h-14 w-14 shrink-0 text-blue-300" />
        <div className="flex-1">
          <label className={label} htmlFor="dev-kind">Type of device</label>
          <select id="dev-kind" name="kind" className={input} value={kind} onChange={(e) => setKind(e.target.value)}>
            {DEVICE_KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>{k.label}</option>
            ))}
          </select>
        </div>
      </div>

      {kind === 'router' ? (
        <p className="rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-3 text-xs leading-relaxed text-gray-300">
          Routers are added under{' '}
          <Link href="/dashboard/settings/tunnels" className="text-blue-400 hover:underline">
            Settings → Router Tunnels
          </Link>
          , where ISPMan gives you one command to paste into the router. That connects it, and
          turns on its traffic, health and usage here.
        </p>
      ) : kind === 'olt' ? (
        <p className="rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-3 text-xs leading-relaxed text-gray-300">
          OLTs are added under{' '}
          <Link href="/dashboard/network/olts" className="text-blue-400 hover:underline">
            Network → OLTs
          </Link>
          , where ISPMan logs in to the OLT and shows its cards, ports and ONUs.
        </p>
      ) : kind === 'onu' ? (
        <>
          <p className="text-xs leading-relaxed text-gray-400">
            ONUs on an OLT that ISPMan manages are listed on that OLT&apos;s page and do not need
            adding here. Use this only for an ONU on an OLT ISPMan is not connected to.
          </p>
          <Fields />
          <Submit pending="Adding…">Add device</Submit>
        </>
      ) : (
        <>
          <Fields />
          <Submit pending="Adding…">Add device</Submit>
        </>
      )}
      <Note state={state} />
    </form>
  )
}

function Fields() {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div>
        <label className={label} htmlFor="dev-name">Name</label>
        <input id="dev-name" name="name" className={input} placeholder="Tower 2 north sector" required maxLength={120} />
      </div>
      <div>
        <label className={label} htmlFor="dev-brand">Brand</label>
        <select id="dev-brand" name="brand" className={input} defaultValue="">
          <option value="">Choose…</option>
          {DEVICE_BRANDS.map((b) => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>
      </div>
      <div>
        <label className={label} htmlFor="dev-model">Model</label>
        <input id="dev-model" name="model" className={input} placeholder="LiteBeam 5AC" maxLength={80} />
      </div>
      <div>
        <label className={label} htmlFor="dev-ip">IP address</label>
        <input id="dev-ip" name="ip" className={input} placeholder="10.10.4.20" inputMode="decimal" />
      </div>
      <div>
        <label className={label} htmlFor="dev-mac">MAC address</label>
        <input id="dev-mac" name="mac" className={input} placeholder="AA:BB:CC:DD:EE:FF" />
      </div>
      <div>
        <label className={label} htmlFor="dev-notes">Note</label>
        <input id="dev-notes" name="notes" className={input} placeholder="Where it is, what it serves" maxLength={200} />
      </div>
    </div>
  )
}

/* -------------------------------- Discover -------------------------------- */

const GROUPS: { id: FoundDevice['group']; title: string; note: string }[] = [
  {
    id: 'network',
    title: 'Your network',
    note: 'Radios, switches and routers that belong to no customer. Check the type of each before adding.',
  },
  {
    id: 'customer',
    title: "Wireless customers' radios",
    note: "Each one carries the MAC address of the customer shown, so it is added linked to them.",
  },
  {
    id: 'unmatched',
    title: 'Radios not matched to a customer',
    note:
      'These got their address like a customer radio, but no customer has this MAC address. ' +
      "The name is what the radio calls itself. Add them, then link each from the customer's page.",
  },
]

function FoundTable({
  items, picked, kinds, onPick, onKind,
}: {
  items: FoundDevice[]
  picked: Record<string, boolean>
  kinds: Record<string, string>
  onPick: (mac: string, value: boolean) => void
  onKind: (mac: string, kind: string) => void
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-800">
      <table className="w-full">
        <thead>
          <tr>
            <th className={th}></th>
            <th className={th}>Device</th>
            <th className={th}>Type</th>
            <th className={th}>IP</th>
            <th className={th}>MAC</th>
            <th className={th}>Seen by</th>
          </tr>
        </thead>
        <tbody>
          {items.map((f) => (
            <tr key={f.mac} className="border-t border-gray-800">
              <td className={td}>
                <input
                  type="checkbox"
                  aria-label={'Select ' + f.name}
                  checked={!!picked[f.mac]}
                  onChange={(e) => onPick(f.mac, e.target.checked)}
                />
              </td>
              <td className={td}>
                <span className="flex items-center gap-2">
                  <DeviceIcon kind={kinds[f.mac] ?? f.kind} className="h-7 w-7 shrink-0 text-gray-400" />
                  <span>
                    <span className="block font-medium text-white">{f.name}</span>
                    <span className="block text-[11px] text-gray-500">
                      {f.customer ? (
                        <Link href={'/dashboard/customers/' + f.customer.id} className="text-blue-400 hover:underline">
                          {f.customer.name}
                        </Link>
                      ) : (
                        [f.brand, f.model, f.version].filter(Boolean).join(' · ') || 'Maker not known'
                      )}
                    </span>
                  </span>
                </span>
              </td>
              <td className={td}>
                <select
                  aria-label={'Type of ' + f.name}
                  value={kinds[f.mac] ?? f.kind}
                  onChange={(e) => onKind(f.mac, e.target.value)}
                  className="rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-100"
                >
                  {DEVICE_KINDS.filter((k) => k.kind !== 'olt').map((k) => (
                    <option key={k.kind} value={k.kind}>{k.label}</option>
                  ))}
                </select>
              </td>
              <td className={td + ' font-mono'}>{f.ip ?? '—'}</td>
              <td className={td + ' font-mono'}>{f.mac}</td>
              <td className={td}>
                {f.routerName}
                {f.heardOn ? <span className="text-gray-500"> · {f.heardOn}</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Discover({ sites }: { sites: SiteOption[] }) {
  const [site, setSite] = useState('')
  const [result, setResult] = useState<DiscoverResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [kinds, setKinds] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState<DeviceActionResult | null>(null)

  const scan = async () => {
    setBusy(true)
    setSaved(null)
    const res = await discoverDevices()
    setResult(res)
    // The network's own gear and radios already tied to a customer are what
    // people add; radios no customer matched are left for a look first.
    setPicked(
      res.ok ? Object.fromEntries(res.found.filter((f) => f.group !== 'unmatched').map((f) => [f.mac, true])) : {}
    )
    setKinds({})
    setBusy(false)
  }

  const found = result?.ok ? result.found : []
  const chosen = found.filter((f) => picked[f.mac])

  const add = async (items: FoundDevice[]) => {
    setBusy(true)
    const res = await addFoundDevices(
      items.map((f) => ({ ...f, kind: (kinds[f.mac] ?? f.kind) as FoundDevice['kind'] })),
      site ? Number(site) : null
    )
    setSaved(res)
    setBusy(false)
    if (res.ok) await scan()
  }

  return (
    <div>
      <p className="text-xs leading-relaxed text-gray-400">
        ISPMan reads what each connected router already knows: the devices it has talked to and
        the addresses it handed out. Radios, switches and routers are recognised by their maker.
        Your radios, switches and routers, and customers&apos; radios matched by MAC address, are
        added automatically every half hour; this shows what is new right now. A device you
        remove stays removed. Nothing is logged in to, so it is safe to run at any time.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void scan()} disabled={busy} className={primary}>
          {busy ? 'Looking…' : result ? 'Look again' : 'Find devices'}
        </button>
        {found.length > 0 ? (
          <>
            <button type="button" onClick={() => void add(chosen)} disabled={busy || chosen.length === 0} className={primary}>
              Add selected ({chosen.length})
            </button>
            {sites.length ? (
              <label className="flex items-center gap-2 text-xs text-gray-400">
                at site
                <select
                  value={site}
                  onChange={(e) => setSite(e.target.value)}
                  className="rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-100"
                >
                  <option value="">No site yet</option>
                  {sites.map((x) => (
                    <option key={x.id} value={x.id}>{x.name}</option>
                  ))}
                </select>
              </label>
            ) : null}
          </>
        ) : null}
      </div>

      {result && !result.ok ? (
        <p className="mt-3 rounded-lg bg-red-950/40 px-3 py-2 text-xs text-red-300">{result.error}</p>
      ) : null}
      <Note state={saved} />

      {result?.ok ? (
        <div className="mt-4 space-y-3">
          <p className="text-[11px] text-gray-500">
            Asked {result.routersAsked} {result.routersAsked === 1 ? 'router' : 'routers'}.{' '}
            {found.length} new, {result.known} already listed.
          </p>
          {result.notReady.length ? (
            <p className="rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-2 text-[11px] leading-relaxed text-gray-400">
              Not asked, because they have not had their setup command: {result.notReady.join(', ')}.
              Devices behind those routers will not show until they do.
            </p>
          ) : null}
          {result.failed.map((f) => (
            <p key={f.router} className="rounded-lg bg-red-950/30 px-3 py-2 text-[11px] text-red-300">
              {f.router}: {f.error}
            </p>
          ))}

          {found.length > 0 ? (
            <div className="space-y-5">
              {GROUPS.map((g) => {
                const items = found.filter((f) => f.group === g.id)
                if (items.length === 0) return null
                const all = items.every((f) => picked[f.mac])
                return (
                  <div key={g.id}>
                    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                      <div>
                        <h3 className="text-xs font-semibold text-white">
                          {g.title} <span className="font-normal text-gray-500">{items.length}</span>
                        </h3>
                        <p className="text-[11px] text-gray-500">{g.note}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          setPicked((p) => ({ ...p, ...Object.fromEntries(items.map((f) => [f.mac, !all])) }))
                        }
                        className={small}
                      >
                        {all ? 'Select none' : 'Select all'}
                      </button>
                    </div>
                    <FoundTable
                      items={items}
                      picked={picked}
                      kinds={kinds}
                      onPick={(m, v) => setPicked((p) => ({ ...p, [m]: v }))}
                      onKind={(m, k) => setKinds((x) => ({ ...x, [m]: k }))}
                    />
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="text-sm text-gray-500">Nothing new was found.</p>
          )}
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------- Inventory -------------------------------- */

function SitePicker({ row, sites, canManage }: { row: InventoryRow; sites: SiteOption[]; canManage: boolean }) {
  const [value, setValue] = useState(row.siteId ? String(row.siteId) : '')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const name = sites.find((s) => String(s.id) === value)?.name
  if (!canManage || sites.length === 0) {
    return name ? <Link href={'/dashboard/network/sites/' + value} className="text-blue-400 hover:underline">{name}</Link> : <span className="text-gray-600">—</span>
  }
  const change = async (next: string) => {
    const before = value
    setValue(next)
    setBusy(true)
    const res = await assignToSite([row.place], next ? Number(next) : null)
    setBusy(false)
    if (!res.ok) {
      setValue(before)
      setProblem(res.error)
    } else setProblem(null)
  }
  return (
    <span>
      <select
        aria-label={'Site of ' + row.name}
        value={value}
        disabled={busy}
        onChange={(e) => void change(e.target.value)}
        className="max-w-[10rem] rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-100"
      >
        <option value="">No site</option>
        {sites.map((s) => (
          <option key={s.id} value={s.id}>{s.name}</option>
        ))}
      </select>
      {problem ? <span className="block text-[11px] text-red-300">{problem}</span> : null}
    </span>
  )
}

function DeviceRow({
  row, canManage, sites, showSite,
}: {
  row: InventoryRow
  canManage: boolean
  sites: SiteOption[]
  showSite: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const change = async (kind: string) => {
    if (!row.deviceId) return
    setBusy(true)
    const res = await setDeviceKind(row.deviceId, kind)
    setBusy(false)
    setProblem(res.ok ? null : res.error)
  }
  const remove = async () => {
    if (!row.deviceId) return
    setBusy(true)
    const res = await removeDevice(row.deviceId)
    setBusy(false)
    setConfirming(false)
    setProblem(res.ok ? null : res.error)
  }

  return (
    <tr className="border-t border-gray-800">
      <td className={td}>
        <span className="flex items-center gap-3">
          <DeviceIcon kind={row.kind} className="h-8 w-8 shrink-0 text-gray-400" />
          <span>
            {row.href ? (
              <Link href={row.href} className="block font-semibold text-white hover:underline">{row.name}</Link>
            ) : (
              <span className="block font-semibold text-white">{row.name}</span>
            )}
            <span className="block text-[11px] text-gray-500">
              {[row.brand, row.model].filter(Boolean).join(' ') || '—'}
            </span>
            {problem ? <span className="block text-[11px] text-red-300">{problem}</span> : null}
          </span>
        </span>
      </td>
      <td className={td}>
        {row.deviceId && canManage ? (
          <select
            aria-label={'Type of ' + row.name}
            value={row.kind}
            disabled={busy}
            onChange={(e) => void change(e.target.value)}
            className="rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-100"
          >
            {DEVICE_KINDS.filter((k) => k.kind !== 'olt').map((k) => (
              <option key={k.kind} value={k.kind}>{k.label}</option>
            ))}
          </select>
        ) : (
          kindLabel(row.kind)
        )}
      </td>
      {showSite ? (
        <td className={td}>
          <SitePicker row={row} sites={sites} canManage={canManage} />
        </td>
      ) : null}
      <td className={td + ' font-mono'}>{row.ip ?? '—'}</td>
      <td className={td + ' font-mono'}>{row.mac ?? '—'}</td>
      <td className={td}>
        {row.customer ? (
          <Link href={'/dashboard/customers/' + row.customer.id} className="text-blue-400 hover:underline">
            {row.customer.name}
          </Link>
        ) : (
          row.where ?? '—'
        )}
      </td>
      <td className={td}>
        {row.status ? (
          <span className={row.status === 'up' ? 'text-green-400' : 'text-red-400'}>
            {row.status === 'up' ? 'Connected' : 'Not connected'}
          </span>
        ) : (
          <span className="text-gray-600">Not monitored</span>
        )}
      </td>
      <td className={td + ' text-right'}>
        {row.href ? (
          <Link href={row.href} className={small}>Open</Link>
        ) : canManage && row.deviceId ? (
          confirming ? (
            <span className="flex justify-end gap-1.5">
              <button type="button" onClick={() => void remove()} disabled={busy} className={small + ' text-red-300'}>
                Yes, remove
              </button>
              <button type="button" onClick={() => setConfirming(false)} className={small}>Cancel</button>
            </span>
          ) : (
            <button type="button" onClick={() => setConfirming(true)} className={small}>Remove</button>
          )
        ) : null}
      </td>
    </tr>
  )
}

/** Equipment installed at a customer's home rather than in the network. */
const CUSTOMER_KINDS = new Set(['onu', 'cpe'])
const CHIP_LABEL: Record<string, string> = { onu: 'Fiber (ONU)', cpe: 'Wireless (radio)' }

export function DeviceManager({
  rows, sites, canManage, ready,
}: {
  rows: InventoryRow[]
  sites: SiteOption[]
  canManage: boolean
  /** False when the devices table is not there yet: routers and OLTs still list. */
  ready: boolean
}) {
  const [side, setSide] = useState<'network' | 'customers'>('network')
  const [filter, setFilter] = useState('all')
  // '' every site, 'none' not at a site, else a site id.
  const [siteFilter, setSiteFilter] = useState('')
  const [panel, setPanel] = useState<'none' | 'discover' | 'add'>('none')

  // Two lists, because they answer two questions: what the network is built
  // from, and what is installed at customers' homes. Ninety ONUs in the first
  // would bury the ten devices that keep everyone online.
  const network = rows.filter((r) => !CUSTOMER_KINDS.has(r.kind))
  const customers = rows.filter((r) => CUSTOMER_KINDS.has(r.kind))
  const showSite = side === 'network'
  const bySite = (r: InventoryRow) =>
    !showSite || siteFilter === '' ? true : siteFilter === 'none' ? r.siteId == null : String(r.siteId) === siteFilter
  const list = (side === 'network' ? network : customers).filter(bySite)
  const counts = new Map<string, number>()
  for (const r of list) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1)
  const shown = filter === 'all' ? list : list.filter((r) => r.kind === filter)
  const chips = [{ kind: 'all', label: 'All' }, ...DEVICE_KINDS.filter((k) => counts.has(k.kind))]

  return (
    <div className="max-w-6xl space-y-5">
      <div className="flex gap-1 border-b border-gray-800" role="tablist" aria-label="Which devices">
        {(
          [
            { id: 'network', label: 'Your network', count: network.length },
            { id: 'customers', label: 'At customers', count: customers.length },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={side === t.id}
            onClick={() => {
              setSide(t.id)
              setFilter('all')
            }}
            className={
              '-mb-px border-b-2 px-3 py-2 text-sm ' +
              (side === t.id ? 'border-blue-500 font-semibold text-white' : 'border-transparent text-gray-400 hover:text-gray-200')
            }
          >
            {t.label}
            <span className="ml-1.5 text-xs text-gray-500">{t.count}</span>
          </button>
        ))}
      </div>
      <p className="text-sm text-gray-500">
        {side === 'network'
          ? 'Routers, OLTs, access points, backhaul links and switches: what your network is built from.'
          : 'ONUs for fiber customers and radios for wireless customers, each with the customer it serves.'}
      </p>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Filter by type">
          {chips.map((k) => (
            <button
              key={k.kind}
              type="button"
              role="tab"
              aria-selected={filter === k.kind}
              onClick={() => setFilter(k.kind)}
              className={
                'rounded-full px-3 py-1 text-xs ' +
                (filter === k.kind ? 'bg-blue-600 font-semibold text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700')
              }
            >
              {CHIP_LABEL[k.kind] ?? k.label} {k.kind === 'all' ? list.length : counts.get(k.kind)}
            </button>
          ))}
        </div>
        {canManage && ready ? (
          <div className="flex flex-wrap items-center gap-2">
            {showSite && sites.length ? (
              <select
                aria-label="Show one site"
                value={siteFilter}
                onChange={(e) => setSiteFilter(e.target.value)}
                className="rounded-lg border border-gray-700 bg-gray-950 px-2 py-2 text-xs text-gray-100"
              >
                <option value="">Every site</option>
                <option value="none">Not at a site</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            ) : null}
            <button type="button" onClick={() => setPanel(panel === 'discover' ? 'none' : 'discover')} className={primary}>
              Find devices
            </button>
            <button
              type="button"
              onClick={() => setPanel('add')}
              className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-semibold text-gray-100 hover:bg-gray-700"
            >
              Add device
            </button>
          </div>
        ) : null}
      </div>

      {!ready ? (
        <p className="rounded-lg border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
          Adding and finding devices needs migration 0056. Routers and OLTs are listed below.
        </p>
      ) : null}

      {panel === 'discover' ? (
        <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
          <h2 className="mb-3 text-sm font-semibold text-white">Find devices on your network</h2>
          <Discover sites={sites} />
        </section>
      ) : null}
      {panel === 'add' ? (
        <Modal title="Add a device" onClose={() => setPanel('none')}>
          <AddForm onDone={() => setPanel('none')} />
        </Modal>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
        {shown.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-gray-600">
            No devices yet. Press Find devices to see what your routers can hear.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className={th}>Device</th>
                  <th className={th}>Type</th>
                  {showSite ? <th className={th}>Site</th> : null}
                  <th className={th}>IP</th>
                  <th className={th}>MAC</th>
                  <th className={th}>{showSite ? 'Where' : 'Customer'}</th>
                  <th className={th}>Status</th>
                  <th className={th}></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <DeviceRow key={r.key} row={r} canManage={canManage} sites={sites} showSite={showSite} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
