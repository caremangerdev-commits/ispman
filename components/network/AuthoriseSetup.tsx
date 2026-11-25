'use client'

import { useEffect, useState } from 'react'

import { learnPortSetup, onuCommand } from '@/app/actions/olts'
import type { LearnedSetup, OltAuthoriseResult, OltOnu, OltSpeedProfile, OnuServiceSetup } from '@/lib/olt/types'

/**
 * How new ONUs' traffic is carried, chosen before they are authorized, and
 * whether it actually flows afterwards.
 *
 * THE DEFAULT IS TO COPY. ISPMan reads the ONUs already working on the same
 * PON port and gives the new one the same setup, line for line: tagged or
 * untagged, which VLAN, which profile. A company that set its ONUs up by hand
 * at the command line gets new ones set up the same way without filling in
 * anything. The person sees what will be copied, and from where, before
 * pressing Authorize, and can choose untagged or tagged instead.
 *
 * THEN IT CHECKS. An ONU can be authorized and pass nothing — the classic
 * case being an ONU that tags its traffic on an OLT told to expect it
 * untagged. A minute and a half after authorizing, the list is read again; an
 * ONU that is online but has no address behind it is flagged, with a button
 * that flips tagged and untagged on that ONU alone.
 */

export type SetupMode = 'learn' | 'untagged' | 'tagged'

const portName = (p: string) => 'PON ' + (p.split(/[^0-9]+/).filter(Boolean).slice(-2).join('/') || p)

export function setupWords(s: OnuServiceSetup): string {
  const vlan =
    s.onuVlan == null
      ? 'untagged, on VLAN ' + s.vlan
      : 'tagged VLAN ' + s.onuVlan + (s.onuVlan === s.vlan ? '' : ', carried on VLAN ' + s.vlan)
  const up = s.upProfile && s.upProfile !== 'ISPMAN-UP' ? 'upload ' + s.upProfile : ''
  const down = s.downProfile ? 'download ' + s.downProfile : ''
  return [vlan, up, down].filter(Boolean).join(', ')
}

type PortReading = { state: 'reading' } | { state: 'done'; learned: LearnedSetup | null } | { state: 'error'; error: string }

