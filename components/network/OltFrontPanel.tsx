'use client'

import type { ReactNode } from 'react'

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
  // Copper is an RJ45 jack with its link and activity lights in the top
  // corners; fibre is an SFP cage with its light above, like the PON ports.
  const body =
    up.medium === 'copper' ? (
      <>
        <span aria-hidden="true" className="relative flex h-[22px] w-7 items-end justify-center rounded-[2px] bg-[#0b0d10] ring-1 ring-[#6b727c]">
          <span className={'absolute left-[2px] top-[2px] block h-[4px] w-[6px] rounded-[1px] ' + (light === 'on' ? 'bg-[#34d058] shadow-[0_0_4px_rgba(52,208,88,0.8)]' : light === 'down' ? 'bg-[#f04438]' : 'bg-[#3a3f46]')} />
          <span className={'absolute right-[2px] top-[2px] block h-[4px] w-[6px] rounded-[1px] ' + (light === 'on' ? 'bg-[#f5b83d]' : 'bg-[#3a3f46]')} />
          <span className="mb-[3px] block h-[7px] w-3.5 rounded-[1px] bg-[#1e2227] shadow-[inset_0_1px_1px_rgba(0,0,0,0.9)]" />
        </span>
        <span className="text-[9px] font-semibold leading-none text-[#d6dae0]">{(ten ? '10GE' : 'GE') + p.port}</span>
      </>
    ) : (
      <>
        <Led light={light} />
        <span
          aria-hidden="true"
          className="flex h-[18px] w-7 items-center justify-center rounded-[3px] bg-gradient-to-b from-[#c9ced5] to-[#7f868f] p-[2px] shadow-[inset_0_1px_0_rgba(255,255,255,0.5)]"
        >
          <span className="h-full w-full rounded-[2px] bg-[#0b0d10] shadow-[inset_0_2px_3px_rgba(0,0,0,0.9)]" />
        </span>
        <span className="text-[9px] font-semibold leading-none text-[#d6dae0]">{(ten ? '10GE' : 'GE') + p.port}</span>
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
  if (s === 'INSERVICE' || s === 'NORMAL' || s === 'ACTIVE' || s === 'ACTIVE_NORMAL' || s === 'STANDBY') return 'on'
  return 'down'
}

const STATUS_WORD: Record<string, string> = {
  INSERVICE: 'Working',
  STANDBY: 'Standby',
  OFFLINE: 'Not running',
  HWONLINE: 'Starting',
}
const statusWord = (s: string) => STATUS_WORD[s.toUpperCase()] ?? s.charAt(0) + s.slice(1).toLowerCase()

/* ---------------------------------------------------------------------------
   The metalwork. Plain shapes, shaded to read as a real box in a rack: a
   brushed-steel chassis, dark card faceplates with an ejector lever at each
   end, a vented fan tray, an RJ45 jack where a real card has its console.
   --------------------------------------------------------------------------- */

const STEEL = 'bg-[linear-gradient(180deg,#d9dde2_0%,#c3c8ce_45%,#aeb4bb_100%)]'
const PLATE = 'bg-[linear-gradient(180deg,#3a4048_0%,#2b3037_55%,#24282e_100%)]'

/** The lever at each end of a card that locks it into its slot. */
function Ejector({ side }: { side: 'left' | 'right' }) {
  return (
    <span
      aria-hidden="true"
      className={
        'flex w-3.5 shrink-0 flex-col items-center justify-center gap-1 bg-[linear-gradient(90deg,#1d2126,#30353c,#1d2126)] ' +
        (side === 'left' ? 'rounded-l-[3px] border-r border-black/50' : 'rounded-r-[3px] border-l border-black/50')
      }
    >
      <span className="block h-1.5 w-1.5 rounded-full bg-[radial-gradient(circle_at_35%_35%,#b8bec6,#5a6068)]" />
      <span className="block h-4 w-[3px] rounded-full bg-[#14171a]" />
    </span>
  )
}

/** A management or console socket: there on the real card, not something ISPMan reads. */
function Rj45({ label, what }: { label: string; what: string }) {
  return (
    <span title={label + ': ' + what} className="flex w-10 flex-col items-center gap-1 pt-1.5">
      <span aria-hidden="true" className="flex h-[22px] w-7 items-end justify-center rounded-[2px] bg-[#0b0d10] ring-1 ring-[#5d636c]">
        <span className="mb-[3px] block h-[7px] w-3.5 rounded-[1px] bg-[#1e2227] shadow-[inset_0_1px_1px_rgba(0,0,0,0.9)]" />
      </span>
      <span className="text-[8px] font-semibold leading-none tracking-wide text-[#8a919b]">{label}</span>
    </span>
  )
}

