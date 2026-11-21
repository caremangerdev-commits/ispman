'use client'

import Link from 'next/link'
import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'

import { checkOlt, loadOnus, type OltActionResult } from '@/app/actions/olts'
import { DeviceIcon } from '@/components/network/DeviceIcon'
import { OnuPanel, type OnuLists } from '@/components/network/OnuPanel'
import type { Olt } from '@/lib/data/olts'

/**
 * One OLT, opened up: its details, cards, PON ports, uplinks and VLANs, each
 * on its own tab.
 *
 * EVERYTHING HERE IS FROM THE LAST CHECK, and the page says when that was.
 * Nothing is read from the OLT while the page loads: a full reading is dozens
 * of commands over a tunnel, so it is taken when someone presses Refresh, and
 * shown as of then.
 */

type Tab = 'details' | 'authorised' | 'pending' | 'offline' | 'cards' | 'pon' | 'uplinks' | 'vlans'

const ONU_TABS: Tab[] = ['authorised', 'pending', 'offline']

const cardFine = (status: string) => status === 'INSERVICE' || status === 'STANDBY'

function rate(bps: number | null | undefined): string {
  if (bps === null || bps === undefined) return '—'
  if (bps >= 1e9) return (bps / 1e9).toFixed(2) + ' Gbps'
  if (bps >= 1e6) return (bps / 1e6).toFixed(1) + ' Mbps'
  if (bps >= 1e3) return (bps / 1e3).toFixed(0) + ' kbps'
  return bps + ' bps'
}

/** Two words for the two questions a port answers: is it on, is it linked. */
function PortState({ enabled, up }: { enabled: boolean; up: boolean }) {
  if (!enabled) return <span className="text-gray-500">Switched off</span>
  return up ? <span className="text-green-400">Up</span> : <span className="text-amber-300">No link</span>
}

function Refresh({ id }: { id: number }) {
  const [state, action] = useActionState<OltActionResult | null, FormData>(checkOlt, null)
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="id" value={id} />
      <RefreshButton />
      {state && !state.ok ? <span className="text-xs text-red-300">{state.error}</span> : null}
    </form>
  )
}

function RefreshButton() {
  const status = useFormStatus()
  return (
    <button
      type="submit"
      disabled={status.pending}
      className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-60"
    >
      {status.pending ? 'Reading the OLT…' : 'Refresh from OLT'}
    </button>
  )
}

const th = 'py-2 pr-4 text-left text-[10px] font-medium uppercase tracking-wider text-gray-500'
const td = 'py-2 pr-4 text-xs text-gray-300'

function Empty({ children }: { children: string }) {
  return <p className="px-1 py-6 text-sm text-gray-500">{children}</p>
}

function Count({
  label, value, tone, note, active, onOpen,
}: {
  label: string
  /** Undefined when the OLT has not been read since these were added. */
  value: number | undefined
  tone: string
  note: string
  active: boolean
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={
        'rounded-xl border bg-gray-900 px-4 py-3 text-left transition-colors hover:border-gray-600 ' +
        (active ? 'border-blue-500' : 'border-gray-800')
      }
    >
      <p className="text-[10px] uppercase tracking-wider text-gray-500">{label}</p>
      <p className={'mt-1 text-3xl font-semibold tabular-nums ' + (value === undefined ? 'text-gray-600' : tone)}>
        {value === undefined ? '—' : value}
      </p>
      <p className="mt-1 text-[11px] text-gray-500">{note}</p>
    </button>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-t border-gray-800 py-2 first:border-t-0">
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="text-right text-xs text-gray-200">{value}</dd>
    </div>
  )
}

