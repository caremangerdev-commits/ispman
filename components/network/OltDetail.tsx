'use client'

import Link from 'next/link'
import { useActionState, useCallback, useEffect, useRef, useState } from 'react'
import { useFormStatus } from 'react-dom'

import { OutagePanel } from '@/components/network/OutagePanel'
import { OltFrontPanel } from '@/components/network/OltFrontPanel'
import { OltSettings } from '@/components/network/OltSettings'
import type { OnuDefaults } from '@/lib/data/olt-defaults'
import { oltFeatures } from '@/lib/olt/features'
import type { SignalLevels } from '@/lib/olt/signal-levels'
import { checkOlt, loadOnus, setOltAutoAuthorise, type OltActionResult } from '@/app/actions/olts'
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

type Tab = 'details' | 'authorised' | 'pending' | 'offline' | 'cards' | 'pon' | 'uplinks' | 'vlans' | 'outages' | 'settings'

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
  olt, routerName, checkedText, canManage, autoAuthorise = false, saved = null, focus = null, onuDefaults = null,
  signalLevels = null, settingsUnlocked = false,
}: {
  olt: Olt
  routerName: string
  /** When the figures were read, already in words. Null if never. */
  checkedText: string | null
  canManage: boolean
  autoAuthorise?: boolean
  /** The background check's last ONU list, with its age in words. */
  saved?: { onus: OnuLists['onus']; customers: OnuLists['customers']; text: string | null } | null
  /** Open on this ONU: from the ONU search. */
  focus?: { port: string; serial: string } | null
  /** How new ONUs were last set up on this OLT. */
  onuDefaults?: OnuDefaults | null
  signalLevels?: SignalLevels | null
  settingsUnlocked?: boolean
}) {
  const [auto, setAuto] = useState(autoAuthorise)
  const [autoNote, setAutoNote] = useState<string | null>(null)
  const toggleAuto = async () => {
    const next = !auto
    setAutoNote(null)
    const res = await setOltAutoAuthorise(olt.id, next)
    if (res.ok) setAuto(next)
    else setAutoNote(res.error)
  }
  const [tab, setTab] = useState<Tab>(focus ? 'authorised' : 'details')
  // The port picked on the front panel, as the ONU list names it, and a count
  // that remounts the list so a new pick takes effect even on the same tab.
  const [pickedPort, setPickedPort] = useState<string>(focus?.port ?? '')
  const [pickN, setPickN] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const pickPort = (filter: string) => {
    setPickedPort(filter)
    setPickN((n) => n + 1)
    if (!ONU_TABS.includes(tab) || tab === 'pending') setTab('authorised')
    window.setTimeout(() => listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }
  // SHOW WHAT IS KNOWN AT ONCE, THEN BRING IT UP TO DATE. The background
  // check reads every OLT every five minutes and saves the list, so the page
  // opens with that, and a live reading replaces it as soon as it arrives —
  // nobody waits on a blank page or presses anything.
  const [lists, setLists] = useState<OnuLists | null>(
    saved ? { pending: [], onus: saved.onus, customers: saved.customers } : null
  )
  const [live, setLive] = useState(false)
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const info = olt.info
  const busyRef = useRef(false)

  const reload = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    setLoading(true)
    setListError(null)
    try {
      const res = await loadOnus(olt.id)
      if (res.ok) {
        setLists({ pending: res.pending, onus: res.onus, customers: res.customers, seen: res.seen })
        setLive(true)
      } else setListError(res.error)
    } catch {
      setListError('Could not reach ISPMan.')
    } finally {
      busyRef.current = false
      setLoading(false)
    }
  }, [olt.id])

  // Live reading on opening the page, then every two minutes while an ONU
  // list is on screen and the browser tab is in front.
  const onList = ONU_TABS.includes(tab)
  useEffect(() => {
    // From a timer, not the effect body: the reading sets state as it starts.
    const t = window.setTimeout(() => void reload(), 0)
    return () => window.clearTimeout(t)
  }, [reload])
  useEffect(() => {
    if (!onList) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void reload()
    }, 120_000)
    return () => window.clearInterval(timer)
  }, [onList, reload])

  const open = (t: Tab) => setTab(t)
  const cards = info?.cards ?? []
  const pon = info?.ponPorts ?? []
  const uplinks = info?.uplinks ?? []
  const vlans = info?.vlans ?? []

  // Only what this make of OLT can show. A ZTE that has simply not been read
  // yet still gets its tabs; a GCOM never gets a Cards tab.
  const has = oltFeatures(olt.brand)
  const tabs = ([
    { id: 'details', label: 'OLT details' },
    { id: 'authorised', label: 'Authorized' },
    has.authorise ? { id: 'pending', label: 'Unauthorized' } : null,
    has.cards ? { id: 'cards', label: 'Cards', count: cards.length } : null,
    { id: 'pon', label: 'PON ports', count: pon.length },
    { id: 'outages', label: 'Outages' },
    has.uplinks ? { id: 'uplinks', label: 'Uplinks', count: uplinks.length } : null,
    has.vlans ? { id: 'vlans', label: 'VLANs', count: vlans.length } : null,
    has.settings.kinds.length > 0 && canManage ? { id: 'settings', label: 'Settings' } : null,
  ] as ({ id: Tab; label: string; count?: number } | null)[]).filter(
    (t): t is { id: Tab; label: string; count?: number } => t !== null
  )

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

      <OltFrontPanel
        model={info?.model ?? null}
        brand={olt.brand}
        reachable={olt.ok ?? null}
        info={info ?? null}
        onus={lists?.onus ?? null}
        selected={ONU_TABS.includes(tab) && tab !== 'pending' ? pickedPort || null : null}
        onPickPort={pickPort}
        onUplinks={has.uplinks ? () => setTab('uplinks') : undefined}
      />

      {/*
        The three numbers someone opens an OLT to see. Each opens its own
        list, read from the OLT at that moment.
      */}
      <div className={'grid gap-3 ' + (has.authorise ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}>
        <Count
          label="Authorized"
          value={lists ? lists.onus.length : info?.onus?.authorised}
          tone="text-green-400"
          note="ONUs registered on this OLT"
          active={tab === 'authorised'}
          onOpen={() => open('authorised')}
        />
        {has.authorise ? (
        <Count
          label="Unauthorized"
          value={lists && live ? lists.pending.length : info?.onus?.unauthorised}
          tone={(lists && live ? lists.pending.length : info?.onus?.unauthorised) ? 'text-blue-400' : 'text-white'}
          note="Plugged in, waiting to be authorized"
          active={tab === 'pending'}
          onOpen={() => open('pending')}
        />
        ) : null}
        <Count
          label="Offline"
          value={lists ? lists.onus.filter((o) => !o.online).length : info?.onus?.offline}
          tone={(lists ? lists.onus.filter((o) => !o.online).length : info?.onus?.offline) ? 'text-red-400' : 'text-white'}
          note="Authorized but not in service"
          active={tab === 'offline'}
          onOpen={() => open('offline')}
        />
      </div>

      <div ref={listRef} className="flex scroll-mt-4 flex-wrap gap-1 border-b border-gray-800" role="tablist">
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
            {has.authorise ? (
            <div className="flex items-start justify-between gap-4 border-t border-gray-800 py-3">
              <div className="min-w-0">
                <dt className="text-xs font-medium text-gray-200">Authorize new ONUs automatically</dt>
                <dd className="mt-0.5 max-w-xl text-[11px] leading-relaxed text-gray-500">
                  {olt.serviceVlan
                    ? 'A new ONU plugged into this OLT is let on within about five minutes, on VLAN ' +
                      olt.serviceVlan + ', and you get a notification. Leave this off if anyone else can reach your fibre.'
                    : 'Authorize one ONU by hand first. That sets the VLAN new ONUs go on, and this can then be switched on.'}
                  {autoNote ? <span className="block text-red-300">{autoNote}</span> : null}
                </dd>
              </div>
              {canManage && has.writes ? (
                <button
                  type="button"
                  role="switch"
                  aria-checked={auto}
                  aria-label="Authorize new ONUs automatically"
                  disabled={!olt.serviceVlan && !auto}
                  onClick={() => void toggleAuto()}
                  className={
                    'relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition disabled:opacity-40 ' +
                    (auto ? 'bg-blue-600' : 'bg-gray-700')
                  }
                >
                  <span
                    className={
                      'absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ' + (auto ? 'left-[18px]' : 'left-0.5')
                    }
                  />
                </button>
              ) : (
                <span className="text-xs text-gray-400">{auto ? 'On' : 'Off'}</span>
              )}
            </div>
            ) : (
              <Field label="New ONUs" value="Added by the OLT itself when plugged in" />
            )}
          </dl>
        ) : null}

        {tab === 'authorised' || tab === 'pending' || tab === 'offline' ? (
          <OnuPanel
            key={tab + ':' + pickN}
            oltId={olt.id}
            brand={olt.brand}
            view={tab}
            lists={lists}
            freshness={live ? null : saved?.text ?? null}
            loading={loading}
            error={listError}
            canManage={canManage}
            vlans={vlans.map((v) => v.id).filter((id) => id !== 1)}
            defaultVlan={
              olt.serviceVlan ?? (vlans.filter((v) => v.id !== 1).length === 1 ? vlans.filter((v) => v.id !== 1)[0].id : null)
            }
            onReload={() => void reload()}
            focus={tab === 'pending' ? null : pickN > 0 || !focus ? { port: pickedPort, serial: '' } : focus}
            onPortChange={tab === 'pending' ? undefined : setPickedPort}
            onuDefaults={onuDefaults}
            speedProfiles={info?.speedProfiles ?? []}
            signalLevels={signalLevels}
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

        {tab === 'outages' ? <OutagePanel oltId={olt.id} canManage={canManage} /> : null}
        {tab === 'settings' ? <OltSettings oltId={olt.id} brand={olt.brand} info={info ?? null} signalLevels={signalLevels} unlocked={settingsUnlocked} /> : null}
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
                      <td className={td}>{u.linkKnown === false ? <span className="text-gray-500">Not read</span> : <PortState enabled={u.enabled} up={u.up} />}</td>
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
