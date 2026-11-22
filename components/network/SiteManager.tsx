'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { addSite, editSite, type SiteActionResult } from '@/app/actions/sites'
import type { InventoryRow } from '@/components/network/DeviceManager'
import { NetworkMap, type MapRouterInfo } from '@/components/network/NetworkMap'
import type { NetworkMap as NetworkMapData } from '@/lib/network/topology'
import { Modal } from '@/components/settings/Modal'
import { kindLabel } from '@/lib/network/classify'
import { SITE_KINDS, siteKindLabel } from '@/lib/network/site-kinds'

/**
 * The places the network is built at, each with what is there and which
 * other sites it links to.
 */

export type SiteView = { id: number; name: string; kind: string; notes: string | null }

const input =
  'w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 ' +
  'placeholder:text-gray-600 focus:border-blue-500 focus:outline-none'
const label = 'mb-1 block text-xs font-medium text-gray-400'
const primary =
  'rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-60'

/** Equipment that belongs at a site: not customer ONUs or radios. */
export const atSiteKind = (kind: string) => kind !== 'onu' && kind !== 'cpe'

/** "2 access points, 1 backhaul link". */
export function summarise(rows: InventoryRow[]): string {
  const counts = new Map<string, number>()
  for (const r of rows) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1)
  if (counts.size === 0) return 'Nothing here yet'
  return [...counts]
    .map(([k, n]) => n + ' ' + kindLabel(k).replace(' / sector', '').toLowerCase() + (n === 1 ? '' : 's'))
    .join(', ')
}

export function SiteForm({ site, onDone }: { site?: SiteView; onDone: (id?: number) => void }) {
  const [name, setName] = useState(site?.name ?? '')
  const [kind, setKind] = useState(site?.kind ?? 'tower')
  const [notes, setNotes] = useState(site?.notes ?? '')
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<SiteActionResult | null>(null)

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    const r = site ? await editSite(site.id, { name, kind, notes }) : await addSite({ name, kind, notes })
    setBusy(false)
    setRes(r)
    if (r.ok) onDone(r.id)
  }

  return (
    <form onSubmit={(e) => void save(e)} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="site-name">Name</label>
          <input
            id="site-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={input}
            placeholder="Retrieve tower"
            maxLength={80}
            required
          />
        </div>
        <div>
          <label className={label} htmlFor="site-kind">Kind of site</label>
          <select id="site-kind" value={kind} onChange={(e) => setKind(e.target.value)} className={input}>
            {SITE_KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>{k.label}</option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className={label} htmlFor="site-notes">Note</label>
        <textarea
          id="site-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className={input}
          rows={2}
          maxLength={500}
          placeholder="Where it is, who has the key, power source"
        />
      </div>
      <button type="submit" disabled={busy} className={primary}>
        {busy ? 'Saving…' : site ? 'Save' : 'Add site'}
      </button>
      {res && !res.ok ? <p className="rounded-lg bg-red-950/40 px-3 py-2 text-xs text-red-300">{res.error}</p> : null}
    </form>
  )
}

export function SiteManager({
  sites, rows, map, canManage, ready,
}: {
  sites: SiteView[]
  rows: InventoryRow[]
  map: NetworkMapData
  canManage: boolean
  ready: boolean
}) {
  const router = useRouter()
  const [adding, setAdding] = useState(false)
  const name = new Map(sites.map((s) => [s.id, s.name]))
  const gear = rows.filter((r) => atSiteKind(r.kind))
  const loose = gear.filter((r) => r.siteId == null)

  if (!ready) {
    return (
      <div className="max-w-2xl rounded-xl border border-amber-900/50 bg-amber-950/30 px-4 py-3">
        <p className="text-sm font-semibold text-amber-300">Migration required</p>
        <p className="mt-1 text-xs text-amber-300/80">Sites need migration 0061.</p>
      </div>
    )
  }

  return (
    <div className="max-w-6xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-gray-500">
          The places your network is built at: towers, rooftops, the office. Put routers, OLTs,
          access points and backhauls at a site, and say which site each backhaul links to.
        </p>
        {canManage ? (
          <button type="button" onClick={() => setAdding(true)} className={primary}>
            Add site
          </button>
        ) : null}
      </div>

      <NetworkMap
        map={map}
        routers={rows
          .filter((r) => r.place.table === 'router')
          .map((r): MapRouterInfo => ({ tunnelId: r.place.id, name: r.name, siteId: r.siteId }))}
        sites={sites.map((s) => ({ id: s.id, name: s.name }))}
        canManage={canManage}
      />

      {loose.length && sites.length ? (
        <p className="rounded-lg border border-gray-800 bg-gray-900 px-4 py-3 text-xs text-gray-400">
          {loose.length} {loose.length === 1 ? 'piece' : 'pieces'} of equipment {loose.length === 1 ? 'is' : 'are'} not
          at a site yet. Open a site and press Add equipment, or choose the site beside each one on the{' '}
          <Link href="/dashboard/network/devices" className="text-blue-400 hover:underline">Devices</Link> page.
        </p>
      ) : null}

      {sites.length === 0 ? (
        <div className="rounded-xl border border-gray-800 bg-gray-900 px-5 py-10 text-center">
          <p className="text-sm text-gray-300">No sites yet.</p>
          <p className="mt-1 text-xs text-gray-500">
            Add one for each tower or building with equipment on it, starting with the one your main router is at.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sites.map((s) => {
            const here = gear.filter((r) => r.siteId === s.id)
            const out = here.filter((r) => r.linksToSiteId != null)
            const into = gear.filter((r) => r.linksToSiteId === s.id && r.siteId !== s.id)
            const down = here.filter((r) => r.status === 'down').length
            const linked = [...new Set([...out.map((r) => r.linksToSiteId as number), ...into.map((r) => r.siteId).filter((x): x is number => x != null)])]
            return (
              <Link
                key={s.id}
                href={'/dashboard/network/sites/' + s.id}
                className="block rounded-xl border border-gray-800 bg-gray-900 p-4 hover:border-gray-700"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold text-white">{s.name}</p>
                    <p className="text-[11px] text-gray-500">{siteKindLabel(s.kind)}</p>
                  </div>
                  {down ? (
                    <span className="rounded-full bg-red-950/60 px-2 py-0.5 text-[11px] text-red-300">{down} not answering</span>
                  ) : here.length ? (
                    <span className="rounded-full bg-emerald-950/50 px-2 py-0.5 text-[11px] text-emerald-300">All answering</span>
                  ) : null}
                </div>
                <p className="mt-3 text-xs text-gray-300">{summarise(here)}</p>
                {map.customersBySite[s.id] ? (
                  <p className="mt-1 text-xs text-gray-300">
                    Serves {map.customersBySite[s.id]} {map.customersBySite[s.id] === 1 ? 'customer' : 'customers'}
                  </p>
                ) : null}
                {linked.length ? (
                  <p className="mt-1 text-[11px] text-gray-500">
                    Links to {linked.map((id) => name.get(id) ?? 'a removed site').join(', ')}
                  </p>
                ) : null}
              </Link>
            )
          })}
        </div>
      )}

      {adding ? (
        <Modal title="Add a site" onClose={() => setAdding(false)}>
          <SiteForm
            onDone={(id) => {
              setAdding(false)
              if (id) router.push('/dashboard/network/sites/' + id)
            }}
          />
        </Modal>
      ) : null}
    </div>
  )
}
