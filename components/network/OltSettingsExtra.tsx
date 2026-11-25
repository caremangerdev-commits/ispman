'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'

import {
  deleteOnuSetup, listOnuSetups, loadOnuConfig, saveOnuAuto, saveOnuConfig, saveOnuSetup, saveSignalLevels, type SavedSetup,
} from '@/app/actions/olts'
import { SpeedPicker, setupWords } from '@/components/network/AuthoriseSetup'
import { Section, safe } from '@/components/network/OltSettings'
import { wifiNameFor, type OnuConfig, type OnuCustomer } from '@/lib/acs/config'
import type { OnuAuto } from '@/lib/data/olt-defaults'
import { DEFAULT_LEVELS, type SignalLevels } from '@/lib/olt/signal-levels'
import type { OltSpeedProfile } from '@/lib/olt/types'

/**
 * Two things each company decides for itself, kept in ISPMan rather than on
 * the OLT:
 *
 *   Signal levels — what counts as weak and too low, for the whole OLT and
 *   for any PON port that differs (a long run, an extra splitter). The ONU
 *   list colours by them and the low-signal alert fires by them.
 *
 *   Saved setups — named ways of setting an ONU up (tagged or untagged, the
 *   VLANs, the speed profiles), picked when authorizing or applied to many
 *   ONUs at once from the ONU list.
 */

const field =
  'rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-100 focus:border-blue-500 focus:outline-none'
const small = 'rounded-md bg-gray-800 px-2.5 py-1 text-[11px] font-medium text-gray-200 hover:bg-gray-700 disabled:opacity-50'
const primary = 'rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-60'
const portShort = (p: string) => p.replace(/^gpon-olt_/, 'PON ')

function Note({ note }: { note: { ok: boolean; text: string } | null }) {
  if (!note) return null
  return (
    <p className={'mt-2 rounded-md px-3 py-2 text-xs ' + (note.ok ? 'bg-emerald-950/40 text-emerald-300' : 'bg-red-950/40 text-red-300')}>
      {note.text}
    </p>
  )
}

export function SignalLevelsSection({
  oltId, ports, levels,
}: {
  oltId: number
  ports: string[]
  levels: SignalLevels | null
}) {
  const router = useRouter()
  const start = levels ?? DEFAULT_LEVELS
  const [warn, setWarn] = useState(String(start.warn))
  const [critical, setCritical] = useState(String(start.critical))
  const [own, setOwn] = useState<Record<string, { warn: string; critical: string }>>(
    Object.fromEntries(Object.entries(start.ports ?? {}).map(([p, l]) => [p, { warn: String(l.warn), critical: String(l.critical) }]))
  )
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  const save = async () => {
    setBusy(true)
    setNote(null)
    const res = await safe(() => saveSignalLevels(oltId, {
      warn: Number(warn),
      critical: Number(critical),
      ports: Object.fromEntries(
        Object.entries(own)
          .filter(([, l]) => l.warn !== '' && l.critical !== '')
          .map(([p, l]) => [p, { warn: Number(l.warn), critical: Number(l.critical) }])
      ),
    }))
    setBusy(false)
    setNote(res.ok ? { ok: true, text: res.message } : { ok: false, text: res.error })
    if (res.ok) router.refresh()
  }

  return (
    <Section
      title="Signal levels"
      note="What counts as weak and too low for the light an ONU receives, in dBm. The ONU list is coloured by these and the low-signal alert fires below 'too low'. Give a port its own levels when it normally runs lower."
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-gray-400">
        <label className="flex items-center gap-2">
          Weak below
          <input type="number" step="0.5" value={warn} onChange={(e) => setWarn(e.target.value)} className={field + ' w-20'} />
        </label>
        <label className="flex items-center gap-2">
          Too low below
          <input type="number" step="0.5" value={critical} onChange={(e) => setCritical(e.target.value)} className={field + ' w-20'} />
        </label>
      </div>
      {ports.length ? (
        <details className="mt-3">
          <summary className="cursor-pointer select-none text-[11px] text-gray-400 hover:text-gray-200">
            Ports with their own levels ({Object.values(own).filter((l) => l.warn !== '').length})
          </summary>
          <ul className="mt-2 space-y-1.5">
            {ports.map((p) => {
              const l = own[p] ?? { warn: '', critical: '' }
              return (
                <li key={p} className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
                  <span className="w-20 font-semibold text-gray-200">{portShort(p)}</span>
                  weak below
                  <input
                    type="number"
                    step="0.5"
                    value={l.warn}
                    placeholder={warn}
                    onChange={(e) => setOwn({ ...own, [p]: { ...l, warn: e.target.value } })}
                    className={field + ' w-20'}
                  />
                  too low below
                  <input
                    type="number"
                    step="0.5"
                    value={l.critical}
                    placeholder={critical}
                    onChange={(e) => setOwn({ ...own, [p]: { ...l, critical: e.target.value } })}
                    className={field + ' w-20'}
                  />
                </li>
              )
            })}
          </ul>
        </details>
      ) : null}
      <div className="mt-3">
        <button type="button" onClick={() => void save()} disabled={busy} className={primary}>
          {busy ? 'Saving…' : 'Save levels'}
        </button>
      </div>
      <Note note={note} />
    </Section>
  )
}

