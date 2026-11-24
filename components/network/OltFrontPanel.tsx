'use client'

import type { OltCard, OltInfo, OltOnu, OltPonPort, OltUplink } from '@/lib/olt/types'

/**
 * The OLT drawn as it looks in the rack: its cards in their slots, every PON
 * and uplink port lit by what is happening on it now.
 *
 * WHY A DRAWING AND NOT A TABLE. Someone standing at the rack, or on the phone
 * to someone who is, thinks "the third port on the top card", not
 * "gpon-olt_1/1/3". A port lit red among green ones is found in a glance.
 *
 * Built from what the OLT reports — cards, PON ports, uplinks — so it fits
 * whatever make and size is behind it. An OLT that lists no cards (GCOM,
 * C-Data, V-SOL boxes) is one faceplate with its ports.
 *
 * The chassis keeps its own metal colours on purpose: it is a picture of a
 * physical thing, so it does not follow the page's light or dark palette.
 */

type Light = 'on' | 'down' | 'idle'

const nums = (name: string) => name.split(/[^0-9]+/).filter(Boolean).map(Number)
/** Slot and port from any make's port name: gpon-olt_1/2/3, 0/1/3, 0/0/3, 0/3, gei_1/3/1. */
function place(name: string): { slot: number | null; port: number } {
  const n = nums(name)
  if (n.length === 0) return { slot: null, port: 0 }
  return { slot: n.length >= 3 ? n[n.length - 2] : null, port: n[n.length - 1] }
}
const keyOf = (name: string) => {
  const p = place(name)
  return (p.slot ?? '') + '/' + p.port
}

export type PanelPon = {
  name: string
  /** The port as the ONU list names it, which is what the filter takes. */
  filter: string
  slot: number | null
  port: number
  total: number
  online: number
  light: Light
  off: boolean
}

function ponPorts(info: OltInfo | null, onus: OltOnu[] | null): PanelPon[] {
  const listed = info?.ponPorts ?? []
  const byKey = new Map<string, { filter: string; total: number; online: number }>()
  for (const o of onus ?? []) {
    const k = keyOf(o.port)
    const e = byKey.get(k) ?? { filter: o.port, total: 0, online: 0 }
    e.total += 1
    if (o.online) e.online += 1
    byKey.set(k, e)
  }
  const out: PanelPon[] = listed.map((p: OltPonPort) => {
    const k = keyOf(p.name)
    const seen = byKey.get(k)
    byKey.delete(k)
    const total = onus ? seen?.total ?? 0 : p.registered ?? 0
    // Without a live list, a port the OLT reports as up with ONUs on it is
    // counted as working; the live list replaces this within seconds.
    const online = onus ? seen?.online ?? 0 : p.up ? total : 0
    const light: Light = !p.enabled || total === 0 ? 'idle' : online > 0 ? 'on' : 'down'
    return { name: p.name, filter: seen?.filter ?? p.name, ...place(p.name), total, online, light, off: !p.enabled }
  })
  // ONUs on a port the OLT's port list missed still get a port drawn.
  for (const [, e] of byKey) {
    out.push({
      name: e.filter, filter: e.filter, ...place(e.filter), total: e.total, online: e.online,
      light: e.online > 0 ? 'on' : 'down', off: false,
    })
  }
  return out.sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0) || a.port - b.port)
}

const LED: Record<Light, string> = {
  on: 'bg-[#34d058] shadow-[0_0_6px_1px_rgba(52,208,88,0.75)]',
  down: 'bg-[#f04438] shadow-[0_0_6px_1px_rgba(240,68,56,0.8)] animate-pulse motion-reduce:animate-none',
  idle: 'bg-[#4a5059]',
}

function Led({ light, className = '' }: { light: Light; className?: string }) {
  return <span aria-hidden="true" className={'block h-1.5 w-1.5 rounded-full ' + LED[light] + ' ' + className} />
}

