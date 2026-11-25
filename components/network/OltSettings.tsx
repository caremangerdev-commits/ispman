'use client'

import { useRouter } from 'next/navigation'
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'

import {
  applyOltChange, listOltChanges, previewOltChange, undoOltChange, type OltChange,
} from '@/app/actions/olts'
import { SavedSetups, SignalLevelsSection } from '@/components/network/OltSettingsExtra'
import type { SignalLevels } from '@/lib/olt/signal-levels'
import type { OltChangePlan, OltConfigChange, OltInfo } from '@/lib/olt/types'

/**
 * The OLT's own settings, changed from ISPMan: VLANs, which VLANs each uplink
 * carries, and PON ports on, off and described.
 *
 * NOTHING RUNS UNTIL IT HAS BEEN SHOWN. Every change is worked out by the
 * server from the OLT's state at that moment and shown as the exact commands
 * it will send, with anything worth weighing (customers that will drop) above
 * them. Only then does "Run on the OLT" send them, after which the OLT is
 * saved and read back. Each change is listed below with an Undo.
 *
 * What it will not do — remove the VLAN the OLT is managed on, or take it
 * off a live uplink — the server refuses, whatever is pressed here.
 */

const portShort = (p: string) => p.replace(/^gpon-olt_/, 'PON ').replace(/^x?gei_/, (m) => (m.startsWith('x') ? '10G ' : 'GE '))

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

const field =
  'rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-100 focus:border-blue-500 focus:outline-none'
const small = 'rounded-md bg-gray-800 px-2.5 py-1 text-[11px] font-medium text-gray-200 hover:bg-gray-700 disabled:opacity-50'
const primary = 'rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-60'
const th = 'py-2 pr-4 text-left text-[10px] font-medium uppercase tracking-wider text-gray-500'
const td = 'py-2 pr-4 text-xs text-gray-300 align-top'

export function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-gray-800 p-4">
      <h3 className="text-sm font-semibold text-white">{title}</h3>
      {note ? <p className="mt-0.5 text-[11px] text-gray-500">{note}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  )
}