export function SavedSetups({ profiles, vlans }: { profiles: OltSpeedProfile[]; vlans: number[] }) {
  const [setups, setSetups] = useState<SavedSetup[]>([])
  const [name, setName] = useState('')
  const [tagged, setTagged] = useState(false)
  const [onuVlan, setOnuVlan] = useState('')
  const [vlan, setVlan] = useState(vlans[0] ? String(vlans[0]) : '')
  const [up, setUp] = useState('')
  const [down, setDown] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => setSetups(await listOnuSetups()), [])
  useEffect(() => {
    const t = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(t)
  }, [load])

  const save = async () => {
    setBusy(true)
    setNote(null)
    const v = Number(vlan)
    const res = await safe(() => saveOnuSetup(name, {
      onuVlan: tagged ? Number(onuVlan || vlan) : null,
      vlan: v,
      upProfile: up || null,
      downProfile: down || null,
    }))
    setBusy(false)
    setNote(res.ok ? { ok: true, text: res.message } : { ok: false, text: res.error })
    if (res.ok) {
      setName('')
      void load()
    }
  }

  return (
    <Section
      title="Saved ONU setups"
      note="Your own ways of setting ONUs up, by name, for every OLT: tagged or untagged, the VLANs, the speed. Pick one when authorizing, or apply one to many ONUs at once from the Authorized list."
    >
      {setups.length ? (
        <ul className="mb-3 divide-y divide-gray-800">
          {setups.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-xs">
              <span>
                <span className="font-semibold text-gray-100">{s.name}</span>{' '}
                <span className="text-gray-500">· {setupWords(s.setup)}</span>
              </span>
              <button
                type="button"
                onClick={async () => {
                  await deleteOnuSetup(s.id)
                  void load()
                }}
                className={small}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-3 text-xs text-gray-500">None yet.</p>
      )}
      <div className="space-y-2 rounded-lg border border-gray-800 p-3">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-gray-400">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. Home 20M" maxLength={60} className={field + ' w-48'} />
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={!tagged} onChange={() => setTagged(false)} /> Untagged
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={tagged} onChange={() => setTagged(true)} /> Tagged
          </label>
          {tagged ? (
            <label className="flex items-center gap-2">
              ONU tags with VLAN
              <input type="number" min={1} max={4094} value={onuVlan} placeholder={vlan} onChange={(e) => setOnuVlan(e.target.value)} className={field + ' w-20'} />
            </label>
          ) : null}
          <label className="flex items-center gap-2">
            Carried on VLAN
            <input type="number" min={1} max={4094} value={vlan} onChange={(e) => setVlan(e.target.value)} className={field + ' w-20'} />
          </label>
        </div>
        <SpeedPicker profiles={profiles} up={up} onUp={setUp} down={down} onDown={setDown} noneLabel="No limit on the OLT" />
        <button type="button" onClick={() => void save()} disabled={busy || !name.trim() || !(Number(vlan) >= 1)} className={primary}>
          {busy ? 'Saving…' : 'Save setup'}
        </button>
        <p className="text-[11px] text-gray-500">
          Speed profiles are named per OLT. A setup naming one that another OLT lacks is refused there, with the OLT&apos;s reason.
        </p>
      </div>
      <Note note={note} />
    </Section>
  )
}

/**
 * What new ONUs on this OLT get, chosen once: the same setup as the working
 * ONUs on their port, or one of the company's saved setups — for the whole
 * OLT, and differently on any port that needs it. Automatic authorizing uses
 * it, and the Authorize screen starts from it. Like SmartOLT's authorization
 * presets, matched by OLT and PON port.
 */