/** Silkscreen over a group of ports, with a bracket line: "UPLINK", "LOCAL". */
function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="flex flex-col items-stretch">
      <span aria-hidden="true" className="flex items-center gap-1 px-1 text-[7px] font-bold tracking-[0.14em] text-[#9aa1ab]">
        <span className="h-px flex-1 bg-[#6b727c]" />
        {label}
        <span className="h-px flex-1 bg-[#6b727c]" />
      </span>
      <span className="flex items-end">{children}</span>
    </span>
  )
}

/**
 * The sockets on a control card that are not uplinks. ZTE's SMXA has an
 * out-of-band management port, a console port and an environment-monitoring
 * port beside its uplinks; ISPMan does not read these, so they are drawn
 * unlit.
 */
function LocalPorts() {
  return (
    <Group label="LOCAL">
      <Rj45 label="CONSOLE" what="serial console, for setting up by cable" />
      <Rj45 label="MGMT" what="out-of-band management network" />
      <Rj45 label="ALARM" what="environment monitoring (door, temperature sensors)" />
    </Group>
  )
}

function FanTray({ light }: { light: Light }) {
  return (
    <div
      aria-hidden="true"
      className={'flex w-12 shrink-0 flex-col items-center justify-between rounded-[4px] border border-black/40 py-2 ' + PLATE}
    >
      <span className="text-[8px] font-bold tracking-wider text-[#a7adb5]">FAN</span>
      <span className="block w-8 flex-1 my-2 rounded-[2px] bg-[repeating-linear-gradient(180deg,#0d0f12_0px,#0d0f12_3px,#3a4048_3px,#3a4048_6px)] shadow-[inset_0_0_4px_rgba(0,0,0,0.8)]" />
      <Led light={light} />
    </div>
  )
}

function PowerModule({ light }: { light: Light }) {
  return (
    <div
      aria-hidden="true"
      className={'flex w-12 shrink-0 flex-col items-center justify-between rounded-[4px] border border-black/40 py-2 ' + PLATE}
    >
      <span className="text-[8px] font-bold tracking-wider text-[#a7adb5]">PWR</span>
      <span className="flex flex-col items-center gap-1.5">
        <span className="flex h-6 w-7 items-center justify-center rounded-[3px] bg-[#0f1114] ring-1 ring-[#5d636c]">
          <span className="flex gap-[3px]">
            <span className="block h-2 w-[3px] rounded-sm bg-[#8d949e]" />
            <span className="block h-2 w-[3px] rounded-sm bg-[#8d949e]" />
            <span className="block h-2 w-[3px] rounded-sm bg-[#8d949e]" />
          </span>
        </span>
        <span className="block h-1.5 w-1.5 rounded-full bg-[radial-gradient(circle_at_35%_35%,#b8bec6,#5a6068)]" />
      </span>
      <Led light={light} />
    </div>
  )
}

/** One card in its slot: ejectors at both ends, its name silkscreened at the left, its ports along it. */
function CardFace({
  name, slot, status, light, pons, uplinks, jacks = false, selected, onPick, onUplinks, empty, className = '',
}: {
  name: string
  slot: number | null
  status: string | null
  light: Light | null
  pons: PanelPon[]
  uplinks: OltUplink[]
  /** Draw the console and management sockets a control card has. */
  jacks?: boolean
  selected: string | null
  onPick: (p: PanelPon) => void
  onUplinks?: () => void
  empty?: string
  className?: string
}) {
  const said = (slot != null ? 'Slot ' + slot + ', ' : '') + name + (status ? ', ' + status.toLowerCase() : '')
  const active = status === 'Working'
  return (
    <div
      title={said}
      className={'flex min-h-[70px] items-stretch rounded-[4px] border border-black/60 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_1px_0_rgba(255,255,255,0.4)] ' + PLATE + ' ' + className}
    >
      <Ejector side="left" />
      <div className="flex w-[88px] shrink-0 flex-col justify-center gap-1 px-2">
        <span className="truncate text-[11px] font-bold tracking-wide text-[#eef0f2]">{name}</span>
        <span className="flex items-center gap-2 text-[8px] font-semibold tracking-wider text-[#8a919b]">
          {light ? (
            <>
              <span className="flex items-center gap-0.5"><Led light={light} />RUN</span>
              <span className="flex items-center gap-0.5"><Led light={light === 'down' ? 'down' : 'idle'} className="animate-none" />ALM</span>
              {jacks ? (
                <span className="flex items-center gap-0.5" title={active ? 'Active: this card is running the OLT' : 'Standby: takes over if the active card fails'}>
                  <Led light={active ? 'on' : 'idle'} />ACT
                </span>
              ) : null}
            </>
          ) : null}
        </span>
        {status ? <span className="truncate text-[9px] text-[#9aa1ab]">{(slot != null ? slot + ' · ' : '') + status}</span> : null}
      </div>
      <div className="flex flex-1 flex-wrap items-center gap-x-0.5 gap-y-1 border-l border-black/40 px-1.5 py-1">
        {pons.map((p) => (
          <PonCage key={p.name} pon={p} selected={selected === p.filter} onPick={onPick} />
        ))}
        {jacks ? (
          <>
            <LocalPorts />
            <span aria-hidden="true" className="mx-1.5 h-10 w-px self-center bg-black/40" />
            {uplinks.length ? (
              <Group label="UPLINK">
                {uplinks.map((u) => (
                  <UplinkCage key={u.name} up={u} onPick={onUplinks} />
                ))}
              </Group>
            ) : null}
          </>
        ) : (
          <>
            {pons.length && uplinks.length ? <span aria-hidden="true" className="mx-1.5 h-10 w-px bg-black/40" /> : null}
            {uplinks.map((u) => (
              <UplinkCage key={u.name} up={u} onPick={onUplinks} />
            ))}
          </>
        )}
        {!pons.length && !uplinks.length && !jacks ? (
          <span className="px-1 text-[10px] text-[#7d848e]">{empty ?? ''}</span>
        ) : null}
      </div>
      <Ejector side="right" />
    </div>
  )
}

