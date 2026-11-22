'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { addSiteForPort, assignToSite, refreshNetwork, setPortLeadsTo } from '@/app/actions/sites'
import type { MapPort, NetworkMap as NetworkMapData } from '@/lib/network/topology'

/**
 * How each router connects out, port by port, read from the routers.
 *
 * ONE QUESTION PER PORT: where does this lead? Everything else on the line is
 * what the router already knows — who answers at the other end, how many
 * devices and customers are out that way. A port with an answer gets a
 * one-press suggestion named after what answered; a port already pointed at a
 * site shows it, and the site page takes over from there.
 */

export type MapRouterInfo = { tunnelId: number; name: string; siteId: number | null }
export type MapSite = { id: number; name: string }

const select = 'rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-100'
const small =
  'rounded-md bg-gray-800 px-2.5 py-1 text-[11px] font-medium text-gray-200 hover:bg-gray-700 disabled:opacity-50'

/** A name to offer for a new site: what answered, else the words in the port's name. */
function suggestedName(p: MapPort): string {
  if (p.neighbour?.name) return p.neighbour.name
  const words = p.port.replace(/^[\d\s-]+/, '').replace(/^(mimosa|link|to|backhaul)\s+(to\s+)?/i, '').trim()
  return words.length >= 2 ? words : ''
}