export function NewOnusPanel({
  oltId, auto, ports, autoSwitch,
}: {
  oltId: number
  auto: OnuAuto | null
  ports: string[]
  /** The "Authorize new ONUs automatically" switch, from the page. */
  autoSwitch: React.ReactNode
}) {
  const router = useRouter()
  const [setups, setSetups] = useState<SavedSetup[]>([])
  const [use, setUse] = useState<string>(String(auto?.use ?? 'learn'))
  const [perPort, setPerPort] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(auto?.ports ?? {}).map(([p, v]) => [p, String(v)]))
  )
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    let live = true
    const t = window.setTimeout(async () => {
      const list = await safe(async () => ({ ok: true as const, list: await listOnuSetups() }))
      if (live && list.ok) setSetups(list.list)
    }, 0)
    return () => {
      live = false
      window.clearTimeout(t)
    }
  }, [])

  const asValue = (v: string): 'learn' | number => (v === 'learn' ? 'learn' : Number(v))
  const save = async () => {
    setBusy(true)
    setNote(null)
    const res = await safe(() =>
      saveOnuAuto(oltId, {
        use: asValue(use),
        ports: Object.fromEntries(Object.entries(perPort).filter(([, v]) => v !== '').map(([p, v]) => [p, asValue(v)])),
      })
    )
    setBusy(false)
    setNote(res.ok ? { ok: true, text: res.message } : { ok: false, text: res.error })
    if (res.ok) router.refresh()
  }

  const options = (
    <>
      <option value="learn">Same as the working ONUs on their port</option>
      {setups.map((s) => (
        <option key={s.id} value={s.id}>{s.name} · {setupWords(s.setup)}</option>
      ))}
    </>
  )
  const select = 'rounded-lg border border-gray-700 bg-gray-950 px-3 py-1.5 text-sm text-gray-100'

  return (
    <Section
      title="New ONUs"
      note="How ONUs plugged into this OLT are let on and set up. Both automatic authorizing and the Authorize screen follow this."
    >
      <div className="space-y-5">
        {autoSwitch}
        <div>
          <label className="block text-sm font-medium text-gray-200" htmlFor={'onu-auto-' + oltId}>
            New ONUs get
          </label>
          <select id={'onu-auto-' + oltId} value={use} onChange={(e) => setUse(e.target.value)} className={select + ' mt-1.5 max-w-full'}>
            {options}
          </select>
          {setups.length === 0 ? (
            <p className="mt-1.5 text-xs text-gray-500">
              Save your usual setups (VLAN, tagged or not, speed) under Saved ONU setups to choose one here.
            </p>
          ) : null}
        </div>
        {ports.length > 1 ? (
          <details>
            <summary className="cursor-pointer select-none text-sm text-gray-400 hover:text-gray-200">
              Different on some PON ports ({Object.values(perPort).filter((v) => v !== '').length})
            </summary>
            <ul className="mt-3 space-y-2">
              {ports.map((p) => (
                <li key={p} className="flex flex-wrap items-center gap-3 text-sm">
                  <span className="w-24 font-medium text-gray-200">{p.replace(/^gpon-olt_\d+\//, 'PON ').replace(/^\d+\/\d+\//, 'PON ')}</span>
                  <select value={perPort[p] ?? ''} onChange={(e) => setPerPort({ ...perPort, [p]: e.target.value })} className={select}>
                    <option value="">Same as the OLT</option>
                    {options}
                  </select>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        <button type="button" onClick={() => void save()} disabled={busy} className={primary}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
      <Note note={note} />
    </Section>
  )
}

/**
 * Inside the ONU: the Wi-Fi name and password, and the internet login, set
 * through ISPMan's ACS (TR-069) for every customer's ONU of this company.
 * Company-wide, since a company names its customers' Wi-Fi the same way on
 * every OLT.
 */
export function OnuInsidePanel() {
  const [cfg, setCfg] = useState<OnuConfig | null>(null)
  const [acsUrl, setAcsUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    let live = true
    const t = window.setTimeout(async () => {
      const res = await safe(() => loadOnuConfig())
      if (!live) return
      if (res.ok) {
        setCfg(res.config)
        setAcsUrl(res.acsUrl)
      } else setNote({ ok: false, text: res.error })
    }, 0)
    return () => {
      live = false
      window.clearTimeout(t)
    }
  }, [])

  if (!cfg) return note ? <Note note={note} /> : null
  const set = (patch: Partial<OnuConfig>) => setCfg({ ...cfg, ...patch })
  const example: OnuCustomer = { first: 'Jane', last: 'Brown', account: '10452', phone: '876-555-0142', pppoeUser: null, pppoePass: null, pppoe: false }
  const exampleName = wifiNameFor(cfg.wifiName, example)

  const save = async () => {
    setBusy(true)
    setNote(null)
    const res = await safe(() => saveOnuConfig(cfg))
    setBusy(false)
    setNote(res.ok ? { ok: true, text: res.message } : { ok: false, text: res.error })
  }

  const select = 'rounded-lg border border-gray-700 bg-gray-950 px-3 py-1.5 text-sm text-gray-100'
  const input = select + ' w-56'

  return (
    <Section
      title="Inside the ONU: Wi-Fi and internet"
      note="ISPMan can set each customer's ONU itself, through its ACS (TR-069): the Wi-Fi name and password, and the PPPoE login for PPPoE customers. It applies to ONUs linked to a customer, the first time they check in and whenever the customer's details change."
    >
      <div className="space-y-5">
        <label className="flex items-center gap-2 text-sm font-medium text-gray-100">
          <input type="checkbox" checked={cfg.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          Set up customers&apos; ONUs from ISPMan
        </label>

        <fieldset disabled={!cfg.enabled} className="space-y-5 disabled:opacity-50">
          <div>
            <label className="block text-sm font-medium text-gray-200" htmlFor="wifi-name">Wi-Fi name</label>
            <input id="wifi-name" value={cfg.wifiName} onChange={(e) => set({ wifiName: e.target.value })} maxLength={60} className={input + ' mt-1.5'} />
            <p className="mt-1 text-xs text-gray-500">
              Use {'{first}'}, {'{last}'}, {'{name}'} or {'{account}'} for the customer&apos;s details. Leave empty to keep the ONU&apos;s own name.
              {exampleName ? <> For Jane Brown, account 10452: <span className="text-gray-300">{exampleName}</span></> : null}
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-200" htmlFor="wifi-pass">Wi-Fi password</label>
            <select id="wifi-pass" value={cfg.wifiPassword} onChange={(e) => set({ wifiPassword: e.target.value as OnuConfig['wifiPassword'] })} className={select + ' mt-1.5'}>
              <option value="leave">Leave it as it is</option>
              <option value="phone">The customer&apos;s phone number</option>
              <option value="account">The customer&apos;s account number</option>
              <option value="random">A new one for each customer (shown on the ONU)</option>
            </select>
            <p className="mt-1 text-xs text-gray-500">Wi-Fi passwords need at least 8 characters; a shorter number is not used.</p>
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-200">
            <input type="checkbox" checked={cfg.pppoe} onChange={(e) => set({ pppoe: e.target.checked })} />
            Put the customer&apos;s PPPoE login into the ONU (PPPoE customers only)
          </label>

          <div className="rounded-lg border border-gray-800 p-4">
            <p className="text-sm font-medium text-gray-200">How ONUs reach ISPMan&apos;s ACS</p>
            <label className="mt-2 flex flex-wrap items-center gap-2 text-sm text-gray-200">
              <input type="checkbox" checked={cfg.acs.zte} onChange={(e) => set({ acs: { ...cfg.acs, zte: e.target.checked } })} />
              On ZTE OLTs, set it on each ONU when it is authorized, using VLAN
              <input
                type="number"
                min={1}
                max={4094}
                value={cfg.acs.vlan ?? ''}
                onChange={(e) => set({ acs: { ...cfg.acs, vlan: Number(e.target.value) || null } })}
                className={select + ' w-24'}
              />
            </label>
            <p className="mt-2 text-xs leading-relaxed text-gray-500">
              The ONU takes an address by DHCP on that VLAN, so it must be able to reach the internet there. Other ONUs, and
              most Huawei ones, need this address set once on the ONU, or given by your DHCP server:{' '}
              <span className="font-mono text-gray-300">{acsUrl}</span>
            </p>
          </div>
        </fieldset>

        <button type="button" onClick={() => void save()} disabled={busy} className={primary}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
      <Note note={note} />
    </Section>
  )
}