/** A slot with no card in it: a plain blanking plate. */
function Blank({ slot, className = '' }: { slot: number; className?: string }) {
  return (
    <div
      title={'Slot ' + slot + ': empty'}
      className={'flex min-h-[70px] items-center justify-between rounded-[4px] border border-black/30 bg-[linear-gradient(180deg,#b9bec5,#a3a9b0)] px-3 ' + className}
    >
      <Screw />
      <span className="text-[10px] font-semibold text-[#5b616a]">Slot {slot} · empty</span>
      <Screw />
    </div>
  )
}

/** A rack ear, with the oval slots the rack screws go through. */
function Ear({ side }: { side: 'left' | 'right' }) {
  return (
    <div
      aria-hidden="true"
      className={
        'flex w-7 shrink-0 flex-col items-center justify-around py-3 ' + STEEL + ' ' +
        (side === 'left' ? 'rounded-l-[6px] border-r border-black/20' : 'rounded-r-[6px] border-l border-black/20')
      }
    >
      <span className="block h-3 w-2 rounded-full bg-[#2a2e34] shadow-[inset_0_1px_2px_rgba(0,0,0,0.8)]" />
      <span className="block h-3 w-2 rounded-full bg-[#2a2e34] shadow-[inset_0_1px_2px_rgba(0,0,0,0.8)]" />
    </div>
  )
}

/**
 * Where each slot sits on the front of a chassis ISPMan knows the shape of.
 * Anything else is drawn one card per row, which is how most carded OLTs
 * look from the front anyway. Need not be exact; it has to be recognisable.
 */
