'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Fragment, useState } from 'react'

import {
  assignToSite, plugIn, refreshNetwork, setLinkMedium, setNodeSite, unplug,
  type PlugTarget, type PlugWhat,
} from '@/app/actions/sites'
import { DeviceIcon } from '@/components/network/DeviceIcon'
import type { InventoryRow } from '@/components/network/DeviceManager'
import { Modal } from '@/components/settings/Modal'
import { kindLabel } from '@/lib/network/classify'
import type { ChainNode, End } from '@/lib/network/links'
import type { MapPort, NetworkMap as NetworkMapData } from '@/lib/network/topology'

/**
 * How each router connects out: one lane per port, and along it the chain of
 * devices plugged in one after another — cable, switch, radio, radio, router.
 *
 * THE CHAIN IS DRAWN THE WAY IT IS WIRED. A solid line is a cable, a dashed
 * one a radio hop, an orange one fiber. Click a line to change which. A "+"
 * sits on every line, so a device the routers cannot see — an unmanaged
 * switch, two bridge radios — is slotted in exactly where it is.
 *
 * WHAT IS FOUND IS FILLED IN. A MikroTik or OLT answering on a port is linked
 * by itself. The devices a router sees out a port but that are not on its
 * chain are offered first when adding, so building a chain is mostly picking.
 */

export type MapRouterInfo = { tunnelId: number; name: string; siteId: number | null }
export type MapSite = { id: number; name: string }

const small =
  'rounded-md bg-gray-800 px-2.5 py-1 text-[11px] font-medium text-gray-200 hover:bg-gray-700 disabled:opacity-50'
const select = 'rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-100'
const input =
  'w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 placeholder:text-gray-500 focus:border-blue-500 focus:outline-none'

const MEDIUM_NEXT: Record<string, 'wired' | 'wireless' | 'fiber'> = { wired: 'wireless', wireless: 'fiber', fiber: 'wired' }
const MEDIUM_LABEL: Record<string, string> = { wired: 'Cable', wireless: 'Radio link', fiber: 'Fiber' }

type Lookup = (e: End) => InventoryRow | undefined

/* -------------------------------- The wire -------------------------------- */