function Screw() {
  return (
    <span
      aria-hidden="true"
      className="block h-2.5 w-2.5 rounded-full bg-[radial-gradient(circle_at_35%_35%,#9aa1ab,#50565f)] ring-1 ring-black/40"
    />
  )
}

/** One SFP cage, with the port's light above it and its number and ONU count below. */
function PonCage({ pon, selected, onPick }: { pon: PanelPon; selected: boolean; onPick: (p: PanelPon) => void }) {
  const said =
    'PON ' + pon.port + (pon.slot != null ? ' on slot ' + pon.slot : '') + ': ' +
    (pon.off ? 'switched off' : pon.total === 0 ? 'no ONUs' : pon.online + ' of ' + pon.total + ' ONUs online')
  return (
    <button
      type="button"
      onClick={() => onPick(pon)}
      title={said}
      aria-label={said + '. Show its ONUs.'}
      aria-pressed={selected}
      className={
        'group flex w-9 flex-col items-center gap-1 rounded-md px-0.5 pb-1 pt-1.5 outline-none transition ' +
        'focus-visible:ring-2 focus-visible:ring-[#60a5fa] ' +
        (selected ? 'bg-[#3b82f6]/25 ring-1 ring-[#60a5fa]' : 'hover:bg-white/5')
      }
    >
      <Led light={pon.light} />
      <span
        aria-hidden="true"
        className="flex h-[18px] w-7 items-center justify-center rounded-[3px] bg-gradient-to-b from-[#8d949e] to-[#5d636c] p-[2px] shadow-[inset_0_1px_0_rgba(255,255,255,0.35)]"
      >
        <span className="h-full w-full rounded-[2px] bg-[#0b0d10] shadow-[inset_0_2px_3px_rgba(0,0,0,0.9)]" />
      </span>
      <span className="text-[10px] font-semibold leading-none text-[#d6dae0]">{pon.port}</span>
      <span
        className={
          'text-[9px] leading-none tabular-nums ' +
          (pon.light === 'down' ? 'text-[#ff8a80]' : pon.light === 'on' ? 'text-[#9ee6ae]' : 'text-[#6b727c]')
        }
      >
        {pon.off ? 'off' : pon.total ? pon.online + '/' + pon.total : '—'}
      </span>
    </button>
  )
}

function UplinkCage({ up, onPick }: { up: OltUplink; onPick?: () => void }) {
  const light: Light = !up.enabled ? 'idle' : up.up ? 'on' : 'down'
  const p = place(up.name)
  const ten = /^x/i.test(up.name)
  const said = (ten ? '10G uplink ' : 'Uplink ') + p.port + ': ' + (!up.enabled ? 'switched off' : up.up ? 'link up' : 'no link') +
    (up.description ? ' (' + up.description + ')' : '')
  const body = (
    <>
      <Led light={light} />
      <span
        aria-hidden="true"
        className={
          'flex h-[18px] items-center justify-center rounded-[3px] p-[2px] ' +
          (up.medium === 'copper'
            ? 'w-6 bg-[#1a1d21] ring-1 ring-[#5d636c]'
            : 'w-7 bg-gradient-to-b from-[#c9a646] to-[#8a6d22] shadow-[inset_0_1px_0_rgba(255,255,255,0.35)]')
        }
      >
        <span className="h-full w-full rounded-[2px] bg-[#0b0d10] shadow-[inset_0_2px_3px_rgba(0,0,0,0.9)]" />
      </span>
      <span className="text-[10px] font-semibold leading-none text-[#d6dae0]">{(ten ? 'X' : 'G') + p.port}</span>
    </>
  )
  return onPick ? (
    <button
      type="button"
      onClick={onPick}
      title={said}
      aria-label={said + '. Show uplinks.'}
      className="flex w-9 flex-col items-center gap-1 rounded-md px-0.5 pb-1 pt-1.5 outline-none hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-[#60a5fa]"
    >
      {body}
    </button>
  ) : (
    <span title={said} className="flex w-9 flex-col items-center gap-1 px-0.5 pb-1 pt-1.5">
      {body}
    </span>
  )
}