type Layout = { rows: number[][]; fan: boolean; power: boolean }
function layoutFor(brand: string, model: string | null): Layout | null {
  const m = (model ?? '').toUpperCase()
  // ZTE C320, 2U: the fan tray down the left, the two service cards across
  // the top, the two SMXA control cards side by side beneath them.
  if (brand === 'zte' && m.includes('C320')) return { rows: [[1], [2], [3, 4]], fan: true, power: true }
  return null
}

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
  const sys: Light = reachable === true ? 'on' : reachable === false ? 'down' : 'idle'
  const pwr: Light = reachable === null ? 'idle' : 'on'

  const face = (c: OltCard, className = '') => {
    const ups = uplinks.filter((u) => place(u.name).slot === c.slot)
    const ps = pons.filter((p) => p.slot === c.slot)
    const control = /^(SMX|SCX|SCU|MCU|H90|H80|SCUN|MPW)/i.test(c.actual ?? c.configured) || (!ps.length && ups.length > 0)
    return (
      <CardFace
        key={'c' + c.slot}
        name={c.actual ?? c.configured}
        slot={c.slot}
        status={statusWord(c.status)}
        light={cardLight(c)}
        pons={ps}
        uplinks={ups}
        jacks={control}
        selected={selected}
        onPick={pick}
        onUplinks={onUplinks}
        empty={c.status.toUpperCase() === 'OFFLINE' ? 'Card not running' : undefined}
        className={className}
      />
    )
  }

  const layout = cards.length ? layoutFor(brand, model) : null
  let body: ReactNode
  if (layout) {
    const bySlot = new Map(cards.map((c) => [c.slot, c]))
    const placed = new Set(layout.rows.flat())
    const extra = cards.filter((c) => !placed.has(c.slot))
    body = (
      <div className="flex flex-1 gap-1.5">
        {layout.fan ? <FanTray light={sys === 'down' ? 'idle' : pwr} /> : null}
        <div className="flex flex-1 flex-col gap-1.5">
          {layout.rows.map((row) => (
            <div key={row.join('-')} className="flex gap-1.5">
              {row.map((s) => {
                const c = bySlot.get(s)
                return c ? face(c, 'min-w-0 flex-1') : <Blank key={'b' + s} slot={s} className="min-w-0 flex-1" />
              })}
            </div>
          ))}
          {extra.map((c) => face(c))}
        </div>
        {layout.power ? <PowerModule light={pwr} /> : null}
      </div>
    )
  } else if (cards.length) {
    const used = new Set(cards.map((c) => c.slot))
    const strays = [...new Set([...pons.map((p) => p.slot), ...uplinks.map((u) => place(u.name).slot)])].filter(
      (s) => s == null || !used.has(s)
    )
    body = (
      <div className="flex flex-1 flex-col gap-1.5">
        {cards.map((c) => face(c))}
        {strays.map((s) => (
          <CardFace
            key={'s' + s}
            name={s == null ? 'Ports' : 'Slot ' + s}
            slot={null}
            status={null}
            light={null}
            pons={pons.filter((p) => p.slot === s)}
            uplinks={uplinks.filter((u) => place(u.name).slot === s)}
            selected={selected}
            onPick={pick}
            onUplinks={onUplinks}
          />
        ))}
      </div>
    )
  } else {
    // A pizza-box OLT (GCOM, C-Data, V-SOL): one fixed front with its PON
    // ports, its uplinks, and the console and management sockets.
    body = (
      <div className={'flex flex-1 items-stretch rounded-[4px] border border-black/60 ' + PLATE}>
        <div className="flex w-[88px] shrink-0 flex-col justify-center gap-1.5 border-r border-black/40 px-2.5">
          <span className="flex items-center gap-2 text-[8px] font-semibold tracking-wider text-[#8a919b]">
            <span className="flex items-center gap-0.5"><Led light={pwr} />PWR</span>
            <span className="flex items-center gap-0.5"><Led light={sys} />SYS</span>
          </span>
          <span className="text-[9px] text-[#9aa1ab]">{pons.length} PON ports</span>
        </div>
        <div className="flex flex-1 flex-wrap items-center gap-x-0.5 gap-y-1 px-1.5 py-1">
          {pons.map((p) => (
            <PonCage key={p.name} pon={p} selected={selected === p.filter} onPick={pick} />
          ))}
          {pons.length && uplinks.length ? <span aria-hidden="true" className="mx-1.5 h-10 w-px bg-black/40" /> : null}
          {uplinks.map((u) => (
            <UplinkCage key={u.name} up={u} onPick={onUplinks} />
          ))}
          {!pons.length && !uplinks.length ? <span className="px-1 text-[10px] text-[#7d848e]">No ports read yet</span> : null}
          <span className="ml-auto flex">
            <Rj45 label="MGMT" what="out-of-band management network" />
            <Rj45 label="CONSOLE" what="serial console, for setting up by cable" />
          </span>
        </div>
      </div>
    )
  }

  const slots = new Set(pons.map((p) => p.slot))
  const portLabel = (p: PanelPon) => (slots.size > 1 && p.slot != null ? p.slot + '/' + p.port : String(p.port))
  const live = pons.filter((p) => p.light === 'on').length
  const down = pons.filter((p) => p.light === 'down')

  return (
    <section aria-label="Front panel" className="space-y-2">
      <div className="overflow-x-auto pb-1">
        <div className="flex min-w-[640px] items-stretch rounded-[8px] shadow-[0_10px_24px_-10px_rgba(15,23,42,0.55)]">
          <Ear side="left" />
          <div className={'flex-1 space-y-1.5 border-y border-black/20 px-2 pb-2 pt-1.5 ' + STEEL}>
            <div className="flex items-center justify-between px-1">
              <span className="text-[11px] font-bold tracking-[0.12em] text-[#3b4048]">
                {(model ?? brand).toUpperCase()}
              </span>
              {layout ? (
                <span className="flex items-center gap-3 text-[8px] font-bold tracking-wider text-[#4d535b]">
                  <span className="flex items-center gap-1"><Led light={pwr} /> PWR</span>
                  <span
                    className="flex items-center gap-1"
                    title={reachable === false ? 'ISPMan could not reach it at the last check' : undefined}
                  >
                    <Led light={sys} /> SYS
                  </span>
                </span>
              ) : null}
            </div>
            {body}
          </div>
          <Ear side="right" />
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