/** What each port's working ONUs look like, read once per port shown. */
function PortSetups({ oltId, ports, vlan }: { oltId: number; ports: string[]; vlan: number | null }) {
  const [readings, setReadings] = useState<Record<string, PortReading>>({})
  const key = ports.join(',')

  useEffect(() => {
    let live = true
    const t = window.setTimeout(async () => {
      for (const p of key.split(',').filter(Boolean)) {
        if (!live) return
        setReadings((r) => (r[p] ? r : { ...r, [p]: { state: 'reading' } }))
        const res = await learnPortSetup(oltId, p)
        if (!live) return
        setReadings((r) => ({
          ...r,
          [p]: res.ok ? { state: 'done', learned: res.learned } : { state: 'error', error: res.error },
        }))
      }
    }, 0)
    return () => {
      live = false
      window.clearTimeout(t)
    }
  }, [oltId, key])

  return (
    <ul className="mt-2 space-y-1.5">
      {ports.map((p) => {
        const r = readings[p]
        return (
          <li key={p} className="text-xs">
            <span className="font-semibold text-gray-200">{portName(p)}: </span>
            {!r || r.state === 'reading' ? (
              <span className="text-gray-500">reading the ONUs already working there…</span>
            ) : r.state === 'error' ? (
              <span className="text-red-300">{r.error}</span>
            ) : r.learned ? (
              <>
                <span className="text-gray-100">{setupWords(r.learned)}</span>
                <span className="text-gray-500">
                  {' '}· as on {r.learned.agreeing} of the {r.learned.read} working ONUs read, copied from{' '}
                  <span className="font-mono">{r.learned.from.replace('gpon-onu_', '')}</span>
                </span>
                {r.learned.lines?.length ? (
                  <details className="mt-1">
                    <summary className="cursor-pointer select-none text-[11px] text-gray-500 hover:text-gray-300">
                      What the new ONU will be given
                    </summary>
                    <pre className="mt-1 overflow-x-auto rounded-md bg-gray-950 px-2 py-1.5 text-[11px] leading-relaxed text-gray-300">
                      {r.learned.lines.join('\n')}
                    </pre>
                  </details>
                ) : null}
              </>
            ) : (
              <span className="text-gray-500">
                nothing working there yet to copy, so {vlan ? setupWords({ onuVlan: null, vlan }) : 'untagged on the VLAN you choose'}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export function SetupChooser({
  oltId, canLearn, ports, mode, onMode, vlan, onVlan, vlans,
  onuVlan, onOnuVlan, profiles, upProfile, onUpProfile, downProfile, onDownProfile,
}: {
  oltId: number
  /** The OLT's driver can read existing ONUs' setup (ZTE). */
  canLearn: boolean
  /** The PON ports with ONUs waiting, to say what each will get. */
  ports: string[]
  mode: SetupMode
  onMode: (m: SetupMode) => void
  vlan: number | null
  onVlan: (v: number | null) => void
  vlans: number[]
  /** Tagged: the VLAN the ONU tags with. Null: the same as `vlan`. */
  onuVlan: number | null
  onOnuVlan: (v: number | null) => void
  /** Speed profiles on the OLT. */
  profiles: OltSpeedProfile[]
  upProfile: string
  onUpProfile: (p: string) => void
  downProfile: string
  onDownProfile: (p: string) => void
}) {
  const options: { id: SetupMode; label: string; note: string }[] = [
    ...(canLearn
      ? [{ id: 'learn' as const, label: 'Same as the working ONUs on that port', note: 'Recommended' }]
      : []),
    { id: 'untagged', label: 'Untagged', note: 'VLAN switched off on the ONU' },
    { id: 'tagged', label: 'Tagged', note: 'The ONU puts the VLAN on its traffic itself' },
  ]
  const vlanField = vlans.length ? (
    <select
      value={vlan ?? ''}
      onChange={(e) => onVlan(Number(e.target.value) || null)}
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
      onChange={(e) => onVlan(Number(e.target.value) || null)}
      className="w-20 rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-100"
    />
  )

  // Tagged or untagged can only be chosen where ISPMan can set it (ZTE so
  // far). Elsewhere the ONUs go on as before, untagged on the VLAN chosen.
  if (!canLearn) {
    return (
      <label className="mb-3 flex items-center gap-2 text-xs text-gray-400">
        Put them on VLAN {vlanField}
      </label>
    )
  }

  return (
    <fieldset className="mb-3 rounded-lg border border-gray-800 p-3">
      <legend className="px-1 text-xs font-semibold text-gray-200">How new ONUs are set up</legend>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {options.map((o) => (
          <label key={o.id} className="flex cursor-pointer items-start gap-2 text-xs">
            <input
              type="radio"
              name={'setup-' + oltId}
              checked={mode === o.id}
              onChange={() => onMode(o.id)}
              className="mt-0.5"
            />
            <span>
              <span className="block text-gray-100">{o.label}</span>
              <span className="block text-[11px] text-gray-500">{o.note}</span>
            </span>
          </label>
        ))}
      </div>
      {mode === 'tagged' ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-gray-400">
          <label className="flex items-center gap-2">
            VLAN the ONUs tag with
            <input
              type="number"
              min={1}
              max={4094}
              value={onuVlan ?? vlan ?? ''}
              onChange={(e) => onOnuVlan(Number(e.target.value) || null)}
              className="w-20 rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-100"
            />
          </label>
          <label className="flex items-center gap-2">
            Carried to the uplink on VLAN {vlanField}
          </label>
          <span className="w-full text-[11px] text-gray-500">
            The same number for both is the usual case. Different numbers make the OLT translate one into the other.
          </span>
        </div>
      ) : (
        <label className="mt-3 flex flex-wrap items-center gap-2 text-xs text-gray-400">
          {mode === 'untagged' ? 'Carry them on VLAN' : 'Where there is nothing to copy, carry them untagged on VLAN'}
          {vlanField}
        </label>
      )}
      {mode !== 'learn' ? (
        <SpeedPicker
          profiles={profiles}
          up={upProfile}
          onUp={onUpProfile}
          down={downProfile}
          onDown={onDownProfile}
          noneLabel="No limit on the OLT"
        />
      ) : null}
      {mode === 'learn' && ports.length ? <PortSetups oltId={oltId} ports={ports} vlan={vlan} /> : null}
    </fieldset>
  )
}

const speedWords = (p: OltSpeedProfile) =>
  p.name + (p.kbps ? ' · ' + (p.kbps >= 1024 ? Math.round(p.kbps / 102.4) / 10 + ' Mbps' : p.kbps + ' kbps') : '')

/**
 * Upload and download speed from the OLT's own profiles. A company that
 * limits speed on its router picks "No limit on the OLT"; one that limits on
 * the OLT picks the profile. Both are normal.
 */
export function SpeedPicker({
  profiles, up, onUp, down, onDown, noneLabel, keepLabel,
}: {
  profiles: OltSpeedProfile[]
  up: string
  onUp: (p: string) => void
  down: string
  onDown: (p: string) => void
  noneLabel: string
  /** When set, an option to leave that direction as it is (value "keep"). */
  keepLabel?: string
}) {
  const ups = profiles.filter((p) => p.direction === 'up')
  const downs = profiles.filter((p) => p.direction === 'down')
  const select = 'rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-100'
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-gray-400">
      <label className="flex items-center gap-2">
        Upload speed
        <select value={up} onChange={(e) => onUp(e.target.value)} className={select}>
          {keepLabel ? <option value="keep">{keepLabel}</option> : null}
          <option value="">{noneLabel}</option>
          {ups.map((p) => (
            <option key={p.name} value={p.name}>{speedWords(p)}</option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2">
        Download speed
        <select value={down} onChange={(e) => onDown(e.target.value)} className={select}>
          {keepLabel ? <option value="keep">{keepLabel}</option> : null}
          <option value="">{noneLabel}</option>
          {downs.map((p) => (
            <option key={p.name} value={p.name}>{speedWords(p)}</option>
          ))}
        </select>
      </label>
      {!ups.length && !downs.length ? (
        <span className="text-[11px] text-gray-500">This OLT has no speed profiles yet. Create them under Settings.</span>
      ) : null}
    </div>
  )
}

/**
 * After authorizing: is data actually passing? An address behind the ONU is
 * the proof — the customer's router has spoken through it.
 */
export function DataCheck({
  oltId, done, onus, checking, onCheck,
}: {
  oltId: number
  done: OltAuthoriseResult[]
  /** The ONU list as last read. */
  onus: OltOnu[]
  checking: boolean
  onCheck: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<string, { ok: boolean; text: string }>>({})

  const flip = async (r: OltAuthoriseResult) => {
    if (!r.id || !r.setup) return
    const next: OnuServiceSetup =
      r.setup.onuVlan == null ? { onuVlan: r.setup.vlan, vlan: r.setup.vlan } : { onuVlan: null, vlan: r.setup.vlan }
    setBusy(r.id)
    const res = await onuCommand({ oltId, onuId: r.id, action: { kind: 'service', setup: next } })
    setBusy(null)
    setNotes((n) => ({ ...n, [r.id as string]: res.ok ? { ok: true, text: res.message } : { ok: false, text: res.error } }))
    if (res.ok) window.setTimeout(onCheck, 60_000)
  }

  return (
    <div className="mb-3 rounded-lg border border-gray-800 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-gray-200">Is data passing?</p>
        <button type="button" onClick={onCheck} disabled={checking} className="text-[11px] text-blue-400 hover:underline disabled:opacity-50">
          {checking ? 'Checking…' : 'Check now'}
        </button>
      </div>
      <ul className="mt-1.5 space-y-1.5">
        {done.map((r) => {
          const onu = onus.find((o) => o.id === r.id)
          const passing = !!onu && (onu.macs?.length ?? 0) > 0
          const state = !onu
            ? { tone: 'text-gray-500', text: 'Not in the list yet' }
            : !onu.online
              ? { tone: 'text-amber-300', text: 'Not online yet' }
              : passing
                ? { tone: 'text-emerald-300', text: 'Data is passing: ' + (onu.macs ?? [])[0] + ' behind it' }
                : { tone: 'text-red-300', text: 'Online, but nothing is passing through it' }
          const note = r.id ? notes[r.id] : undefined
          return (
            <li key={r.sn} className="text-xs">
              <span className="font-mono text-gray-300">{r.sn}</span>{' '}
              <span className="text-gray-500">({r.setup ? setupWords(r.setup) : 'set up'})</span>{' '}
              <span className={state.tone}>· {state.text}</span>
              {onu?.online && !passing && r.setup && r.id ? (
                <span className="mt-1 block text-[11px] text-gray-400">
                  The usual cause is a tagged ONU set up as untagged, or the other way round.{' '}
                  <button
                    type="button"
                    onClick={() => void flip(r)}
                    disabled={busy === r.id}
                    className="font-semibold text-blue-400 hover:underline disabled:opacity-50"
                  >
                    {busy === r.id ? 'Changing…' : r.setup.onuVlan == null ? 'Switch it to tagged VLAN ' + r.setup.vlan : 'Switch it to untagged'}
                  </button>
                </span>
              ) : null}
              {note ? <span className={'mt-1 block text-[11px] ' + (note.ok ? 'text-emerald-300' : 'text-red-300')}>{note.text}</span> : null}
            </li>
          )
        })}
      </ul>
      <p className="mt-2 text-[11px] text-gray-500">
        Checked a minute and a half after authorizing. An ONU with nobody&apos;s router plugged in yet will show nothing passing.
      </p>
    </div>
  )
}