function cardLight(c: OltCard): Light {
  const s = c.status.toUpperCase()
  if (s === 'INSERVICE' || s === 'NORMAL' || s === 'ACTIVE' || s === 'ACTIVE_NORMAL') return 'on'
  if (s === 'STANDBY') return 'on'
  return 'down'
}

/** One card's faceplate: its name and state at the left, its ports along it. */
function Faceplate({
  label, sub, light, pons, uplinks, selected, onPick, onUplinks, empty,
}: {
  label: string
  sub: string | null
  light: Light | null
  pons: PanelPon[]
  uplinks: OltUplink[]
  selected: string | null
  onPick: (p: PanelPon) => void
  onUplinks?: () => void
  empty?: string
}) {
  return (
    <div className="flex min-h-[64px] items-stretch rounded-[5px] border border-black/50 bg-gradient-to-b from-[#2a2f36] to-[#22262c] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
      <div className="flex w-28 shrink-0 flex-col justify-center gap-1 border-r border-black/40 px-3">
        <span className="flex items-center gap-1.5">
          {light ? <Led light={light} /> : null}
          <span className="truncate text-[11px] font-semibold tracking-wide text-[#e4e7eb]">{label}</span>
        </span>
        {sub ? <span className="truncate text-[10px] text-[#8a919b]">{sub}</span> : null}
      </div>
      <div className="flex flex-1 flex-wrap items-center gap-x-0.5 gap-y-1 px-2 py-1">
        {pons.map((p) => (
          <PonCage key={p.name} pon={p} selected={selected === p.filter} onPick={onPick} />
        ))}
        {pons.length && uplinks.length ? <span aria-hidden="true" className="mx-2 h-10 w-px bg-black/40" /> : null}
        {uplinks.map((u) => (
          <UplinkCage key={u.name} up={u} onPick={onUplinks} />
        ))}
        {!pons.length && !uplinks.length ? (
          <span className="px-1 text-[10px] text-[#6b727c]">{empty ?? ''}</span>
        ) : null}
      </div>
    </div>
  )
}

const STATUS_WORD: Record<string, string> = {
  INSERVICE: 'Working',
  STANDBY: 'Standby',
  OFFLINE: 'Not running',
  HWONLINE: 'Starting',
}
const statusWord = (s: string) => STATUS_WORD[s.toUpperCase()] ?? s.charAt(0) + s.slice(1).toLowerCase()

