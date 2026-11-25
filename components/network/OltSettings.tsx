'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'

import {
  applyOltChange, listOltChanges, previewOltChange, setOltSettingsUnlocked, undoOltChange, type OltChange,
} from '@/app/actions/olts'
import { SavedSetups, SignalLevelsSection } from '@/components/network/OltSettingsExtra'
import { oltFeatures, type SettingKind } from '@/lib/olt/features'
import type { SignalLevels } from '@/lib/olt/signal-levels'
import type { OltChangePlan, OltConfigChange, OltInfo, OltUplink } from '@/lib/olt/types'

/**
 * The OLT's own settings, changed from ISPMan.
 *
 * ONE THING AT A TIME. The tab is split into a few sections — network,
 * PON ports, speeds, signal alerts, ONU setups, history — and shows one, so
 * nobody scrolls past VLAN tables to find a port label.
 *
 * PLAIN WORDS FIRST, COMMANDS ON REQUEST. Every change opens a review box
 * that says what will happen in a sentence, with anything worth weighing
 * (customers that will drop) above it. The exact commands are one click
 * away for those who want them. Nothing is sent until "Apply" is pressed,
 * and every change can be undone from History.
 *
 * What it will not do — remove the VLAN the OLT is managed on, or take it
 * off a live uplink — the server refuses, whatever is pressed here.
 */

type Tab = 'network' | 'pon' | 'speed' | 'signal' | 'setups' | 'history'

const portShort = (p: string) =>
  p
    .replace(/^gpon-olt_\d+\/(\d+)\/(\d+)$/, 'PON $1/$2')
    .replace(/^\d+\/\d+\/(\d+)$/, 'PON $1')
    .replace(/^xgei_\d+\/(\d+)\/(\d+)$/, '10G $1/$2')
    .replace(/^gei_\d+\/(\d+)\/(\d+)$/, 'GE $1/$2')
    .replace(/^xge0\/0\/(\d+)$/, '10G $1')
    .replace(/^ge0\/0\/(\d+)$/, 'GE $1')

/** Whether "gei_1/3/1-3 gei_1/4/2", as the OLT lists a VLAN's ports, includes a port. */
function listsPort(list: string | null, port: string): boolean {
  if (!list) return false
  const m = /^(.*\/)(\d+)$/.exec(port)
  if (!m) return false
  for (const token of list.split(/[\s,]+/)) {
    const t = /^(.*\/)(\d+)(?:-(\d+))?$/.exec(token)
    if (!t || t[1] !== m[1]) continue
    const n = Number(m[2])
    if (n >= Number(t[2]) && n <= Number(t[3] ?? t[2])) return true
  }
  return false
}

const mbpsWords = (kbps: number | null, raw: string) =>
  kbps ? (kbps >= 1024 ? Math.round(kbps / 102.4) / 10 + ' Mbps' : kbps + ' kbps') : raw

const field =
  'rounded-lg border border-gray-700 bg-gray-950 px-3 py-1.5 text-sm text-gray-100 focus:border-blue-500 focus:outline-none'
const ghost = 'rounded-lg border border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-200 hover:bg-gray-800 disabled:opacity-50'
const primary = 'rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-60'
const link = 'text-xs font-medium text-blue-400 hover:underline disabled:opacity-50'

export function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-gray-800 p-5">
      <h3 className="text-base font-semibold text-white">{title}</h3>
      {note ? <p className="mt-1 max-w-2xl text-xs leading-relaxed text-gray-500">{note}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  )
}

/**
 * A call to the server that cannot leave a button stuck. The usual way one
 * fails is a page opened before ISPMan was updated: its buttons point at the
 * old server code and the call throws instead of answering.
 */
export async function safe<T extends { ok: boolean }>(call: () => Promise<T>): Promise<T | { ok: false; error: string }> {
  try {
    return await call()
  } catch {
    return {
      ok: false,
      error: 'ISPMan did not answer. If it was updated since this page was opened, reload the page (Ctrl+F5) and try again.',
    }
  }
}