export function OltDetail({
  olt, routerName, checkedText, canManage,
}: {
  olt: Olt
  routerName: string
  /** When the figures were read, already in words. Null if never. */
  checkedText: string | null
  canManage: boolean
}) {
  const [tab, setTab] = useState<Tab>('details')
  const [lists, setLists] = useState<OnuLists | null>(null)
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const info = olt.info

  // READ FROM THE OLT WHEN A LIST IS OPENED, not when the page loads. Most
  // visits to this page are to look at cards or ports, and a live reading is
  // a login and a dozen commands over a tunnel.
  const reload = async () => {
    setLoading(true)
    setListError(null)
    try {
      const res = await loadOnus(olt.id)
      if (res.ok) setLists({ pending: res.pending, onus: res.onus, customers: res.customers })
      else setListError(res.error)
    } catch {
      setListError('Could not reach ISPMan.')
    } finally {
      setLoading(false)
    }
  }
  const open = (t: Tab) => {
    setTab(t)
    if (ONU_TABS.includes(t) && !lists && !loading) void reload()
  }
  const cards = info?.cards ?? []
  const pon = info?.ponPorts ?? []
  const uplinks = info?.uplinks ?? []
  const vlans = info?.vlans ?? []

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'details', label: 'OLT details' },
    { id: 'authorised', label: 'Authorized' },
    { id: 'pending', label: 'Unauthorized' },
    { id: 'cards', label: 'Cards', count: cards.length },
    { id: 'pon', label: 'PON ports', count: pon.length },
    { id: 'uplinks', label: 'Uplinks', count: uplinks.length },
    { id: 'vlans', label: 'VLANs', count: vlans.length },
  ]

  const dot = olt.ok === true ? 'bg-green-400' : olt.ok === false ? 'bg-red-500' : 'bg-gray-500'
  const registered = pon.reduce((n, p) => n + (p.registered ?? 0), 0)

  return (
    <div className="max-w-5xl space-y-5">
      <Link href="/dashboard/network/olts" className="text-xs text-blue-400 hover:underline">
        ← All OLTs
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <DeviceIcon kind="olt" className="h-16 w-16 shrink-0 text-blue-300" />
          <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
            <span className={'h-2.5 w-2.5 rounded-full ' + dot} aria-hidden="true" />
            {olt.name}
          </h2>
          <p className="mt-1 text-xs text-gray-500">
            {checkedText ? 'Read from the OLT ' + checkedText + '.' : 'Not read from the OLT yet.'}
          </p>
        </div>
        </div>
        {canManage ? <Refresh id={olt.id} /> : null}
      </div>

      {olt.ok === false && olt.error ? (
        <p className="rounded-lg bg-red-950/30 px-3 py-2 text-xs text-red-300">{olt.error}</p>
      ) : null}

      {/*
        The three numbers someone opens an OLT to see. Each opens its own
        list, read from the OLT at that moment.
      */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Count
          label="Authorized"
          value={lists ? lists.onus.length : info?.onus?.authorised}
          tone="text-green-400"
          note="ONUs registered on this OLT"
          active={tab === 'authorised'}
          onOpen={() => open('authorised')}
        />
        <Count
          label="Unauthorized"
          value={lists ? lists.pending.length : info?.onus?.unauthorised}
          tone={(lists ? lists.pending.length : info?.onus?.unauthorised) ? 'text-blue-400' : 'text-white'}
          note="Plugged in, waiting to be authorized"
          active={tab === 'pending'}
          onOpen={() => open('pending')}
        />
        <Count
          label="Offline"
          value={lists ? lists.onus.filter((o) => !o.online).length : info?.onus?.offline}
          tone={(lists ? lists.onus.filter((o) => !o.online).length : info?.onus?.offline) ? 'text-red-400' : 'text-white'}
          note="Authorized but not in service"
          active={tab === 'offline'}
          onOpen={() => open('offline')}
        />
      </div>

      <div className="flex flex-wrap gap-1 border-b border-gray-800" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id || (t.id === 'authorised' && tab === 'offline')}
            onClick={() => open(t.id)}
            className={
              '-mb-px border-b-2 px-3 py-2 text-sm ' +
              (tab === t.id || (t.id === 'authorised' && tab === 'offline')
                ? 'border-blue-500 font-semibold text-white'
                : 'border-transparent text-gray-400 hover:text-gray-200')
            }
          >
            {t.label}
            {t.count ? <span className="ml-1.5 text-xs text-gray-500">{t.count}</span> : null}
          </button>
        ))}
      </div>

      <div className="rounded-xl border border-gray-800 bg-gray-900 px-4 py-2">
        {tab === 'details' ? (
          <dl>
            <Field label="Name" value={olt.name} />
            <Field label="Name on the OLT" value={info?.name ?? '—'} />
            <Field label="IP address" value={olt.mgmtIp} />
            <Field label="Reached through" value={routerName} />
            <Field label="Model" value={info?.model ?? '—'} />
            <Field label="Software" value={info?.version ?? '—'} />
            <Field label="Running for" value={info?.uptime ?? '—'} />
            <Field label="PON ports" value={pon.length ? String(pon.length) : '—'} />
            <Field label="ONUs registered" value={pon.length ? String(registered) : '—'} />
            <Field label="Login used" value={olt.cliUser} />
          </dl>
        ) : null}

        {tab === 'authorised' || tab === 'pending' || tab === 'offline' ? (
          <OnuPanel
            key={tab}
            oltId={olt.id}
            view={tab}
            lists={lists}
            loading={loading}
            error={listError}
            canManage={canManage}
            vlans={vlans.map((v) => v.id).filter((id) => id !== 1)}
            defaultVlan={
              olt.serviceVlan ?? (vlans.filter((v) => v.id !== 1).length === 1 ? vlans.filter((v) => v.id !== 1)[0].id : null)
            }
            onReload={() => void reload()}
          />
        ) : null}

        {tab === 'cards' ? (
          cards.length === 0 ? (
            <Empty>No cards read yet. Press Refresh from OLT.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className={th}>Slot</th>
                    <th className={th}>Type</th>
                    <th className={th}>Running as</th>
                    <th className={th}>Ports</th>
                    <th className={th}>Software</th>
                    <th className={th}>CPU</th>
                    <th className={th}>Memory</th>
                    <th className={th}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {cards.map((c) => (
                    <tr key={c.slot} className="border-t border-gray-800">
                      <td className={td + ' tabular-nums'}>{c.slot}</td>
                      <td className={td}>{c.configured}</td>
                      <td className={td}>{c.actual ?? '—'}</td>
                      <td className={td + ' tabular-nums'}>{c.ports ?? '—'}</td>
                      <td className={td}>{c.software ?? '—'}</td>
                      <td className={td + ' tabular-nums'}>{c.cpu == null ? '—' : c.cpu + '%'}</td>
                      <td className={td + ' tabular-nums'}>{c.memory == null ? '—' : c.memory + '%'}</td>
                      <td className={td + (cardFine(c.status) ? ' text-green-400' : ' text-amber-300')}>
                        {c.status}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {cards.some((c) => !cardFine(c.status)) ? (
                <p className="py-2 text-[11px] leading-relaxed text-amber-300/80">
                  HWONLINE: the card is plugged in but has not started, usually because the OLT
                  has no software for that card model. OFFLINE: the slot is set up for a card but
                  nothing is in it.
                </p>
              ) : null}
            </div>
          )
        ) : null}

        {tab === 'pon' ? (
          pon.length === 0 ? (
            <Empty>No PON ports read yet. They appear once a PON card is set up on the OLT.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className={th}>Port</th>
                    <th className={th}>State</th>
                    <th className={th}>ONUs</th>
                    <th className={th}>Download</th>
                    <th className={th}>Upload</th>
                    <th className={th}>Description</th>
                  </tr>
                </thead>
                <tbody>
                  {pon.map((p) => (
                    <tr key={p.name} className="border-t border-gray-800">
                      <td className={td + ' font-mono'}>{p.name}</td>
                      <td className={td}><PortState enabled={p.enabled} up={p.up} /></td>
                      <td className={td + ' tabular-nums'}>
                        {p.registered ?? '—'}
                        {p.capacity ? <span className="text-gray-600"> / {p.capacity}</span> : null}
                      </td>
                      <td className={td + ' tabular-nums'}>{rate(p.outBps)}</td>
                      <td className={td + ' tabular-nums'}>{rate(p.inBps)}</td>
                      <td className={td}>{p.description ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="py-2 text-[11px] text-gray-500">
                A PON port shows No link until at least one ONU is online on it.
              </p>
            </div>
          )
        ) : null}

        {tab === 'uplinks' ? (
          uplinks.length === 0 ? (
            <Empty>No uplink ports read yet. Press Refresh from OLT.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className={th}>Port</th>
                    <th className={th}>Type</th>
                    <th className={th}>State</th>
                    <th className={th}>In</th>
                    <th className={th}>Out</th>
                    <th className={th}>Description</th>
                  </tr>
                </thead>
                <tbody>
                  {uplinks.map((u) => (
                    <tr key={u.name} className="border-t border-gray-800">
                      <td className={td + ' font-mono'}>{u.name}</td>
                      <td className={td}>{u.medium === 'fibre' ? 'Fibre (SFP)' : 'Copper'}</td>
                      <td className={td}><PortState enabled={u.enabled} up={u.up} /></td>
                      <td className={td + ' tabular-nums'}>{rate(u.inBps)}</td>
                      <td className={td + ' tabular-nums'}>{rate(u.outBps)}</td>
                      <td className={td}>{u.description ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}

        {tab === 'vlans' ? (
          vlans.length === 0 ? (
            <Empty>No VLANs read yet. Press Refresh from OLT.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className={th}>VLAN</th>
                    <th className={th}>Name</th>
                    <th className={th}>Untagged ports</th>
                    <th className={th}>Tagged ports</th>
                    <th className={th}>Description</th>
                  </tr>
                </thead>
                <tbody>
                  {vlans.map((v) => (
                    <tr key={v.id} className="border-t border-gray-800">
                      <td className={td + ' tabular-nums'}>{v.id}</td>
                      <td className={td}>{v.name ?? '—'}</td>
                      <td className={td + ' font-mono'}>{v.untagged ?? '—'}</td>
                      <td className={td + ' font-mono'}>{v.tagged ?? '—'}</td>
                      <td className={td}>{v.description ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}
      </div>
    </div>
  )
}