function Wire({
  medium, linkId, canManage, onAdd, onChanged,
}: {
  medium: string
  linkId: number | null
  canManage: boolean
  onAdd: () => void
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const line =
    medium === 'wireless'
      ? 'border-t-2 border-dashed border-sky-400'
      : medium === 'fiber'
        ? 'border-t-2 border-orange-400'
        : 'border-t-2 border-gray-500'
  const cycle = async () => {
    if (!linkId) return
    setBusy(true)
    await setLinkMedium(linkId, MEDIUM_NEXT[medium] ?? 'wired')
    setBusy(false)
    onChanged()
  }
  return (
    <div className="group relative flex w-16 shrink-0 items-center self-center sm:w-20">
      <button
        type="button"
        onClick={() => void cycle()}
        disabled={!canManage || !linkId || busy}
        title={linkId ? MEDIUM_LABEL[medium] + (canManage ? ' — click to change' : '') : undefined}
        aria-label={linkId ? MEDIUM_LABEL[medium] + ', change' : 'Connection'}
        className={'h-4 w-full ' + (canManage && linkId ? 'cursor-pointer' : 'cursor-default')}
      >
        <span className={'block w-full ' + line} />
      </button>
      {canManage ? (
        <button
          type="button"
          onClick={onAdd}
          title="Add a device here"
          aria-label="Add a device here"
          className="absolute left-1/2 top-1/2 flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-gray-600 bg-gray-950 text-xs leading-none text-gray-300 opacity-70 transition hover:border-blue-500 hover:text-blue-400 hover:opacity-100 group-hover:opacity-100"
        >
          +
        </button>
      ) : null}
    </div>
  )
}

/* -------------------------------- A device -------------------------------- */

function Node({
  node, lookup, sites, canManage, onAddBelow, onChanged,
}: {
  node: ChainNode
  lookup: Lookup
  sites: MapSite[]
  canManage: boolean
  onAddBelow: (parent: End) => void
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const row = lookup(node.end)
  const site = sites.find((s) => s.id === row?.siteId)
  const down = row?.status === 'down'

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={
          'flex w-44 items-start gap-2.5 rounded-lg border bg-gray-900 p-2.5 text-left shadow-sm transition hover:border-blue-500 ' +
          (down ? 'border-red-400' : 'border-gray-700')
        }
      >
        <DeviceIcon kind={row?.kind ?? 'other'} className="h-9 w-9 shrink-0 text-gray-400" />
        <span className="min-w-0">
          <span className="block truncate text-xs font-semibold text-white">{row?.name ?? 'Removed device'}</span>
          <span className="block truncate text-[10px] text-gray-500">
            {row ? kindLabel(row.kind).replace(' / sector', '') : ''}
            {row?.ip ? ' · ' + row.ip : ''}
          </span>
          <span className={'mt-0.5 block truncate text-[10px] ' + (site ? 'text-blue-400' : 'text-gray-500')}>
            {site ? site.name : 'No site'}
            {down ? <span className="text-red-400"> · not answering</span> : null}
          </span>
        </span>
      </button>
      {node.port ? (
        <span className="absolute -top-2 left-2 rounded bg-gray-950 px-1 font-mono text-[9px] text-gray-500">{node.port}</span>
      ) : null}

      {open ? (
        <Modal title={row?.name ?? 'Device'} onClose={() => setOpen(false)}>
        <div className="space-y-3">
          {row?.href ? (
            <Link href={row.href} className="block text-xs text-blue-400 hover:underline">Open {row.name}</Link>
          ) : null}
          {canManage ? (
            <>
              <label className="block text-[11px] text-gray-500">
                Site
                <select
                  value={row?.siteId ?? ''}
                  disabled={busy}
                  onChange={async (e) => {
                    setBusy(true)
                    await setNodeSite(node.end, e.target.value ? Number(e.target.value) : null)
                    setBusy(false)
                    onChanged()
                  }}
                  className={input + ' mt-1'}
                >
                  <option value="">No site</option>
                  {sites.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  onAddBelow(node.end)
                }}
                className={small + ' w-full px-3 py-2 text-left text-sm'}
              >
                Add a device fed by this one
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  await unplug(node.end)
                  setBusy(false)
                  onChanged()
                }}
                className={small + ' w-full px-3 py-2 text-left text-sm text-red-300'}
              >
                Take off the map
              </button>
              <p className="text-[11px] text-gray-500">
                Taking it off the map joins what it fed to the device before it. The device stays listed under Devices.
              </p>
            </>
          ) : null}
        </div>
        </Modal>
      ) : null}
    </div>
  )
}