function PortLine({ port, sites, onChanged }: { port: MapPort; sites: MapSite[]; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState(suggestedName(port))
  const [problem, setProblem] = useState<string | null>(null)
  const site = sites.find((s) => s.id === port.leadsToSiteId)

  const point = async (siteId: number | null) => {
    setBusy(true)
    const res = await setPortLeadsTo(port.id, siteId)
    setBusy(false)
    if (res.ok) onChanged()
    else setProblem(res.error)
  }
  const create = async () => {
    setBusy(true)
    const res = await addSiteForPort(port.id, name)
    setBusy(false)
    if (res.ok) {
      setNaming(false)
      onChanged()
    } else setProblem(res.error)
  }

  return (
    <li className="grid items-center gap-x-4 gap-y-2 py-3 sm:grid-cols-[minmax(9rem,12rem)_1fr_minmax(12rem,auto)]">
      <div className="flex items-center gap-2">
        <span className="rounded-md border border-gray-700 bg-gray-950 px-2 py-1 font-mono text-[11px] text-gray-200">
          {port.port}
        </span>
        <span aria-hidden="true" className="hidden h-px flex-1 bg-gray-700 sm:block" />
      </div>

      <div className="min-w-0">
        {port.neighbour ? (
          <p className="truncate text-sm text-white">
            {port.neighbour.name}
            <span className="text-xs text-gray-500">
              {port.neighbour.board ? ' · ' + port.neighbour.board : ''}
              {port.neighbour.port ? ' · its port ' + port.neighbour.port : ''}
            </span>
          </p>
        ) : (
          <p className="text-sm text-gray-400">No router answers on this port</p>
        )}
        <p className="text-[11px] text-gray-500">
          {port.macsBehind} {port.macsBehind === 1 ? 'device' : 'devices'} out this way
          {port.customers ? ', ' + port.customers + (port.customers === 1 ? ' customer' : ' customers') : ''}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        {naming ? (
          <>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Site name"
              aria-label={'Name of the site port ' + port.port + ' leads to'}
              className={select + ' w-40'}
              maxLength={80}
              autoFocus
            />
            <button type="button" onClick={() => void create()} disabled={busy || name.trim().length < 2} className={small + ' bg-blue-600 text-white hover:bg-blue-500'}>
              {busy ? 'Adding…' : 'Add'}
            </button>
            <button type="button" onClick={() => setNaming(false)} className={small}>Cancel</button>
          </>
        ) : site ? (
          <>
            <span className="text-[11px] text-gray-500">leads to</span>
            <Link href={'/dashboard/network/sites/' + site.id} className="rounded-full bg-blue-950/60 px-3 py-1 text-xs font-medium text-blue-200 hover:bg-blue-900/60">
              {site.name}
            </Link>
            <button type="button" onClick={() => void point(null)} disabled={busy} className="text-[11px] text-gray-500 hover:text-gray-300">
              Change
            </button>
          </>
        ) : (
          <>
            {sites.length ? (
              <select
                aria-label={'Site port ' + port.port + ' leads to'}
                value=""
                disabled={busy}
                onChange={(e) => (e.target.value === 'new' ? setNaming(true) : void point(Number(e.target.value)))}
                className={select + ' border-dashed border-amber-700/70'}
              >
                <option value="">Where does this lead?</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
                <option value="new">New site…</option>
              </select>
            ) : null}
            {suggestedName(port) && !sites.some((s) => s.name.toLowerCase() === suggestedName(port).toLowerCase()) ? (
              <button type="button" onClick={() => setNaming(true)} disabled={busy} className={small}>
                Make &ldquo;{suggestedName(port)}&rdquo; a site
              </button>
            ) : !sites.length ? (
              <button type="button" onClick={() => setNaming(true)} disabled={busy} className={small}>
                New site
              </button>
            ) : null}
          </>
        )}
      </div>
      {problem ? <p className="text-[11px] text-red-300 sm:col-span-3">{problem}</p> : null}
    </li>
  )
}

function RouterSite({ router, sites, onChanged }: { router: MapRouterInfo; sites: MapSite[]; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <label className="flex items-center gap-2 text-[11px] text-gray-500">
      at
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
    </label>
  )
}

export function NetworkMap({
  map, routers, sites, canManage,
}: {
  map: NetworkMapData
  routers: MapRouterInfo[]
  sites: MapSite[]
  canManage: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const refresh = () => router.refresh()

  const readNow = async () => {
    setBusy(true)
    setNote(null)
    const res = await refreshNetwork()
    setBusy(false)
    setNote(res.ok ? { ok: true, text: res.message } : { ok: false, text: res.error })
    router.refresh()
  }

  const known = new Map(routers.map((r) => [r.tunnelId, r]))
  const unmapped = map.routers.reduce((n, r) => n + r.ports.filter((p) => !p.leadsToSiteId).length, 0)

  return (
    <section className="rounded-xl border border-gray-800 bg-gray-900">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-800 px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-white">How your network connects</h2>
          <p className="mt-1 max-w-2xl text-xs text-gray-500">
            Each router&apos;s ports, and what your routers see out each one. Say where a port leads
            once: equipment and customers out that way are then placed at that site by themselves,
            and kept up to date every half hour.
            {unmapped ? ' ' + unmapped + (unmapped === 1 ? ' port still needs' : ' ports still need') + ' a site.' : ''}
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

      {!map.ready ? (
        <p className="px-5 py-6 text-sm text-gray-500">This needs migration 0062.</p>
      ) : map.routers.length === 0 ? (
        <p className="px-5 py-6 text-sm text-gray-500">
          Nothing read yet. Press Read network now, or wait for the next half-hourly pass.
        </p>
      ) : (
        <div className="divide-y divide-gray-800">
          {map.routers.map((r) => {
            const info = known.get(r.tunnelId)
            return (
              <div key={r.tunnelId} className="px-5 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold text-white">{info?.name ?? 'Router'}</p>
                  {canManage && info ? <RouterSite router={info} sites={sites} onChanged={refresh} /> : null}
                </div>
                <ul className="mt-1 divide-y divide-gray-800/70">
                  {r.ports.map((p) =>
                    canManage ? (
                      <PortLine key={p.id} port={p} sites={sites} onChanged={refresh} />
                    ) : (
                      <li key={p.id} className="py-2 text-xs text-gray-400">
                        {p.port}: {p.neighbour?.name ?? p.macsBehind + ' devices'}
                      </li>
                    )
                  )}
                </ul>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