/**
 * A call to the server that cannot leave a button stuck. The usual way one
 * fails is a page opened before ISPMan was updated: its buttons point at the
 * old server code and the call throws instead of answering, which would leave
 * "Checking…" on screen for ever with no word as to why.
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

export function OltSettings({
  oltId, info, signalLevels = null,
}: {
  oltId: number
  info: OltInfo | null
  signalLevels?: SignalLevels | null
}) {
  const router = useRouter()
  const [pending, setPending] = useState<{ change: OltConfigChange; plan: OltChangePlan } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [changes, setChanges] = useState<OltChange[]>([])
  const topRef = useRef<HTMLDivElement>(null)

  const [newVlan, setNewVlan] = useState('')
  const [newName, setNewName] = useState('')
  const [addTo, setAddTo] = useState<Record<string, { vlan: string; tagged: boolean }>>({})
  const [describing, setDescribing] = useState<{ port: string; text: string } | null>(null)
  const [speedDir, setSpeedDir] = useState<'up' | 'down'>('down')
  const [speedName, setSpeedName] = useState('')
  const [speedMbps, setSpeedMbps] = useState('')
  const [pvidFor, setPvidFor] = useState<Record<string, string>>({})

  const loadChanges = useCallback(async () => {
    const res = await listOltChanges(oltId)
    if (res.ok) setChanges(res.changes)
  }, [oltId])
  useEffect(() => {
    const t = window.setTimeout(() => void loadChanges(), 0)
    return () => window.clearTimeout(t)
  }, [loadChanges])

  const vlans = info?.vlans ?? []
  const uplinks = info?.uplinks ?? []
  const pons = info?.ponPorts ?? []
  const speeds = info?.speedProfiles ?? []

  const preview = async (change: OltConfigChange, key: string) => {
    setBusy(key)
    setNote(null)
    setPending(null)
    const res = await safe(() => previewOltChange(oltId, change))
    setBusy(null)
    if (res.ok) setPending({ change, plan: res.plan })
    else setNote({ ok: false, text: res.error })
    // The commands appear at the top of the tab; bring them into view.
    window.setTimeout(() => topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }

  const runIt = async () => {
    if (!pending) return
    setBusy('run')
    const res = await safe(() => applyOltChange(oltId, pending.change))
    setBusy(null)
    setPending(null)
    setNote(res.ok ? { ok: true, text: res.message } : { ok: false, text: res.error })
    window.setTimeout(() => topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
    if (res.ok) {
      setNewVlan('')
      setNewName('')
      setSpeedName('')
      setSpeedMbps('')
      setDescribing(null)
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

  // The label box opens at the port it belongs to, not somewhere
  // further down the page where it is easy to miss.
  const describeEditor = (port: string) =>
    describing?.port === port ? (
      <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-blue-500/40 bg-gray-950 p-2 text-xs text-gray-400">
        <input
          autoFocus
          value={describing.text}
          onChange={(e) => setDescribing({ ...describing, text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void preview({ kind: 'port-description', port, text: describing.text }, 'pd')
            if (e.key === 'Escape') setDescribing(null)
          }}
          maxLength={60}
          placeholder="e.g. To Lacovia, Pole 14"
          className={field + ' w-64'}
        />
        <button
          type="button"
          onClick={() => void preview({ kind: 'port-description', port, text: describing.text }, 'pd')}
          disabled={!!busy}
          className={small}
        >
          {busy === 'pd' ? 'Checking…' : 'Save'}
        </button>
        <button type="button" onClick={() => setDescribing(null)} className={small}>Cancel</button>
        <span className="w-full text-[11px] text-gray-500">The OLT stores one word, so spaces become dashes.</span>
      </div>
    ) : null

  const confirm = pending ? (
    <div className="sticky top-2 z-10 rounded-xl border border-blue-500/60 bg-gray-900 p-4 shadow-lg">
      <p className="text-sm font-semibold text-white">{pending.plan.summary}</p>
      {pending.plan.warning ? (
        <p className="mt-2 rounded-md bg-amber-950/40 px-3 py-2 text-xs text-amber-300">{pending.plan.warning}</p>
      ) : null}
      <p className="mt-2 text-[11px] text-gray-500">These commands go to the OLT, then it is saved:</p>
      <pre className="mt-1 overflow-x-auto rounded-md bg-gray-950 px-3 py-2 text-[11px] leading-relaxed text-gray-300">
        {pending.plan.commands.join('\n')}
      </pre>
      <div className="mt-3 flex items-center gap-2">
        <button type="button" onClick={() => void runIt()} disabled={busy === 'run'} className={primary}>
          {busy === 'run' ? 'Running…' : 'Run on the OLT'}
        </button>
        <button type="button" onClick={() => setPending(null)} disabled={busy === 'run'} className={small}>
          Cancel
        </button>
        <span className="text-[11px] text-gray-500">You can undo it afterwards.</span>
      </div>
    </div>
  ) : null

  return (
    <div ref={topRef} className="scroll-mt-4 space-y-4 py-2">
      {note ? (
        <p className={'rounded-lg px-3 py-2 text-xs ' + (note.ok ? 'bg-emerald-950/40 text-emerald-300' : 'bg-red-950/40 text-red-300')}>
          {note.text}
        </p>
      ) : null}
      {confirm}

      <Section title="VLANs" note="The VLANs that exist on this OLT. A VLAN still used by ONUs or uplinks cannot be removed.">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className={th}>VLAN</th>
                <th className={th}>Name</th>
                <th className={th}>Uplinks tagged</th>
                <th className={th}>Uplinks untagged</th>
                <th className={th}></th>
              </tr>
            </thead>
            <tbody>
              {vlans.map((v) => (
                <tr key={v.id} className="border-t border-gray-800">
                  <td className={td + ' font-mono font-semibold text-gray-100'}>{v.id}</td>
                  <td className={td}>{v.name ?? '—'}</td>
                  <td className={td + ' font-mono text-[11px]'}>{v.tagged?.split(' ').filter((t) => /gei_/.test(t)).join(' ') || '—'}</td>
                  <td className={td + ' font-mono text-[11px]'}>{v.untagged?.split(' ').filter((t) => /gei_/.test(t)).join(' ') || '—'}</td>
                  <td className={td + ' text-right'}>
                    {v.id !== 1 ? (
                      <button
                        type="button"
                        onClick={() => void preview({ kind: 'vlan-remove', vlan: v.id }, 'vr' + v.id)}
                        disabled={!!busy}
                        className={small + ' text-red-300'}
                      >
                        {busy === 'vr' + v.id ? 'Checking…' : 'Remove'}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            type="number"
            min={2}
            max={4094}
            value={newVlan}
            onChange={(e) => setNewVlan(e.target.value)}
            placeholder="VLAN"
            className={field + ' w-24'}
          />
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Name (optional)" maxLength={30} className={field + ' w-44'} />
          <button
            type="button"
            onClick={() => void preview({ kind: 'vlan-add', vlan: Number(newVlan), name: newName }, 'va')}
            disabled={!!busy || !(Number(newVlan) >= 2 && Number(newVlan) <= 4094)}
            className={primary}
          >
            {busy === 'va' ? 'Checking…' : 'Create VLAN'}
          </button>
        </div>
      </Section>

      {uplinks.length ? (
        <Section
          title="Uplinks"
          note="Which VLANs each uplink carries to your router. The VLAN this OLT is managed on cannot be taken off a working uplink from here."
        >
          <ul className="space-y-3">
            {uplinks.map((u) => {
              const carried = vlans
                .map((v) => ({
                  id: v.id,
                  tagged: listsPort(v.tagged, u.name),
                  untagged: listsPort(v.untagged, u.name),
                }))
                .filter((v) => v.tagged || v.untagged)
              const form = addTo[u.name] ?? { vlan: '', tagged: true }
              return (
                <li key={u.name} className="rounded-lg border border-gray-800 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs">
                      <span className="font-semibold text-gray-100">{portShort(u.name)}</span>{' '}
                      <span className="font-mono text-gray-500">{u.name}</span>{' '}
                      <span className={u.up ? 'text-emerald-300' : u.enabled ? 'text-red-300' : 'text-gray-500'}>
                        · {u.up ? 'link up' : u.enabled ? 'no link' : 'switched off'}
                      </span>
                      {u.description ? <span className="text-gray-400"> · {u.description}</span> : null}
                    </p>
                    <button
                      type="button"
                      onClick={() => setDescribing({ port: u.name, text: u.description ?? '' })}
                      className={small}
                    >
                      Label
                    </button>
                  </div>
                  {describeEditor(u.name)}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {carried.length ? (
                      carried.map((v) => (
                        <span key={v.id} className="inline-flex items-center gap-1 rounded-full bg-gray-800 px-2 py-0.5 text-[11px] text-gray-200">
                          VLAN {v.id} {v.untagged ? 'untagged' : 'tagged'}
                          <button
                            type="button"
                            aria-label={'Stop carrying VLAN ' + v.id + ' on ' + u.name}
                            onClick={() => void preview({ kind: 'uplink-vlan-remove', port: u.name, vlan: v.id }, 'ur' + u.name + v.id)}
                            disabled={!!busy}
                            className="text-gray-500 hover:text-red-300"
                          >
                            ×
                          </button>
                        </span>
                      ))
                    ) : (
                      <span className="text-[11px] text-gray-500">Carries no VLANs.</span>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-400">
                    Add VLAN
                    <select
                      value={form.vlan}
                      onChange={(e) => setAddTo({ ...addTo, [u.name]: { ...form, vlan: e.target.value } })}
                      className={field}
                    >
                      <option value="">Choose…</option>
                      {vlans.filter((v) => !carried.some((c) => c.id === v.id)).map((v) => (
                        <option key={v.id} value={v.id}>{v.id}{v.name ? ' · ' + v.name : ''}</option>
                      ))}
                    </select>
                    <select
                      value={form.tagged ? 'tag' : 'untag'}
                      onChange={(e) => setAddTo({ ...addTo, [u.name]: { ...form, tagged: e.target.value === 'tag' } })}
                      className={field}
                    >
                      <option value="tag">tagged</option>
                      <option value="untag">untagged</option>
                    </select>
                    <button
                      type="button"
                      onClick={() =>
                        void preview({ kind: 'uplink-vlan-add', port: u.name, vlan: Number(form.vlan), tagged: form.tagged }, 'ua' + u.name)
                      }
                      disabled={!!busy || !form.vlan}
                      className={small}
                    >
                      {busy === 'ua' + u.name ? 'Checking…' : 'Add'}
                    </button>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-gray-400">
                    <label className="flex items-center gap-2">
                      Mode
                      <select
                        value={u.mode ?? ''}
                        onChange={(e) => {
                          const m = e.target.value
                          if (m === 'trunk' || m === 'hybrid' || m === 'access') {
                            void preview({ kind: 'uplink-mode', port: u.name, mode: m }, 'um' + u.name)
                          }
                        }}
                        disabled={!!busy}
                        className={field}
                      >
                        {u.mode ? null : <option value="">—</option>}
                        <option value="trunk">trunk (tagged VLANs only)</option>
                        <option value="hybrid">hybrid (tagged and untagged)</option>
                        <option value="access">access (one VLAN)</option>
                      </select>
                    </label>
                    {u.mode !== 'trunk' ? (
                      <label className="flex items-center gap-2">
                        Untagged traffic in goes to VLAN
                        <input
                          type="number"
                          min={1}
                          max={4094}
                          value={pvidFor[u.name] ?? String(u.pvid ?? '')}
                          onChange={(e) => setPvidFor({ ...pvidFor, [u.name]: e.target.value })}
                          className={field + ' w-20'}
                        />
                        <button
                          type="button"
                          onClick={() => void preview({ kind: 'uplink-pvid', port: u.name, vlan: Number(pvidFor[u.name] ?? u.pvid) }, 'up' + u.name)}
                          disabled={!!busy || !pvidFor[u.name] || Number(pvidFor[u.name]) === u.pvid}
                          className={small}
                        >
                          {busy === 'up' + u.name ? 'Checking…' : 'Set'}
                        </button>
                      </label>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        </Section>
      ) : null}

      {pons.length ? (
        <Section title="PON ports" note="Switching a port off drops every customer on it until it is switched back on.">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className={th}>Port</th>
                  <th className={th}>ONUs</th>
                  <th className={th}>State</th>
                  <th className={th}>Label</th>
                  <th className={th}></th>
                </tr>
              </thead>
              <tbody>
                {pons.map((p) => (
                  <Fragment key={p.name}>
                  <tr className="border-t border-gray-800">
                    <td className={td}>
                      <span className="font-semibold text-gray-100">{portShort(p.name)}</span>{' '}
                      <span className="font-mono text-[11px] text-gray-500">{p.name}</span>
                    </td>
                    <td className={td}>{p.registered ?? '—'}</td>
                    <td className={td}>
                      <span className={!p.enabled ? 'text-gray-500' : p.up ? 'text-emerald-300' : 'text-red-300'}>
                        {!p.enabled ? 'Switched off' : p.up ? 'On' : 'On, no light'}
                      </span>
                    </td>
                    <td className={td}>{p.description ?? '—'}</td>
                    <td className={td + ' whitespace-nowrap text-right'}>
                      <button type="button" onClick={() => setDescribing({ port: p.name, text: p.description ?? '' })} className={small}>
                        Label
                      </button>{' '}
                      <button
                        type="button"
                        onClick={() => void preview({ kind: p.enabled ? 'pon-disable' : 'pon-enable', port: p.name }, 'pe' + p.name)}
                        disabled={!!busy}
                        className={small + (p.enabled ? ' text-amber-300' : ' text-emerald-300')}
                      >
                        {busy === 'pe' + p.name ? 'Checking…' : p.enabled ? 'Switch off' : 'Switch on'}
                      </button>
                    </td>
                  </tr>
                  {describing?.port === p.name ? (
                    <tr>
                      <td colSpan={5} className="pb-2">{describeEditor(p.name)}</td>
                    </tr>
                  ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}

      <Section
        title="Speed profiles"
        note="Upload and download limits held on the OLT, for companies that set speed there. Pick them when authorizing, or per ONU under Speed. A profile still used by ONUs cannot be removed."
      >
        {(['down', 'up'] as const).map((dir) => {
          const list = speeds.filter((p) => p.direction === dir)
          return (
            <div key={dir} className="mb-3">
              <p className="mb-1 text-[11px] font-semibold text-gray-400">{dir === 'down' ? 'Download' : 'Upload'}</p>
              {list.length ? (
                <ul className="flex flex-wrap gap-1.5">
                  {list.map((p) => (
                    <li key={p.name} className="inline-flex items-center gap-1.5 rounded-full bg-gray-800 px-2.5 py-0.5 text-[11px] text-gray-200">
                      <span className="font-semibold">{p.name}</span>
                      <span className="text-gray-400">
                        {p.kbps ? (p.kbps >= 1024 ? Math.round(p.kbps / 102.4) / 10 + ' Mbps' : p.kbps + ' kbps') : p.raw}
                      </span>
                      {p.name !== 'ISPMAN-UP' ? (
                        <button
                          type="button"
                          aria-label={'Remove profile ' + p.name}
                          onClick={() => void preview({ kind: 'speed-remove', direction: dir, name: p.name }, 'sr' + dir + p.name)}
                          disabled={!!busy}
                          className="text-gray-500 hover:text-red-300"
                        >
                          ×
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[11px] text-gray-500">None yet.</p>
              )}
            </div>
          )
        })}
        <div className="flex flex-wrap items-center gap-2">
          <select value={speedDir} onChange={(e) => setSpeedDir(e.target.value === 'up' ? 'up' : 'down')} className={field}>
            <option value="down">Download</option>
            <option value="up">Upload</option>
          </select>
          <input
            value={speedName}
            onChange={(e) => setSpeedName(e.target.value.replace(/\s+/g, '-'))}
            placeholder="Name, e.g. 20M-DOWN"
            maxLength={32}
            className={field + ' w-44'}
          />
          <input
            type="number"
            min={1}
            max={10000}
            value={speedMbps}
            onChange={(e) => setSpeedMbps(e.target.value)}
            placeholder="Mbps"
            className={field + ' w-24'}
          />
          <button
            type="button"
            onClick={() => void preview({ kind: 'speed-add', direction: speedDir, name: speedName, mbps: Number(speedMbps) }, 'sa')}
            disabled={!!busy || !speedName.trim() || !(Number(speedMbps) > 0)}
            className={primary}
          >
            {busy === 'sa' ? 'Checking…' : 'Create profile'}
          </button>
        </div>
      </Section>


      <SignalLevelsSection oltId={oltId} ports={pons.map((p) => p.name)} levels={signalLevels} />

      <SavedSetups profiles={speeds} vlans={vlans.map((v) => v.id).filter((v) => v !== 1)} />

      <Section title="Changes made from ISPMan" note="Newest first. Undo sends the commands that put a change back, worked out when it was made.">
        {changes.length === 0 ? (
          <p className="text-xs text-gray-500">None yet.</p>
        ) : (
          <ul className="divide-y divide-gray-800">
            {changes.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
                <span>
                  <span className={c.undone ? 'text-gray-500 line-through' : 'text-gray-100'}>{c.summary}</span>
                  <span className="block text-[11px] text-gray-500">
                    {new Date(c.madeAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
                    {c.madeBy ? ' · ' + c.madeBy : ''}
                    {c.undone ? ' · undone' : ''}
                  </span>
                </span>
                {!c.undone && !c.isUndo ? (
                  <button type="button" onClick={() => void undo(c)} disabled={!!busy} className={small}>
                    {busy === 'undo' + c.id ? 'Undoing…' : 'Undo'}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}
