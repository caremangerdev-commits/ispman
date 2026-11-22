'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { assignToSite, linkBackhaul, removeSite } from '@/app/actions/sites'
import { DeviceIcon } from '@/components/network/DeviceIcon'
import type { InventoryRow } from '@/components/network/DeviceManager'
import { atSiteKind, SiteForm, summarise, type SiteView } from '@/components/network/SiteManager'
import { Modal } from '@/components/settings/Modal'
import { kindLabel } from '@/lib/network/classify'
import { siteKindLabel } from '@/lib/network/site-kinds'

/**
 * One site: what is at it, and how it links to the others.
 *
 * A BACKHAUL IS RECORDED AT THE SITE IT STANDS ON, pointing at the far end.
 * So this page shows two kinds of link: radios here that reach out, and
 * radios at other sites that reach in. Either one says the two sites are
 * joined.
 */

const th = 'px-4 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-gray-500'
const td = 'px-4 py-2.5 text-xs text-gray-300'
const small =
  'rounded-md bg-gray-800 px-2.5 py-1 text-[11px] font-medium text-gray-200 hover:bg-gray-700 disabled:opacity-50'
const primary =
  'rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-60'
const select = 'rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-100'

function Status({ status }: { status: InventoryRow['status'] }) {
  if (!status) return <span className="text-gray-600">Not monitored</span>
  return (
    <span className={status === 'up' ? 'text-green-400' : 'text-red-400'}>
      {status === 'up' ? 'Answering' : 'Not answering'}
    </span>
  )
}

function LinkPicker({ row, sites, here, canManage }: { row: InventoryRow; sites: SiteView[]; here: number; canManage: boolean }) {
  const [value, setValue] = useState(row.linksToSiteId ? String(row.linksToSiteId) : '')
  const [busy, setBusy] = useState(false)
  const others = sites.filter((s) => s.id !== here)
  if (!canManage) return <>{others.find((s) => String(s.id) === value)?.name ?? '—'}</>
  return (
    <select
      aria-label={'Site ' + row.name + ' links to'}
      value={value}
      disabled={busy}
      onChange={async (e) => {
        const next = e.target.value
        setValue(next)
        setBusy(true)
        const res = await linkBackhaul(row.deviceId as number, next ? Number(next) : null)
        setBusy(false)
        if (!res.ok) setValue(row.linksToSiteId ? String(row.linksToSiteId) : '')
      }}
      className={select}
    >
      <option value="">Not set</option>
      {others.map((s) => (
        <option key={s.id} value={s.id}>{s.name}</option>
      ))}
    </select>
  )
}