/** A device and everything after it. One path runs on to the right; extra branches stack below. */
function Branch({
  node, lookup, sites, canManage, onPlug, onChanged,
}: {
  node: ChainNode
  lookup: Lookup
  sites: MapSite[]
  canManage: boolean
  onPlug: (t: PlugTarget) => void
  onChanged: () => void
}) {
  const [first, ...rest] = node.children
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start">
        <Node
          node={node}
          lookup={lookup}
          sites={sites}
          canManage={canManage}
          onAddBelow={(parent) => onPlug({ at: 'below', parent })}
          onChanged={onChanged}
        />
        {first ? (
          <>
            <Wire medium={first.medium} linkId={first.linkId} canManage={canManage} onAdd={() => onPlug({ at: 'between', linkId: first.linkId })} onChanged={onChanged} />
            <Branch node={first} lookup={lookup} sites={sites} canManage={canManage} onPlug={onPlug} onChanged={onChanged} />
          </>
        ) : null}
      </div>
      {rest.length ? (
        <div className="ml-10 space-y-3 border-l-2 border-gray-700 pl-4">
          {rest.map((c) => (
            <div key={c.key} className="flex items-start">
              <Wire medium={c.medium} linkId={c.linkId} canManage={canManage} onAdd={() => onPlug({ at: 'between', linkId: c.linkId })} onChanged={onChanged} />
              <Branch node={c} lookup={lookup} sites={sites} canManage={canManage} onPlug={onPlug} onChanged={onChanged} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------- One port lane ------------------------------ */

function Lane({
  port, lookup, sites, canManage, onPlug, onChanged,
}: {
  port: MapPort
  lookup: Lookup
  sites: MapSite[]
  canManage: boolean
  onPlug: (t: PlugTarget, port: MapPort) => void
  onChanged: () => void
}) {
  const site = sites.find((s) => s.id === port.siteId)
  const plug = (t: PlugTarget) => onPlug(t, port)
  const [first, ...more] = port.chain

  return (
    <li className="py-4">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-xs font-semibold text-gray-200">{port.port}</span>
        <span className="text-[11px] text-gray-500">
          {port.macsBehind} {port.macsBehind === 1 ? 'device' : 'devices'} out this way
          {port.customers ? ' · ' + port.customers + (port.customers === 1 ? ' customer' : ' customers') : ''}
          {site ? ' · served from ' : ''}
          {site ? <Link href={'/dashboard/network/sites/' + site.id} className="text-blue-400 hover:underline">{site.name}</Link> : null}
        </span>
      </div>

      <div className="overflow-x-auto pb-1">
        <div className="flex min-w-max items-start">
          {/* The router's own socket. */}
          <span className="mt-4 h-4 w-4 shrink-0 rounded-sm border-2 border-gray-500 bg-gray-950" aria-hidden />
          {first ? (
            <div className="flex flex-col gap-3">
              {[first, ...more].map((n) => (
                <div key={n.key} className="flex items-start">
                  <Wire medium={n.medium} linkId={n.linkId} canManage={canManage} onAdd={() => plug({ at: 'between', linkId: n.linkId })} onChanged={onChanged} />
                  <Branch node={n} lookup={lookup} sites={sites} canManage={canManage} onPlug={plug} onChanged={onChanged} />
                </div>
              ))}
            </div>
          ) : (
            <div className="flex items-center">
              <span className="mt-4 block w-10 border-t-2 border-dashed border-gray-600" aria-hidden />
              {canManage ? (
                <button
                  type="button"
                  onClick={() => plug({ at: 'port', tunnelId: port.tunnelId, port: port.port })}
                  className="ml-2 mt-1 rounded-lg border border-dashed border-gray-600 px-3 py-2 text-xs text-gray-300 hover:border-blue-500 hover:text-blue-400"
                >
                  {port.neighbour ? 'What connects to ' + port.neighbour.name + '?' : 'What is plugged in here?'}
                </button>
              ) : (
                <span className="ml-2 mt-3 text-xs text-gray-500">Not mapped</span>
              )}
            </div>
          )}
        </div>
      </div>
      {port.neighbour && !first ? (
        <p className="mt-1 text-[11px] text-gray-500">
          {port.neighbour.name} ({port.neighbour.board ?? 'router'}) answers out this port
          {port.neighbour.port ? ' on its port ' + port.neighbour.port : ''}, but is not in ISPMan yet. Add it under Devices
          to link it here by itself.
        </p>
      ) : null}
    </li>
  )
}

/* ------------------------------ Add a device ------------------------------ */

const SILENT_KINDS = [
  { kind: 'switch', label: 'Switch (unmanaged)' },
  { kind: 'backhaul', label: 'Backhaul radio' },
  { kind: 'ap', label: 'Access point' },
  { kind: 'router', label: 'Router' },
  { kind: 'other', label: 'Other' },
]

function AddDialog({
  target, port, rows, onClose, onDone,
}: {
  target: PlugTarget
  port: MapPort
  rows: InventoryRow[]
  onClose: () => void
  onDone: () => void
}) {
  const [tab, setTab] = useState<'seen' | 'silent' | 'any'>(port.candidates.length ? 'seen' : 'silent')
  const [kind, setKind] = useState('switch')
  const [name, setName] = useState('')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const byKey = new Map(rows.map((r) => [r.key, r]))
  const seen = port.candidates.map((e) => byKey.get(e.type + '-' + e.id)).filter((r): r is InventoryRow => Boolean(r))
  const any = rows
    .filter((r) => r.kind !== 'onu' && r.kind !== 'cpe')
    .filter((r) => !query || (r.name + ' ' + (r.ip ?? '')).toLowerCase().includes(query.toLowerCase()))
    .slice(0, 40)

  const go = async (what: PlugWhat) => {
    setBusy(true)
    setProblem(null)
    const res = await plugIn(target, what)
    setBusy(false)
    if (res.ok) onDone()
    else setProblem(res.error)
  }

  const pickList = (list: InventoryRow[]) =>
    list.length === 0 ? (
      <p className="py-4 text-sm text-gray-500">Nothing to show.</p>
    ) : (
      <ul className="max-h-[50vh] divide-y divide-gray-800 overflow-y-auto rounded-lg border border-gray-800">
        {list.map((r) => (
          <li key={r.key}>
            <button
              type="button"
              disabled={busy}
              onClick={() => void go({ existing: { type: r.place.table, id: r.place.id } })}
              className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-gray-800/60"
            >
              <DeviceIcon kind={r.kind} className="h-8 w-8 shrink-0 text-gray-400" />
              <span className="min-w-0">
                <span className="block truncate text-sm text-white">{r.name}</span>
                <span className="block truncate text-[11px] text-gray-500">
                  {kindLabel(r.kind)}
                  {r.brand ? ' · ' + r.brand : ''}
                  {r.ip ? ' · ' + r.ip : ''}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    )

  return (
    <Modal title={'Add a device on ' + port.port} onClose={onClose}>
      <div className="space-y-4">
        <div className="flex gap-1 border-b border-gray-800" role="tablist">
          {(
            [
              { id: 'seen', label: 'Seen out this port', count: seen.length },
              { id: 'silent', label: 'Not seen by the router' },
              { id: 'any', label: 'Any device' },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={
                '-mb-px border-b-2 px-3 py-2 text-xs ' +
                (tab === t.id ? 'border-blue-500 font-semibold text-white' : 'border-transparent text-gray-400 hover:text-gray-200')
              }
            >
              {t.label}
              {'count' in t ? <span className="ml-1 text-gray-500">{t.count}</span> : null}
            </button>
          ))}
        </div>

        {tab === 'seen' ? (
          <>
            <p className="text-xs text-gray-400">Radios, switches and routers your router sees out this port, not yet on the map.</p>
            {pickList(seen)}
          </>
        ) : tab === 'silent' ? (
          <div className="space-y-3">
            <p className="text-xs text-gray-400">
              An unmanaged switch, a bridge radio, a PoE injector: something with no address the router can see.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <select value={kind} onChange={(e) => setKind(e.target.value)} className={input} aria-label="Kind of device">
                {SILENT_KINDS.map((k) => (
                  <option key={k.kind} value={k.kind}>{k.label}</option>
                ))}
              </select>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Edge switch at the CCR" className={input} maxLength={120} aria-label="Name" />
            </div>
            <button
              type="button"
              disabled={busy || name.trim().length < 2}
              onClick={() => void go({ create: { kind, name } })}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-60"
            >
              {busy ? 'Adding…' : 'Add to the map'}
            </button>
          </div>
        ) : (
          <>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name or IP" className={input} aria-label="Search devices" />
            {pickList(any)}
          </>
        )}
        {problem ? <p className="text-xs text-red-300">{problem}</p> : null}
      </div>
    </Modal>
  )
}

/* -------------------------------- The map -------------------------------- */

function RouterSite({ router, sites, onChanged }: { router: MapRouterInfo; sites: MapSite[]; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <select
      value={router.siteId ?? ''}
      disabled={busy || sites.length === 0}
      onChange={async (e) => {
        setBusy(true)
        await assignToSite([{ table: 'router', id: router.tunnelId }], e.target.value ? Number(e.target.value) : null)
        setBusy(false)
        onChanged()
      }}
      className={select}
      aria-label={'Site ' + router.name + ' is at'}
    >
      <option value="">{sites.length ? 'Choose its site' : 'Add a site first'}</option>
      {sites.map((s) => (
        <option key={s.id} value={s.id}>{s.name}</option>
      ))}
    </select>
  )
}

export function NetworkMap({
  map, rows, routers, sites, canManage,
}: {
  map: NetworkMapData
  rows: InventoryRow[]
  routers: MapRouterInfo[]
  sites: MapSite[]
  canManage: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [adding, setAdding] = useState<{ target: PlugTarget; port: MapPort } | null>(null)
  const refresh = () => router.refresh()
  const byKey = new Map(rows.map((r) => [r.key, r]))
  const lookup: Lookup = (e) => byKey.get(e.type + '-' + e.id)
  const known = new Map(routers.map((r) => [r.tunnelId, r]))

  const readNow = async () => {
    setBusy(true)
    setNote(null)
    const res = await refreshNetwork()
    setBusy(false)
    setNote(res.ok ? { ok: true, text: res.message } : { ok: false, text: res.error })
    router.refresh()
  }

  return (
    <section className="rounded-xl border border-gray-800 bg-gray-900">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-800 px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-white">How your network connects</h2>
          <p className="mt-1 max-w-2xl text-xs text-gray-500">
            Each port and the devices plugged in after it, as they are wired. Routers and OLTs that
            answer on a port are filled in by themselves. Press + on any line to slot in what sits
            between, such as an edge switch or a pair of bridge radios. Click a line to mark it a
            cable, radio link or fiber.
          </p>
          <p className="mt-2 flex flex-wrap gap-4 text-[11px] text-gray-500">
            <span className="flex items-center gap-1.5"><span className="w-6 border-t-2 border-gray-500" /> Cable</span>
            <span className="flex items-center gap-1.5"><span className="w-6 border-t-2 border-dashed border-sky-400" /> Radio link</span>
            <span className="flex items-center gap-1.5"><span className="w-6 border-t-2 border-orange-400" /> Fiber</span>
          </p>
        </div>
        {canManage ? (
          <button type="button" onClick={() => void readNow()} disabled={busy} className={small + ' px-3 py-1.5 text-xs'}>
            {busy ? 'Reading your routers…' : 'Read network now'}
          </button>
        ) : null}
      </div>
      {note ? (
        <p className={'mx-5 mt-3 rounded-lg px-3 py-2 text-xs ' + (note.ok ? 'bg-emerald-950/40 text-emerald-300' : 'bg-red-950/40 text-red-300')}>
          {note.text}
        </p>
      ) : null}

      {!map.ready || !map.linksReady ? (
        <p className="px-5 py-6 text-sm text-gray-500">This needs migrations 0062 and 0063.</p>
      ) : map.routers.length === 0 ? (
        <p className="px-5 py-6 text-sm text-gray-500">Nothing read yet. Press Read network now, or wait for the next half-hourly pass.</p>
      ) : (
        <div className="divide-y divide-gray-800">
          {map.routers.map((r) => {
            const info = known.get(r.tunnelId)
            return (
              <div key={r.tunnelId} className="px-5 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <DeviceIcon kind="router" className="h-10 w-10 text-gray-400" />
                    <div>
                      <p className="font-semibold text-white">{info?.name ?? 'Router'}</p>
                      <p className="text-[11px] text-gray-500">{r.ports.length} ports in use</p>
                    </div>
                  </div>
                  {canManage && info ? (
                    <label className="flex items-center gap-2 text-[11px] text-gray-500">
                      at <RouterSite router={info} sites={sites} onChanged={refresh} />
                    </label>
                  ) : null}
                </div>
                <ul className="mt-1 divide-y divide-gray-800/70">
                  {r.ports.map((p) => (
                    <Fragment key={p.id}>
                      <Lane
                        port={p}
                        lookup={lookup}
                        sites={sites}
                        canManage={canManage}
                        onPlug={(target, port) => setAdding({ target, port })}
                        onChanged={refresh}
                      />
                    </Fragment>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
      )}

      {adding ? (
        <AddDialog
          target={adding.target}
          port={adding.port}
          rows={rows}
          onClose={() => setAdding(null)}
          onDone={() => {
            setAdding(null)
            refresh()
          }}
        />
      ) : null}
    </section>
  )
}