export function OltFrontPanel({
  model, brand, reachable, info, onus, selected, onPickPort, onUplinks,
}: {
  model: string | null
  brand: string
  /** The last reading reached the OLT. */
  reachable: boolean | null
  info: OltInfo | null
  /** The live ONU list when there is one, else the saved one, else null. */
  onus: OltOnu[] | null
  /** The port whose ONUs are being shown, as the filter names it. */
  selected: string | null
  onPickPort: (filter: string) => void
  onUplinks?: () => void
}) {
  const pons = ponPorts(info, onus)
  const uplinks = info?.uplinks ?? []
  const cards = [...(info?.cards ?? [])].sort((a, b) => a.slot - b.slot)
  const pick = (p: PanelPon) => onPickPort(selected === p.filter ? '' : p.filter)

  // Every port lands on a card when the OLT lists cards; anything left over
  // (a port on a slot that did not report) gets a plate of its own.
  const rows: { key: string; label: string; sub: string | null; light: Light | null; pons: PanelPon[]; ups: OltUplink[]; empty?: string }[] = []
  if (cards.length) {
    const used = new Set<number>()
    for (const c of cards) {
      used.add(c.slot)
      rows.push({
        key: 'c' + c.slot,
        label: c.slot + ' · ' + (c.actual ?? c.configured),
        sub: statusWord(c.status),
        light: cardLight(c),
        pons: pons.filter((p) => p.slot === c.slot),
        ups: uplinks.filter((u) => place(u.name).slot === c.slot),
        empty: c.status.toUpperCase() === 'OFFLINE' ? 'Card not running' : 'Control and power',
      })
    }
    const strays = [...new Set([...pons.map((p) => p.slot), ...uplinks.map((u) => place(u.name).slot)])].filter(
      (s) => s == null || !used.has(s)
    )
    for (const s of strays) {
      rows.push({
        key: 's' + s,
        label: s == null ? 'Ports' : 'Slot ' + s,
        sub: null,
        light: null,
        pons: pons.filter((p) => p.slot === s),
        ups: uplinks.filter((u) => place(u.name).slot === s),
      })
    }
  } else {
    rows.push({ key: 'one', label: 'PON', sub: pons.length + ' ports', light: null, pons, ups: uplinks, empty: 'No ports read yet' })
  }

  const slots = new Set(pons.map((p) => p.slot))
  const portLabel = (p: PanelPon) => (slots.size > 1 && p.slot != null ? p.slot + '/' + p.port : String(p.port))
  const live = pons.filter((p) => p.light === 'on').length
  const down = pons.filter((p) => p.light === 'down')
  const sys: Light = reachable === true ? 'on' : reachable === false ? 'down' : 'idle'

  return (
    <section aria-label="Front panel" className="space-y-2">
      <div className="overflow-x-auto pb-1">
        <div className="flex min-w-[520px] items-stretch rounded-[10px] bg-gradient-to-b from-[#454b54] via-[#363b42] to-[#2c3036] p-1.5 shadow-[0_8px_20px_-8px_rgba(15,23,42,0.45),inset_0_1px_0_rgba(255,255,255,0.18)]">
          {/* Rack ear */}
          <div aria-hidden="true" className="flex w-6 shrink-0 flex-col items-center justify-between rounded-l-[6px] bg-[#2a2e34] py-3">
            <Screw />
            <Screw />
          </div>

          <div className="flex-1 space-y-1.5 px-2 py-1.5">
            <div className="flex items-center justify-between px-1">
              <span className="text-[11px] font-bold tracking-[0.08em] text-[#c3c8cf]">
                {(model ?? brand).toUpperCase()}
              </span>
              <span className="flex items-center gap-3 text-[9px] font-semibold tracking-wider text-[#8a919b]">
                <span className="flex items-center gap-1">
                  <Led light={reachable === null ? 'idle' : 'on'} /> PWR
                </span>
                <span className="flex items-center gap-1" title={reachable === false ? 'ISPMan could not reach it at the last check' : undefined}>
                  <Led light={sys} /> SYS
                </span>
              </span>
            </div>
            {rows.map((r) => (
              <Faceplate
                key={r.key}
                label={r.label}
                sub={r.sub}
                light={r.light}
                pons={r.pons}
                uplinks={r.ups}
                selected={selected}
                onPick={pick}
                onUplinks={onUplinks}
                empty={r.empty}
              />
            ))}
          </div>

          <div aria-hidden="true" className="flex w-6 shrink-0 flex-col items-center justify-between rounded-r-[6px] bg-[#2a2e34] py-3">
            <Screw />
            <Screw />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 text-[11px] text-gray-500">
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="flex items-center gap-1.5"><Led light="on" /> ONUs online</span>
          <span className="flex items-center gap-1.5"><Led light="down" className="animate-none" /> Has ONUs, none online</span>
          <span className="flex items-center gap-1.5"><Led light="idle" /> Not in use</span>
        </span>
        <span>
          {down.length
            ? down.length + (down.length === 1 ? ' port is' : ' ports are') + ' down: PON ' + down.map(portLabel).join(', ') + '. '
            : live
              ? 'Every port in use is up. '
              : ''}
          Press a port to see its ONUs.
        </span>
      </div>
    </section>
  )
}