/** A small removable tag, e.g. a VLAN on an uplink. */
function Chip({ children, onRemove, removeLabel, busy }: { children: React.ReactNode; onRemove?: () => void; removeLabel?: string; busy?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-gray-700 bg-gray-900 py-1 pl-3 pr-2 text-xs text-gray-100">
      {children}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          disabled={busy}
          aria-label={removeLabel}
          title={removeLabel}
          className="flex h-4 w-4 items-center justify-center rounded-full text-gray-500 hover:bg-red-950 hover:text-red-300 disabled:opacity-50"
        >
          ×
        </button>
      ) : null}
    </span>
  )
}

export function OltSettings({
  oltId, brand, info, signalLevels = null, unlocked = false,
}: {
  oltId: number
  brand: string
  info: OltInfo | null
  signalLevels?: SignalLevels | null
  /** The owner has switched on running untested commands on this OLT. */
  unlocked?: boolean
}) {
  const router = useRouter()
  const caps = oltFeatures(brand).settings
  const can = (k: SettingKind) => caps.kinds.includes(k)
  const [unlockedNow, setUnlockedNow] = useState(unlocked)
  const runnable = caps.tested || unlockedNow

  const vlans = info?.vlans ?? []
  const uplinks = info?.uplinks ?? []
  const pons = info?.ponPorts ?? []
  const speeds = info?.speedProfiles ?? []

  const tabs = ([
    { id: 'network', label: 'VLANs & uplinks', show: can('vlan-add') || can('uplink-vlan-add') },
    { id: 'pon', label: 'PON ports', show: pons.length > 0 && (can('pon-disable') || can('port-description')) },
    { id: 'speed', label: 'Speeds', show: can('speed-add') },
    { id: 'signal', label: 'Signal alerts', show: true },
    { id: 'setups', label: 'ONU setups', show: true },
    { id: 'history', label: 'History', show: true },
  ] as { id: Tab; label: string; show: boolean }[]).filter((t) => t.show)
  const [tab, setTab] = useState<Tab>(tabs[0]?.id ?? 'signal')

  const [review, setReview] = useState<{ change: OltConfigChange; plan: OltChangePlan } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [changes, setChanges] = useState<OltChange[]>([])

  // Small forms, one open at a time.
  const [open, setOpen] = useState<string | null>(null)
  const [newVlan, setNewVlan] = useState('')
  const [newName, setNewName] = useState('')
  const [addVlan, setAddVlan] = useState('')
  const [addTagged, setAddTagged] = useState(true)
  const [labelText, setLabelText] = useState('')
  const [pvid, setPvid] = useState('')
  const [speedDir, setSpeedDir] = useState<'up' | 'down'>(caps.downSpeed ? 'down' : 'up')
  const [speedMbps, setSpeedMbps] = useState('')
  const [speedName, setSpeedName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)

  const loadChanges = useCallback(async () => {
    const res = await safe(() => listOltChanges(oltId))
    if (res.ok) setChanges(res.changes)
  }, [oltId])
  useEffect(() => {
    const t = window.setTimeout(() => void loadChanges(), 0)
    return () => window.clearTimeout(t)
  }, [loadChanges])

  const preview = async (change: OltConfigChange, key: string) => {
    setBusy(key)
    setNote(null)
    const res = await safe(() => previewOltChange(oltId, change))
    setBusy(null)
    if (res.ok) setReview({ change, plan: res.plan })
    else setNote({ ok: false, text: res.error })
  }

  const apply = async () => {
    if (!review) return
    setBusy('apply')
    const res = await safe(() => applyOltChange(oltId, review.change))
    setBusy(null)
    setReview(null)
    setNote(res.ok ? { ok: true, text: res.message } : { ok: false, text: res.error })
    if (res.ok) {
      setOpen(null)
      setNewVlan('')
      setNewName('')
      setAddVlan('')
      setSpeedMbps('')
      setSpeedName('')
      setNameTouched(false)
      router.refresh()
      void loadChanges()
    }
  }

  const undo = async (c: OltChange) => {
    setBusy('undo' + c.id)
    setNote(null)
    const res = await safe(() => undoOltChange(c.id))
    setBusy(null)
    setNote(res.ok ? { ok: true, text: res.message } : { ok: false, text: res.error })
    if (res.ok) {
      router.refresh()
      void loadChanges()
    }
  }

  const toggle = (key: string, prepare?: () => void) => {
    if (open === key) setOpen(null)
    else {
      prepare?.()
      setOpen(key)
    }
  }

  /* ---------------------------------------------------------------------- */

  const reviewBox = review ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="review-title">
      <div className="w-full max-w-lg rounded-2xl border border-gray-700 bg-gray-900 p-6 shadow-2xl">
        <p className="text-xs font-medium text-gray-500">Check this before it goes to the OLT</p>
        <h3 id="review-title" className="mt-1 text-lg font-semibold text-white">{review.plan.summary}</h3>
        {review.plan.warning ? (
          <p className="mt-3 rounded-lg bg-amber-950/40 px-3 py-2 text-sm text-amber-300">{review.plan.warning}</p>
        ) : null}
        <details className="mt-4">
          <summary className="cursor-pointer select-none text-xs text-gray-400 hover:text-gray-200">
            Show the commands ISPMan will send
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-gray-950 px-3 py-2 text-xs leading-relaxed text-gray-300">
            {review.plan.commands.join('\n')}
          </pre>
        </details>
        {!runnable ? (
          <p className="mt-4 text-xs text-amber-300">
            Running ISPMan&apos;s commands is switched off for this OLT, so this can only be looked at.
          </p>
        ) : null}
        <div className="mt-6 flex items-center justify-end gap-2">
          <button type="button" onClick={() => setReview(null)} disabled={busy === 'apply'} className={ghost}>
            Cancel
          </button>
          <button type="button" onClick={() => void apply()} disabled={busy === 'apply' || !runnable} className={primary}>
            {busy === 'apply' ? 'Applying…' : 'Apply'}
          </button>
        </div>
        <p className="mt-3 text-right text-[11px] text-gray-500">The OLT is saved afterwards. You can undo it under History.</p>
      </div>
    </div>
  ) : null

  /** A one-line form under whatever opened it. */
  const labelForm = (port: string) =>
    open === 'label:' + port ? (
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          autoFocus
          value={labelText}
          onChange={(e) => setLabelText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void preview({ kind: 'port-description', port, text: labelText }, 'label')
            if (e.key === 'Escape') setOpen(null)
          }}
          maxLength={60}
          placeholder="e.g. To Lacovia"
          className={field + ' w-64'}
        />
        <button type="button" onClick={() => void preview({ kind: 'port-description', port, text: labelText }, 'label')} disabled={!!busy} className={ghost}>
          {busy === 'label' ? 'Checking…' : 'Save label'}
        </button>
        <button type="button" onClick={() => setOpen(null)} className={link}>Cancel</button>
      </div>
    ) : null

  /* ---------------------------------------------------------------------- */

  const network = (
    <div className="space-y-4">
      {can('vlan-add') ? (
        <Section title="VLANs on this OLT" note="Create the VLANs your network uses here, then add them to the uplinks that carry them to your router.">
          <div className="flex flex-wrap gap-2">
            {vlans.map((v) => {
              const on = uplinks.filter((u) => listsPort(v.tagged, u.name) || listsPort(v.untagged, u.name)).map((u) => portShort(u.name))
              const mgmt = /management/i.test(v.description ?? '')
              return (
                <Chip
                  key={v.id}
                  busy={!!busy}
                  onRemove={v.id !== 1 && can('vlan-remove') && !mgmt ? () => void preview({ kind: 'vlan-remove', vlan: v.id }, 'vr' + v.id) : undefined}
                  removeLabel={'Remove VLAN ' + v.id}
                >
                  <span className="font-semibold">VLAN {v.id}</span>
                  {v.name && !/^VLAN0*\d+$/i.test(v.name) ? <span className="text-gray-400">{v.name}</span> : null}
                  {mgmt ? <span className="rounded bg-blue-950 px-1.5 text-[10px] text-blue-300">management</span> : null}
                  {on.length ? <span className="text-gray-500">on {on.join(', ')}</span> : null}
                </Chip>
              )
            })}
            {vlans.length === 0 ? <p className="text-sm text-gray-500">None read yet. Press Refresh from OLT.</p> : null}
          </div>
          {open === 'vlan' ? (
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <label className="text-xs text-gray-400">
                VLAN number
                <input autoFocus type="number" min={2} max={4094} value={newVlan} onChange={(e) => setNewVlan(e.target.value)} className={field + ' mt-1 block w-28'} />
              </label>
              <label className="text-xs text-gray-400">
                Name <span className="text-gray-600">(optional)</span>
                <input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={30} placeholder="e.g. Customers" className={field + ' mt-1 block w-48'} />
              </label>
              <button
                type="button"
                onClick={() => void preview({ kind: 'vlan-add', vlan: Number(newVlan), name: newName }, 'va')}
                disabled={!!busy || !(Number(newVlan) >= 2 && Number(newVlan) <= 4094)}
                className={primary}
              >
                {busy === 'va' ? 'Checking…' : 'Create'}
              </button>
              <button type="button" onClick={() => setOpen(null)} className={link}>Cancel</button>
            </div>
          ) : (
            <button type="button" onClick={() => toggle('vlan')} className={ghost + ' mt-4'}>+ New VLAN</button>
          )}
        </Section>
      ) : null}

      {uplinks.length && can('uplink-vlan-add') ? (
        <Section title="Uplinks" note="The ports that connect this OLT to your router, and the VLANs each one carries. Tagged is the usual choice: the VLAN number travels with the traffic.">
          <ul className="space-y-3">
            {uplinks.map((u) => uplinkCard(u))}
          </ul>
        </Section>
      ) : null}
    </div>
  )

  // A plain function, not a component: a component defined in here would be
  // a new one every render, and the box being typed in would lose its focus.
  function uplinkCard(u: OltUplink) {
    const carried = vlans
      .map((v) => ({ id: v.id, untagged: listsPort(v.untagged, u.name), on: listsPort(v.tagged, u.name) || listsPort(v.untagged, u.name) }))
      .filter((v) => v.on)
    const addable = vlans.filter((v) => !carried.some((c) => c.id === v.id))
    const status =
      u.linkKnown === false ? null : !u.enabled ? ['Switched off', 'text-gray-500'] : u.up ? ['Connected', 'text-emerald-400'] : ['No link', 'text-red-400']
    return (
      <li key={u.name} className="rounded-xl border border-gray-800 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-white">
              {portShort(u.name)}
              {u.description ? <span className="ml-2 font-normal text-gray-300">{u.description}</span> : null}
            </p>
            <p className="mt-0.5 text-xs text-gray-500">
              {status ? <span className={status[1]}>{status[0]}</span> : null}
              {status ? ' · ' : ''}
              <span className="font-mono">{u.name}</span>
            </p>
          </div>
          {can('port-description') ? (
            <button type="button" onClick={() => toggle('label:' + u.name, () => setLabelText(u.description ?? ''))} className={link}>
              {u.description ? 'Change label' : 'Add a label'}
            </button>
          ) : null}
        </div>
        {labelForm(u.name)}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-500">Carries</span>
          {carried.map((v) => (
            <Chip
              key={v.id}
              busy={!!busy}
              onRemove={can('uplink-vlan-remove') ? () => void preview({ kind: 'uplink-vlan-remove', port: u.name, vlan: v.id }, 'ur' + u.name + v.id) : undefined}
              removeLabel={'Stop carrying VLAN ' + v.id + ' on ' + portShort(u.name)}
            >
              VLAN {v.id}
              {v.untagged ? <span className="text-gray-500">untagged</span> : null}
            </Chip>
          ))}
          {carried.length === 0 ? <span className="text-xs text-gray-500">no VLANs</span> : null}
          {addable.length && open !== 'add:' + u.name ? (
            <button type="button" onClick={() => toggle('add:' + u.name, () => { setAddVlan(''); setAddTagged(true) })} className={link}>
              + Add a VLAN
            </button>
          ) : null}
        </div>

        {open === 'add:' + u.name ? (
          <div className="mt-3 rounded-lg bg-gray-950/60 p-3">
            <div className="flex flex-wrap items-center gap-3">
              <select value={addVlan} onChange={(e) => setAddVlan(e.target.value)} className={field}>
                <option value="">Choose a VLAN…</option>
                {addable.map((v) => (
                  <option key={v.id} value={v.id}>VLAN {v.id}{v.name && !/^VLAN0*\d+$/i.test(v.name) ? ' · ' + v.name : ''}</option>
                ))}
              </select>
              <label className="flex items-center gap-1.5 text-sm text-gray-200">
                <input type="radio" checked={addTagged} onChange={() => setAddTagged(true)} /> Tagged
              </label>
              <label className="flex items-center gap-1.5 text-sm text-gray-200">
                <input type="radio" checked={!addTagged} onChange={() => setAddTagged(false)} /> Untagged
              </label>
              <button
                type="button"
                onClick={() => void preview({ kind: 'uplink-vlan-add', port: u.name, vlan: Number(addVlan), tagged: addTagged }, 'ua')}
                disabled={!!busy || !addVlan}
                className={primary}
              >
                {busy === 'ua' ? 'Checking…' : 'Add'}
              </button>
              <button type="button" onClick={() => setOpen(null)} className={link}>Cancel</button>
            </div>
            <p className="mt-2 text-[11px] text-gray-500">
              Untagged: plain traffic, for a router port that is not set up for VLANs. A port can only have one.
            </p>
          </div>
        ) : null}

        {can('uplink-mode') ? (
          <details className="mt-3">
            <summary className="cursor-pointer select-none text-xs text-gray-500 hover:text-gray-300">Advanced</summary>
            <div className="mt-3 space-y-3 text-xs text-gray-400">
              <label className="flex flex-wrap items-center gap-2">
                Port type
                <select
                  value={u.mode ?? ''}
                  onChange={(e) => {
                    const m = e.target.value
                    if (m === 'trunk' || m === 'hybrid' || m === 'access') void preview({ kind: 'uplink-mode', port: u.name, mode: m }, 'um')
                  }}
                  disabled={!!busy}
                  className={field}
                >
                  {u.mode ? null : <option value="">Unknown</option>}
                  <option value="trunk">Trunk: tagged VLANs only</option>
                  <option value="hybrid">Hybrid: tagged and one untagged</option>
                  <option value="access">Access: one VLAN, untagged</option>
                </select>
              </label>
              {u.mode !== 'trunk' ? (
                <div className="flex flex-wrap items-center gap-2">
                  Plain traffic coming in goes to VLAN
                  <input
                    type="number"
                    min={1}
                    max={4094}
                    value={open === 'pvid:' + u.name ? pvid : String(u.pvid ?? '')}
                    onFocus={() => {
                      if (open !== 'pvid:' + u.name) {
                        setPvid(String(u.pvid ?? ''))
                        setOpen('pvid:' + u.name)
                      }
                    }}
                    onChange={(e) => setPvid(e.target.value)}
                    className={field + ' w-24'}
                  />
                  {open === 'pvid:' + u.name && Number(pvid) !== u.pvid && Number(pvid) >= 1 ? (
                    <button type="button" onClick={() => void preview({ kind: 'uplink-pvid', port: u.name, vlan: Number(pvid) }, 'up')} disabled={!!busy} className={ghost}>
                      {busy === 'up' ? 'Checking…' : 'Change'}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </details>
        ) : null}
      </li>
    )
  }

  const ponTab = (
    <Section title="PON ports" note="Give each port a label so you know where its fibre goes. Turning a port off cuts every customer on it until it is turned back on.">
      <ul className="divide-y divide-gray-800">
        {pons.map((p) => (
          <li key={p.name} className="py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span
                  aria-hidden="true"
                  className={'h-2.5 w-2.5 rounded-full ' + (!p.enabled ? 'bg-gray-600' : p.up ? 'bg-emerald-500' : 'bg-red-500')}
                />
                <div>
                  <p className="text-sm font-semibold text-white">
                    {portShort(p.name)}
                    {p.description ? <span className="ml-2 font-normal text-gray-300">{p.description}</span> : null}
                  </p>
                  <p className="text-xs text-gray-500">
                    {!p.enabled ? 'Turned off' : p.up ? 'On' : 'On, but no light'} · {p.registered ?? 0} ONUs
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-4">
                {can('port-description') ? (
                  <button type="button" onClick={() => toggle('label:' + p.name, () => setLabelText(p.description ?? ''))} className={link}>
                    {p.description ? 'Change label' : 'Add a label'}
                  </button>
                ) : null}
                {can('pon-disable') ? (
                  <button
                    type="button"
                    onClick={() => void preview({ kind: p.enabled ? 'pon-disable' : 'pon-enable', port: p.name }, 'pe' + p.name)}
                    disabled={!!busy}
                    className={p.enabled ? 'text-xs font-medium text-amber-400 hover:underline disabled:opacity-50' : link}
                  >
                    {busy === 'pe' + p.name ? 'Checking…' : p.enabled ? 'Turn off' : 'Turn on'}
                  </button>
                ) : null}
              </div>
            </div>
            {labelForm(p.name)}
          </li>
        ))}
      </ul>
    </Section>
  )

  const suggestName = (mbps: string, dir: 'up' | 'down') => (Number(mbps) > 0 ? mbps + 'M-' + (dir === 'down' ? 'DOWN' : 'UP') : '')
  const speedTab = (
    <Section
      title="Speeds"
      note="Speed limits kept on the OLT. Use them if you limit customer speed on the OLT; if your router does it, you can leave these alone. Pick them when authorizing ONUs, or on any ONU under Speed."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {(['down', 'up'] as const)
          .filter((d) => d === 'up' || caps.downSpeed || speeds.some((s) => s.direction === 'down'))
          .map((dir) => {
            const list = speeds.filter((s) => s.direction === dir)
            return (
              <div key={dir} className="rounded-xl border border-gray-800 p-4">
                <p className="text-sm font-semibold text-white">{dir === 'down' ? 'Download' : 'Upload'}</p>
                {list.length ? (
                  <ul className="mt-2 divide-y divide-gray-800">
                    {list.map((s) => (
                      <li key={s.name} className="flex items-center justify-between gap-2 py-2 text-sm">
                        <span className="text-gray-100">{s.name}</span>
                        <span className="flex items-center gap-3">
                          <span className="text-gray-400">
                            {s.name === 'ISPMAN-UP' ? 'No limit · used by ISPMan' : mbpsWords(s.kbps, s.raw)}
                          </span>
                          {s.name !== 'ISPMAN-UP' && can('speed-remove') ? (
                            <button
                              type="button"
                              onClick={() => void preview({ kind: 'speed-remove', direction: dir, name: s.name }, 'sr' + dir + s.name)}
                              disabled={!!busy}
                              title={'Remove ' + s.name}
                              aria-label={'Remove ' + s.name}
                              className="text-gray-500 hover:text-red-300"
                            >
                              ×
                            </button>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-gray-500">None yet.</p>
                )}
              </div>
            )
          })}
      </div>
      {open === 'speed' ? (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          {caps.downSpeed ? (
            <div className="text-xs text-gray-400">
              For
              <div className="mt-1 flex rounded-lg border border-gray-700 p-0.5">
                {(['down', 'up'] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => {
                      setSpeedDir(d)
                      if (!nameTouched) setSpeedName(suggestName(speedMbps, d))
                    }}
                    className={'rounded-md px-3 py-1 text-sm ' + (speedDir === d ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-800')}
                  >
                    {d === 'down' ? 'Download' : 'Upload'}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <label className="text-xs text-gray-400">
            Speed in Mbps
            <input
              autoFocus
              type="number"
              min={1}
              max={10000}
              value={speedMbps}
              onChange={(e) => {
                setSpeedMbps(e.target.value)
                if (!nameTouched) setSpeedName(suggestName(e.target.value, speedDir))
              }}
              className={field + ' mt-1 block w-28'}
            />
          </label>
          <label className="text-xs text-gray-400">
            Name
            <input
              value={speedName}
              onChange={(e) => {
                setNameTouched(true)
                setSpeedName(e.target.value.replace(/\s+/g, '-'))
              }}
              maxLength={32}
              placeholder="e.g. 20M-DOWN"
              className={field + ' mt-1 block w-40'}
            />
          </label>
          <button
            type="button"
            onClick={() => void preview({ kind: 'speed-add', direction: speedDir, name: speedName, mbps: Number(speedMbps) }, 'sa')}
            disabled={!!busy || !speedName.trim() || !(Number(speedMbps) > 0)}
            className={primary}
          >
            {busy === 'sa' ? 'Checking…' : 'Create'}
          </button>
          <button type="button" onClick={() => setOpen(null)} className={link}>Cancel</button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => toggle('speed', () => { setSpeedMbps(''); setSpeedName(''); setNameTouched(false) })}
          className={ghost + ' mt-4'}
        >
          + New speed
        </button>
      )}
    </Section>
  )

  const historyTab = (
    <Section title="History" note="Every change made to this OLT from ISPMan, newest first. Undo puts a change back the way it was.">
      {changes.length === 0 ? (
        <p className="text-sm text-gray-500">Nothing changed from ISPMan yet.</p>
      ) : (
        <ul className="divide-y divide-gray-800">
          {changes.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
              <span>
                <span className={'text-sm ' + (c.undone ? 'text-gray-500 line-through' : 'text-gray-100')}>{c.summary}</span>
                <span className="block text-xs text-gray-500">
                  {new Date(c.madeAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
                  {c.madeBy ? ' · ' + c.madeBy : ''}
                  {c.undone ? ' · undone' : ''}
                </span>
              </span>
              {!c.undone && !c.isUndo ? (
                <button type="button" onClick={() => void undo(c)} disabled={!!busy} className={ghost}>
                  {busy === 'undo' + c.id ? 'Undoing…' : 'Undo'}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Section>
  )

  return (
    <div className="space-y-4 py-2">
      {!caps.tested ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-900/60 bg-amber-950/20 px-4 py-3">
          <p className="max-w-xl text-xs leading-relaxed text-amber-200">
            ISPMan&apos;s commands for this make of OLT come from its manual and haven&apos;t been tried on one yet.
            You can look at any change; nothing is sent unless you switch it on for this OLT.
          </p>
          <label className="flex items-center gap-2 text-xs font-medium text-amber-100">
            <input
              type="checkbox"
              checked={unlockedNow}
              onChange={async (e) => {
                const on = e.target.checked
                const res = await safe(() => setOltSettingsUnlocked(oltId, on))
                if (res.ok) setUnlockedNow(on)
                else setNote({ ok: false, text: res.error })
              }}
            />
            Allow changes on this OLT
          </label>
        </div>
      ) : null}

      <nav className="flex flex-wrap gap-1.5" aria-label="Settings sections">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              setTab(t.id)
              setOpen(null)
              setNote(null)
            }}
            aria-current={tab === t.id ? 'page' : undefined}
            className={
              'rounded-full px-4 py-1.5 text-sm font-medium transition ' +
              (tab === t.id ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700')
            }
          >
            {t.label}
            {t.id === 'history' && changes.length ? <span className="ml-1.5 text-xs opacity-70">{changes.length}</span> : null}
          </button>
        ))}
      </nav>

      {note ? (
        <p role="status" className={'rounded-lg px-4 py-2.5 text-sm ' + (note.ok ? 'bg-emerald-950/40 text-emerald-300' : 'bg-red-950/40 text-red-300')}>
          {note.text}
        </p>
      ) : null}

      {tab === 'network' ? network : null}
      {tab === 'pon' ? ponTab : null}
      {tab === 'speed' ? speedTab : null}
      {tab === 'signal' ? <SignalLevelsSection oltId={oltId} ports={pons.map((p) => p.name)} levels={signalLevels} /> : null}
      {tab === 'setups' ? <SavedSetups profiles={speeds} vlans={vlans.map((v) => v.id).filter((v) => v !== 1)} /> : null}
      {tab === 'history' ? historyTab : null}

      {reviewBox}
    </div>
  )
}