function AddEquipment({ site, rows, sites, onDone }: { site: SiteView; rows: InventoryRow[]; sites: SiteView[]; onDone: () => void }) {
  const name = new Map(sites.map((s) => [s.id, s.name]))
  // Not at a site first: those are what someone setting up sites is after.
  const choices = rows
    .filter((r) => atSiteKind(r.kind) && r.siteId !== site.id)
    .sort((a, b) => Number(a.siteId != null) - Number(b.siteId != null) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const chosen = choices.filter((r) => picked[r.key])

  const save = async () => {
    setBusy(true)
    const res = await assignToSite(chosen.map((r) => r.place), site.id)
    setBusy(false)
    if (res.ok) onDone()
    else setProblem(res.error)
  }

  if (choices.length === 0) return <p className="text-sm text-gray-400">Everything is already at a site.</p>
  return (
    <div className="space-y-3">
      <div className="max-h-[55vh] overflow-y-auto rounded-lg border border-gray-800">
        <table className="w-full">
          <tbody>
            {choices.map((r) => (
              <tr key={r.key} className="border-t border-gray-800 first:border-t-0">
                <td className={td + ' w-8'}>
                  <input
                    type="checkbox"
                    aria-label={'Select ' + r.name}
                    checked={!!picked[r.key]}
                    onChange={(e) => setPicked((p) => ({ ...p, [r.key]: e.target.checked }))}
                  />
                </td>
                <td className={td}>
                  <span className="block font-medium text-white">{r.name}</span>
                  <span className="block text-[11px] text-gray-500">
                    {kindLabel(r.kind)}
                    {r.ip ? ' · ' + r.ip : ''}
                  </span>
                </td>
                <td className={td + ' text-right text-[11px] text-gray-500'}>
                  {r.siteId != null ? 'now at ' + (name.get(r.siteId) ?? 'another site') : 'not at a site'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" onClick={() => void save()} disabled={busy || chosen.length === 0} className={primary}>
        {busy ? 'Moving…' : 'Put ' + chosen.length + ' at ' + site.name}
      </button>
      {problem ? <p className="text-xs text-red-300">{problem}</p> : null}
    </div>
  )
}

export function SiteDetail({
  site, sites, rows, canManage,
}: {
  site: SiteView
  sites: SiteView[]
  rows: InventoryRow[]
  canManage: boolean
}) {
  const router = useRouter()
  const [modal, setModal] = useState<'none' | 'edit' | 'add'>('none')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const name = new Map(sites.map((s) => [s.id, s.name]))

  const here = rows.filter((r) => r.siteId === site.id && atSiteKind(r.kind))
  const incoming = rows.filter((r) => r.linksToSiteId === site.id && r.siteId !== site.id)

  const takeOff = async (r: InventoryRow) => {
    setBusy(r.key)
    await assignToSite([r.place], null)
    setBusy(null)
    router.refresh()
  }
  const remove = async () => {
    setBusy('remove')
    const res = await removeSite(site.id)
    setBusy(null)
    if (res.ok) router.push('/dashboard/network/sites')
  }

  return (
    <div className="max-w-5xl space-y-5">
      <Link href="/dashboard/network/sites" className="text-xs text-blue-400 hover:underline">
        ← All sites
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-white">{site.name}</h2>
          <p className="mt-1 text-xs text-gray-500">
            {siteKindLabel(site.kind)} · {summarise(here)}
          </p>
          {site.notes ? <p className="mt-2 max-w-xl text-xs text-gray-400">{site.notes}</p> : null}
        </div>
        {canManage ? (
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setModal('add')} className={primary}>
              Add equipment
            </button>
            <button type="button" onClick={() => setModal('edit')} className={small + ' px-4 py-2 text-sm'}>
              Edit
            </button>
            {confirming ? (
              <>
                <button type="button" onClick={() => void remove()} disabled={!!busy} className={small + ' px-4 py-2 text-sm text-red-300'}>
                  Yes, remove site
                </button>
                <button type="button" onClick={() => setConfirming(false)} className={small + ' px-4 py-2 text-sm'}>
                  Cancel
                </button>
              </>
            ) : (
              <button type="button" onClick={() => setConfirming(true)} className={small + ' px-4 py-2 text-sm'}>
                Remove
              </button>
            )}
          </div>
        ) : null}
      </div>
      {confirming ? (
        <p className="text-xs text-gray-400">
          The equipment here stays listed under Devices, just no longer at a site.
        </p>
      ) : null}

      <section className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
        <h3 className="px-4 pt-3 text-sm font-semibold text-white">At this site</h3>
        {here.length === 0 ? (
          <p className="px-4 py-6 text-sm text-gray-500">
            Nothing here yet. Press Add equipment to put routers, OLTs, access points and backhauls here.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className={th}>Device</th>
                  <th className={th}>Type</th>
                  <th className={th}>IP</th>
                  <th className={th}>Links to</th>
                  <th className={th}>Status</th>
                  <th className={th}></th>
                </tr>
              </thead>
              <tbody>
                {here.map((r) => (
                  <tr key={r.key} className="border-t border-gray-800">
                    <td className={td}>
                      <span className="flex items-center gap-3">
                        <DeviceIcon kind={r.kind} className="h-8 w-8 shrink-0 text-gray-400" />
                        <span>
                          {r.href ? (
                            <Link href={r.href} className="block font-semibold text-white hover:underline">{r.name}</Link>
                          ) : (
                            <span className="block font-semibold text-white">{r.name}</span>
                          )}
                          <span className="block text-[11px] text-gray-500">
                            {[r.brand, r.model].filter(Boolean).join(' ') || '—'}
                          </span>
                        </span>
                      </span>
                    </td>
                    <td className={td}>{kindLabel(r.kind)}</td>
                    <td className={td + ' font-mono'}>{r.ip ?? '—'}</td>
                    <td className={td}>
                      {r.kind === 'backhaul' && r.deviceId ? (
                        <LinkPicker row={r} sites={sites} here={site.id} canManage={canManage} />
                      ) : (
                        <span className="text-gray-600">—</span>
                      )}
                    </td>
                    <td className={td}>
                      <Status status={r.status} />
                    </td>
                    <td className={td + ' text-right'}>
                      {canManage ? (
                        <button type="button" onClick={() => void takeOff(r)} disabled={busy === r.key} className={small}>
                          Take off site
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {incoming.length ? (
        <section className="rounded-xl border border-gray-800 bg-gray-900 px-4 py-3">
          <h3 className="text-sm font-semibold text-white">Linked from other sites</h3>
          <ul className="mt-2 space-y-1 text-xs text-gray-300">
            {incoming.map((r) => (
              <li key={r.key}>
                {r.name} at{' '}
                {r.siteId != null ? (
                  <Link href={'/dashboard/network/sites/' + r.siteId} className="text-blue-400 hover:underline">
                    {name.get(r.siteId) ?? 'another site'}
                  </Link>
                ) : (
                  'no site yet'
                )}{' '}
                <span className="text-gray-500">· <Status status={r.status} /></span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {modal === 'edit' ? (
        <Modal title="Edit site" onClose={() => setModal('none')}>
          <SiteForm
            site={site}
            onDone={() => {
              setModal('none')
              router.refresh()
            }}
          />
        </Modal>
      ) : null}
      {modal === 'add' ? (
        <Modal title={'Add equipment to ' + site.name} onClose={() => setModal('none')}>
          <AddEquipment
            site={site}
            rows={rows}
            sites={sites}
            onDone={() => {
              setModal('none')
              router.refresh()
            }}
          />
        </Modal>
      ) : null}
    </div>
  )
}
