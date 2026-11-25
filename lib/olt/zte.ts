import 'server-only'

import { CliError, TelnetSession } from '@/lib/olt/telnet'
import type {
  OltAuthoriseResult, OltCard, OltDriver, OltInfo, OltLogin, OltOnu, OltOnuDetail, OltOnuLists,
  OltPendingOnu, LearnedSetup, OnuServiceSetup, OltChangePlan, OltConfigChange, OltSpeedProfile,
  OltPonPort, OltUplink, OltVlan,
} from '@/lib/olt/types'

/**
 * ZTE ZXA10 (C320, C300) over its command line.
 *
 * WRITTEN AGAINST A REAL C320 ON V2.1.0, not against a manual. The prompts,
 * the login sequence and every layout parsed below are what that unit printed
 * on 20 Nov 2026. Commands that unit rejected (`show temperature`,
 * `show interface brief`) are not used.
 *
 * COMMAND LINE ONLY, NO SNMP. Per-ONU readings on ZTE live in private SNMP
 * tables that move between firmware versions; the command line prints the same
 * figures in a layout that has been stable for a decade.
 *
 * THE PROMPT is the hostname followed by > (not yet privileged) or # (full
 * access), optionally with a mode in brackets: ZXAN>, ZXAN#, ZXAN(config)#.
 * The hostname is the owner's to change, so nothing here assumes "ZXAN".
 */

// The mode in brackets can contain a space — "ZXAN(gpon-onu-mng 1/1/1:1)#" —
// so it is matched on its own rather than as part of the hostname.
const PROMPT = /(?:^|[\r\n])[^\r\n (]{1,40}(?:\([^\r\n)]{1,60}\))?[>#] ?$/
const LOGIN_STEP = /(Username:|Password:|[>#] ?$)/i

/** More VLANs than this are listed by number only; each one is a command. */
const VLAN_DETAIL_LIMIT = 40

async function login(session: TelnetSession, creds: OltLogin): Promise<void> {
  await session.until(/Username:/i, 'waiting for the login prompt')
  session.send(creds.user)
  await session.until(/Password:/i, 'waiting for the password prompt')
  session.send(creds.password)

  // Either a prompt (in), or "Username:" again (refused).
  const after = await session.until(LOGIN_STEP, 'logging in')
  if (/Username:|Password:/i.test(after)) {
    throw new CliError('The OLT refused that username and password.')
  }

  // A prompt ending in > is logged in but not privileged: `enable` asks for a
  // second password. A user created with privilege 15 lands on # directly.
  if (/> ?$/.test(after)) {
    session.send('enable')
    const step = await session.until(/(Password:|[>#] ?$)/i, 'entering enable mode')
    if (/Password:/i.test(step)) {
      if (!creds.enablePassword) {
        throw new CliError(
          'This login needs the enable password as well. Add it to the OLT in ISPMan, or use a login with full privilege.'
        )
      }
      session.send(creds.enablePassword)
      const done = await session.until(/(Password:|[>#] ?$)/i, 'entering enable mode')
      if (!/# ?$/.test(done)) throw new CliError('The OLT refused the enable password.')
    }
  }
}

/** Runs one command and returns what it printed, without the echo or prompt. */
async function run(session: TelnetSession, command: string, waitMs?: number): Promise<string> {
  session.send(command)
  const raw = await session.until(PROMPT, 'running "' + command + '"', waitMs)
  const lines = raw.replace(/\r/g, '').split('\n')
  // First line is the echoed command, last is the prompt.
  return lines.slice(1, -1).join('\n')
}

/** The OLT's way of saying a command has nothing to show, or is not accepted. */
const refused = (text: string) => /%Error|%Code/.test(text)

/**
 * `show card`, one row per slot:
 *
 *   Rack Shelf Slot CfgType RealType Port  HardVer SoftVer   Status
 *   1    1     1    GTGO             8                       HWONLINE
 *   1    1     4    SMXA    SMXA     3     V1.0.0  V2.1.0    INSERVICE
 *
 * THE MIDDLE COLUMNS GO BLANK when a card is configured but not running, so
 * the row cannot be split by position alone. The first four fields and the
 * last are always there; what lies between is read by how many fields it has.
 */
function parseCards(text: string): OltCard[] {
  const cards: OltCard[] = []
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/)
    if (f.length < 6 || !/^\d+$/.test(f[0]) || !/^\d+$/.test(f[2])) continue
    const status = f[f.length - 1]
    const full = f.length >= 9
    cards.push({
      slot: Number(f[2]),
      configured: f[3],
      actual: full ? f[4] : null,
      ports: Number(full ? f[5] : f[4]) || null,
      hardware: full ? f[6] : null,
      software: full ? f[7] : null,
      status,
      cpu: null,
      memory: null,
    })
  }
  return cards
}

/**
 * `show processor`: CPU and memory for each card that has a processor.
 *
 *   Rack Shelf Slot CPU(5s) CPU(1m) CPU(5m) PhyMem(MB) Memory
 *   1    1     4    8%      14%     10%     1024       30%
 */
function addProcessors(cards: OltCard[], text: string): void {
  for (const line of text.split('\n')) {
    const m = /^\s*\d+\s+\d+\s+(\d+)\s+\d+%\s+(\d+)%\s+\d+%\s+\d+\s+(\d+)%/.exec(line)
    if (!m) continue
    const card = cards.find((c) => c.slot === Number(m[1]))
    if (card) {
      card.cpu = Number(m[2])
      card.memory = Number(m[3])
    }
  }
}

const rateOf = (text: string, which: 'input' | 'output'): number | null => {
  const m = new RegExp(which + '\\s+rate\\s*:\\s*(\\d+)\\s*Bps', 'i').exec(text)
  return m ? Number(m[1]) * 8 : null
}

const descriptionOf = (text: string): string | null => {
  const raw = /Description is (.*)$/im.exec(text)?.[1]?.trim().replace(/\.$/, '') ?? ''
  return raw && raw.toLowerCase() !== 'none' ? raw : null
}

/**
 * `show interface gei_1/4/3`, an uplink port. The first line carries both
 * answers that matter:
 *
 *   gei_1/4/3 is down,  line protocol is down                 enabled, no link
 *   gei_1/4/2 is administratively down,  line protocol is down     switched off
 */
function parseUplink(name: string, text: string): OltUplink {
  const first = text.split('\n')[0] ?? ''
  return {
    name,
    enabled: !/administratively down/i.test(first),
    up: /line protocol is up/i.test(first),
    medium: /The port is (electric|optical)/i.exec(text)?.[1]?.toLowerCase() === 'optical' ? 'fibre' : 'copper',
    duplex: /Duplex (\S+)/i.exec(text)?.[1] ?? null,
    description: descriptionOf(text),
    inBps: rateOf(text, 'input'),
    outBps: rateOf(text, 'output'),
  }
}

/**
 * `show interface gpon-olt_1/1/1`, a PON port:
 *
 *   gpon-olt_1/1/1 is activate,line protocol is down.
 *   The port has 128 onus, the number of registered onus is 0.
 */
function parsePonPort(name: string, text: string): OltPonPort {
  const first = text.split('\n')[0] ?? ''
  const onus = /has (\d+) onus, the number of registered onus is (\d+)/i.exec(text)
  return {
    name,
    enabled: /is activate/i.test(first),
    up: /line protocol is up/i.test(first),
    description: descriptionOf(text),
    capacity: onus ? Number(onus[1]) : null,
    registered: onus ? Number(onus[2]) : null,
    inBps: rateOf(text, 'input'),
    outBps: rateOf(text, 'output'),
  }
}

/**
 * `show vlan 100`:
 *
 *   vlanid          :100
 *   name            :VLAN0100
 *   description     :N/A
 *   port(untagged):
 *     gei_1/4/1,3
 *   port(tagged):
 */
function parseVlan(id: number, text: string): OltVlan {
  const clean = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()
  const description = clean(/description\s*:(.*)/i.exec(text)?.[1])
  const untagged = /port\(untagged\):([\s\S]*?)port\(tagged\):/i.exec(text)?.[1]
  const tagged = /port\(tagged\):([\s\S]*)$/i.exec(text)?.[1]
  return {
    id,
    name: clean(/name\s*:(.*)/i.exec(text)?.[1]) || null,
    description: description && description !== 'N/A' ? description : null,
    untagged: clean(untagged) || null,
    tagged: clean(tagged) || null,
  }
}

/**
 * ONUs waiting to be authorised, from `show gpon onu uncfg`:
 *
 *   OnuIndex                 Sn                  State
 *   gpon-onu_1/1/1:1         ZTEG12345678        unknown
 *
 * NOT YET SEEN ON A REAL UNIT. The C320 this module was written against had
 * no PON card in service, so it answered "No related information to show".
 * The layout above is ZTE's documented one; only the row prefix is relied on,
 * which is the part least likely to differ.
 */
function countUnauthorised(text: string): number {
  if (refused(text)) return 0
  return text.split('\n').filter((l) => /^\s*gpon-onu_\d+\/\d+\/\d+:\d+/.test(l)).length
}

/**
 * Authorised ONUs that are not online, from `show gpon onu state`:
 *
 *   OnuIndex   Admin State  OMCC State  Phase State  Channel
 *   1/1/1:1    enable       enable      working      1(GPON)
 *   1/1/1:2    enable       disable     LOS          1(GPON)
 *
 * An ONU is online only in the "working" phase. LOS, DyingGasp and OffLine are
 * all a customer without service, for different reasons, and count the same
 * here. Same caveat as above: documented layout, not yet seen on a real unit.
 */
function countStates(text: string): { total: number; offline: number } {
  if (refused(text)) return { total: 0, offline: 0 }
  let total = 0
  let offline = 0
  for (const line of text.split('\n')) {
    if (!/^\s*(?:gpon-onu_)?\d+\/\d+\/\d+:\d+\s/.test(line)) continue
    total += 1
    if (!/\bworking\b/i.test(line)) offline += 1
  }
  return { total, offline }
}

/* -------------------------------------------------------------------------- */
/* ONUs: listing them, and letting them on                                    */
/* -------------------------------------------------------------------------- */

/** A GPON serial number: four vendor characters and eight hex digits. */
const SERIAL = /^[A-Za-z0-9]{4}[0-9A-Fa-f]{8}$/
const PORT_REF = /gpon-o(?:lt|nu)_(\d+\/\d+\/\d+)(?::(\d+))?/

/**
 * `show gpon onu uncfg`: ONUs plugged in and waiting.
 *
 * READ BY WHAT EACH FIELD LOOKS LIKE, NOT BY COLUMN. This is the one layout
 * here not yet seen on a real unit — no PON card was in service when this was
 * written — and the columns depend on a setting (this OLT has
 * "uncfg-onu-display-info model sn pw"). A port reference and a 12-character
 * serial are unmistakable wherever they sit, so those are what is looked for.
 */
function parsePending(text: string): OltPendingOnu[] {
  if (refused(text)) return []
  const found: OltPendingOnu[] = []
  for (const line of text.split('\n')) {
    const ref = PORT_REF.exec(line)
    if (!ref) continue
    const fields = line.trim().split(/\s+/)
    const sn = fields.find((f) => SERIAL.test(f))
    if (!sn) continue
    const model =
      fields.find(
        (f) => f !== sn && !PORT_REF.test(f) && !/^(unknown|N\/A|-+)$/i.test(f) && /[A-Za-z]/.test(f)
      ) ?? null
    found.push({ port: 'gpon-olt_' + ref[1], sn: sn.toUpperCase(), model })
  }
  return found
}

/**
 * `show gpon onu baseinfo gpon-olt_1/1/1`, as a real C320 printed it:
 *
 *   OnuIndex            Type        Mode    AuthInfo                State
 *   gpon-onu_1/1/1:1    GENERIC     sn      SN:ZTEG00000001         ready
 */
function parseBaseInfo(text: string): Map<number, { type: string | null; sn: string | null }> {
  const out = new Map<number, { type: string | null; sn: string | null }>()
  if (refused(text)) return out
  for (const line of text.split('\n')) {
    const m = /^\s*gpon-onu_\d+\/\d+\/\d+:(\d+)\s+(\S+)\s+\S+\s+(\S+)/.exec(line)
    if (!m) continue
    out.set(Number(m[1]), { type: m[2], sn: m[3].replace(/^SN:/i, '') || null })
  }
  return out
}

/**
 * `show gpon onu state gpon-olt_1/1/1`, as a real C320 printed it:
 *
 *   OnuIndex   Admin State  OMCC State  Phase State  Channel
 *   1/1/1:1     enable       disable     OffLine      1(GPON)
 *   ONU Number: 0/1
 */
function parseStates(text: string): Map<number, string> {
  const out = new Map<number, string>()
  if (refused(text)) return out
  for (const line of text.split('\n')) {
    const m = /^\s*(?:gpon-onu_)?\d+\/\d+\/\d+:(\d+)\s+\S+\s+\S+\s+(\S+)/.exec(line)
    if (m) out.set(Number(m[1]), m[2])
  }
  return out
}

/** The ONUs whose Admin State column reads "disable": switched off from the OLT. */
function parseDisabled(text: string): Set<number> {
  const out = new Set<number>()
  if (refused(text)) return out
  for (const line of text.split('\n')) {
    const m = /^\s*(?:gpon-onu_)?\d+\/\d+\/\d+:(\d+)\s+disable\b/i.exec(line)
    if (m) out.add(Number(m[1]))
  }
  return out
}

/**
 * The PON ports worth asking about: every one on a slot that has a card in it.
 *
 * INCLUDING A CARD THAT HAS NOT STARTED. ONUs registered on its ports are
 * still registered — they are simply all offline — and leaving them out would
 * show an OLT with a failed card as having no customers at all.
 */
function livePonPorts(cards: OltCard[]): string[] {
  const ports: string[] = []
  for (const card of cards) {
    const type = (card.actual ?? card.configured).toUpperCase()
    // Even a slot whose card has been pulled out: the ONUs registered on it
    // stay registered, and come back when a card goes in.
    if (!type.startsWith('GT')) continue
    for (let p = 1; p <= Math.min(card.ports ?? 0, 32); p += 1) ports.push('gpon-olt_1/' + card.slot + '/' + p)
  }
  return ports
}

/**
 * `show pon power onu-rx gpon-olt_1/1/1` and `... olt-rx ...`: one light level
 * per ONU on the port.
 *
 * NOT YET SEEN WITH AN ONU ONLINE. A real C320 accepted both commands and
 * answered "No related information to show" with nothing working on the port.
 * ZTE documents the rows as an ONU reference followed by a level such as
 * "-21.4(dbm)", so each row is read as: which ONU, then the first signed
 * number after it. A row with no number (an ONU that is off) gives no reading.
 */
function parsePortPower(text: string): Map<number, number> {
  const out = new Map<number, number>()
  if (refused(text)) return out
  for (const line of text.split('\n')) {
    const m = /gpon-onu_\d+\/\d+\/\d+:(\d+)\s+(-?\d+(?:\.\d+)?)\s*\(?dbm/i.exec(line)
    if (!m) continue
    const level = Number.parseFloat(m[2])
    if (Number.isFinite(level)) out.set(Number(m[1]), level)
  }
  return out
}

/**
 * `show mac gpon olt gpon-olt_1/1/1`: the addresses learned behind each ONU.
 * The table is the one `show mac` printed on a real C320,
 *
 *   Mac address      Vlan  Type      Port                Vc
 *   2cc8.1bf8.7bd7   100   Dynamic   gei_1/4/3
 *
 * with the ONU in the Port column for a customer's address. Addresses come
 * back as AA:BB:CC:DD:EE:FF, the form customers are stored in.
 */
function parsePortMacs(text: string): Map<number, string[]> {
  const out = new Map<number, string[]>()
  if (refused(text)) return out
  for (const line of text.split('\n')) {
    const m = /^\s*([0-9a-f]{4})\.([0-9a-f]{4})\.([0-9a-f]{4})\s.*gpon-onu_\d+\/\d+\/\d+:(\d+)/i.exec(line)
    if (!m) continue
    const mac = ((m[1] + m[2] + m[3]).toUpperCase().match(/.{2}/g) ?? []).join(':')
    const index = Number(m[4])
    const list = out.get(index) ?? []
    if (!list.includes(mac)) list.push(mac)
    out.set(index, list)
  }
  return out
}

async function readOnusOnPort(session: TelnetSession, port: string): Promise<OltOnu[]> {
  const base = parseBaseInfo(await run(session, 'show gpon onu baseinfo ' + port))
  if (base.size === 0) return []
  const stateText = await run(session, 'show gpon onu state ' + port)
  const states = parseStates(stateText)
  const disabled = parseDisabled(stateText)
  // Three more questions, asked only of a port with someone working on it: an
  // offline ONU sends no light and has no router behind it to be seen.
  const anyWorking = [...states.values()].some((s) => s.toLowerCase() === 'working')
  const rx = anyWorking ? parsePortPower(await run(session, 'show pon power onu-rx ' + port)) : new Map<number, number>()
  const tx = anyWorking ? parsePortPower(await run(session, 'show pon power olt-rx ' + port)) : new Map<number, number>()
  const macs = anyWorking ? parsePortMacs(await run(session, 'show mac gpon olt ' + port)) : new Map<number, string[]>()
  const onus: OltOnu[] = []
  for (const [index, info] of base) {
    const phase = states.get(index) ?? 'unknown'
    onus.push({
      id: port.replace('gpon-olt_', 'gpon-onu_') + ':' + index,
      port,
      index,
      type: info.type,
      sn: info.sn,
      phase,
      // Only "working" is a customer with service. LOS, DyingGasp and OffLine
      // are three reasons for the same result.
      online: phase.toLowerCase() === 'working',
      rx: rx.get(index) ?? null,
      tx: tx.get(index) ?? null,
      macs: macs.get(index) ?? [],
      disabled: disabled.has(index),
    })
  }
  return onus.sort((a, b) => a.index - b.index)
}

/**
 * The names ISPMan sets up on an OLT for the ONUs it authorises. Created if
 * missing, left alone if present, so the same code works on an OLT nobody has
 * prepared.
 *
 * ONE ONU TYPE FOR EVERY BRAND. ZTE's built-in types only describe ZTE's own
 * models, and registering any other ONU against one of them is refused ("Not
 * support this ONU"). A generic type with four Ethernet ports fits a mixed
 * estate of ZTE, Huawei, V-SOL and others.
 *
 * THE UPSTREAM PROFILE IS DELIBERATELY WIDE (1 Gbps maximum, nothing
 * reserved). Customer speeds are set per plan on the router, where ISPMan
 * already controls them; limiting them a second time here would mean two
 * places to change for every plan.
 */
const ONU_TYPE = 'GENERIC'
const UP_PROFILE = 'ISPMAN-UP'

async function prepare(session: TelnetSession): Promise<void> {
  // Each of these answers with an error if it already exists, which is fine.
  await run(session, 'configure terminal')
  await run(session, 'pon')
  await run(session, 'onu-type ' + ONU_TYPE + ' gpon description Any-brand-ONU max-tcont 8 max-gemport 32')
  await run(session, 'onu-type-if ' + ONU_TYPE + ' eth_0/1-4')
  await run(session, 'exit')
  await run(session, 'gpon')
  await run(session, 'profile tcont ' + UP_PROFILE + ' type 4 maximum 1000000')
  await run(session, 'exit')
  await run(session, 'end')
}

/**
 * Authorise one ONU, for customers whose ONUs have VLAN switched off.
 *
 * THE ONU SENDS PLAIN TRAFFIC AND NEVER KNOWS A VLAN EXISTS. The OLT needs one
 * internally to carry it to the uplink, so the OLT adds it as the traffic
 * comes in ("user-vlan untagged vlan N") and the uplink hands it back out
 * untagged. Nothing is configured on the customer's device.
 *
 * Every line below was accepted by a real C320 on V2.1.0 against a test ONU.
 * What has NOT been seen is traffic passing, which needs a PON card in
 * service and a real ONU on the fibre.
 *
 * STOPS AT THE FIRST REFUSAL AND UNDOES THE REGISTRATION, so a half-set-up ONU
 * is not left holding a slot on the port and showing as authorised.
 */
async function authoriseOne(
  session: TelnetSession,
  port: string,
  index: number,
  sn: string,
  template: Template
): Promise<string | null> {
  const onu = port.replace('gpon-olt_', 'gpon-onu_') + ':' + index
  const steps: [string, string][] = [
    ['interface ' + port, ''],
    ['onu ' + index + ' type ' + ONU_TYPE + ' sn ' + sn, 'registering it on the port'],
    ['exit', ''],
    ['interface ' + onu, ''],
    ...template.iface.map((l): [string, string] => [l, '"' + l + '"']),
    ['exit', ''],
    ['pon-onu-mng ' + onu, ''],
    ...template.mng.map((l): [string, string] => [l, '"' + l + '"']),
    ['exit', ''],
  ]

  await run(session, 'configure terminal')
  let problem: string | null = null
  for (const [command, what] of steps) {
    const out = await run(session, command)
    if (refused(out)) {
      const said = out.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? ''
      problem = 'The OLT refused ' + (what || command) + ': ' + said
      break
    }
  }
  if (problem) {
    // Back to the top of config mode, wherever the failure left us, then undo.
    await run(session, 'end')
    await run(session, 'configure terminal')
    await run(session, 'interface ' + port)
    await run(session, 'no onu ' + index)
    await run(session, 'end')
    return problem
  }
  await run(session, 'end')
  return null
}

/* -------------------------------------------------------------------------- */
/* Setting up a new ONU the way its neighbours are                            */
/* -------------------------------------------------------------------------- */

/**
 * The lines of one ONU's configuration that describe how it is set up rather
 * than who it belongs to, with its own id taken out so they can be replayed on
 * another ONU.
 *
 *   show running-config interface gpon-onu_1/1/3:5
 *     interface gpon-onu_1/1/3:5
 *       name Jane Brown
 *       tcont 1 profile 1G
 *       gemport 1 tcont 1
 *       service-port 1 vport 1 user-vlan 20 vlan 20
 *     !
 *
 *   show onu running config gpon-onu_1/1/3:5
 *     pon-onu-mng gpon-onu_1/1/3:5
 *       service 1 gemport 1 vlan 20
 *       vlan port eth_0/1 mode tag vlan 20
 *     !
 *
 * WHAT IS LEFT OUT, AND WHY. A name or description is that customer's. A
 * PPPoE login, a Wi-Fi name or any password is that customer's and must never
 * be copied onto someone else's ONU. A serial binding ties the line to that
 * one ONU. Everything else — channels, profiles, VLANs, port modes,
 * management — is how the company runs its network, which is the point.
 */
const PERSONAL = /^(name|description|sn-bind|auth|security-mgmt|ssid|wifi|wlan)\b|password|username|user-name|pppoe|key\s/i

function configLines(text: string, header: RegExp): string[] {
  if (refused(text)) return []
  const out: string[] = []
  let inside = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!inside) {
      if (header.test(line)) inside = true
      continue
    }
    if (line === '!' || line === 'end' || line === '$' || /^(interface|pon-onu-mng)\s/.test(line)) break
    if (!line || PERSONAL.test(line)) continue
    out.push(line)
  }
  return out
}

type Template = { iface: string[]; mng: string[] }

async function readTemplate(session: TelnetSession, onu: string): Promise<Template> {
  const iface = configLines(
    await run(session, 'show running-config interface ' + onu),
    /^interface\s+gpon-onu_/
  )
  const mng = configLines(await run(session, 'show onu running config ' + onu), /^pon-onu-mng\s+gpon-onu_/)
  return { iface, mng }
}

/** The tagged/untagged and VLAN a template amounts to, for showing a person. */
function summarise(t: Template): OnuServiceSetup | null {
  for (const line of t.iface) {
    // A real C320 (V2.1.0) prints the untagged form back as "user-vlan untag".
    const m = /^service-port\s+\d+\s+vport\s+\d+\s+user-vlan\s+(untag(?:ged)?|\d+)\b.*?\svlan\s+(\d+)/i.exec(line)
    if (!m) continue
    const profile = t.iface.map((l) => /^tcont\s+\d+\s+(?:name\s+\S+\s+)?profile\s+(\S+)/i.exec(l)).find(Boolean)
    const down = t.iface
      .map((l) => /^gemport\s+\d+\s+traffic-limit\s+(?:upstream\s+\S+\s+)?downstream\s+(\S+)/i.exec(l))
      .find(Boolean)
    return {
      onuVlan: /^untag/i.test(m[1]) ? null : Number(m[1]),
      vlan: Number(m[2]),
      upProfile: profile ? profile[1] : null,
      downProfile: down && down[1] !== 'default' ? down[1] : null,
    }
  }
  return null
}

/** What ISPMan writes when it is told the setup rather than copying one. */
function templateFor(setup: OnuServiceSetup): Template {
  const tagged = setup.onuVlan != null
  return {
    iface: [
      'tcont 1 profile ' + (setup.upProfile || UP_PROFILE),
      'gemport 1 tcont 1',
      // A download limit, when the company limits speed on the OLT.
      ...(setup.downProfile ? ['gemport 1 traffic-limit downstream ' + setup.downProfile] : []),
      'service-port 1 vport 1 user-vlan ' + (tagged ? setup.onuVlan : 'untagged') + ' vlan ' + setup.vlan,
    ],
    // A tagged ONU is told its VLAN too, so an ONU that takes its settings
    // from the OLT tags with the right one.
    mng: ['service 1 gemport 1' + (tagged ? ' vlan ' + setup.onuVlan : '')],
  }
}

/**
 * Read up to four working ONUs on a port and take the setup most of them
 * share. Working ones first: an ONU that never passed traffic proves nothing.
 */
async function learnOnPort(session: TelnetSession, port: string): Promise<(LearnedSetup & { template: Template }) | null> {
  const states = parseStates(await run(session, 'show gpon onu state ' + port))
  const ids = [...states.entries()]
    .sort((a, b) => Number(/working/i.test(b[1])) - Number(/working/i.test(a[1])) || a[0] - b[0])
    .map(([index]) => port.replace('gpon-olt_', 'gpon-onu_') + ':' + index)
    .slice(0, 4)

  const seen = new Map<string, { template: Template; summary: OnuServiceSetup; from: string; count: number }>()
  for (const id of ids) {
    const template = await readTemplate(session, id)
    const summary = summarise(template)
    if (!summary) continue
    const key = template.iface.join('|') + '#' + template.mng.join('|')
    const had = seen.get(key)
    if (had) had.count += 1
    else seen.set(key, { template, summary, from: id, count: 1 })
  }
  const best = [...seen.values()].sort((a, b) => b.count - a.count)[0]
  if (!best) return null
  const read = [...seen.values()].reduce((n, v) => n + v.count, 0)
  return { ...best.summary, from: best.from, agreeing: best.count, read, template: best.template }
}

/* -------------------------------------------------------------------------- */
/* The OLT's own settings: VLANs, uplinks, PON ports                          */
/* -------------------------------------------------------------------------- */

/**
 * Every change here is planned from what the OLT says at that moment, never
 * from what a page remembers, and comes with the commands that undo it.
 *
 * THE ONE THING IT WILL NOT DO is cut the OLT off from its own management.
 * The VLAN holding the OLT's address (vlan100 at 10.10.4.6 on a real C320) is
 * how ISPMan, and the person, reach it; removing that VLAN, or taking it off
 * an uplink that is switched on, could leave a site visit as the only way back.
 *
 * Commands and their syntax are as a real C320 (V2.1.0) prints them back:
 *   interface gei_1/3/3
 *     switchport mode hybrid
 *     switchport vlan 100 untag
 *     switchport default vlan 100
 */

const PROFILE_NAME = /^[A-Za-z0-9_.-]{1,32}$/

/**
 * Searching the whole configuration (`show running-config | include …`)
 * takes a full C320 well past the usual 12 seconds. Only the checks before a
 * removal do it, and they get this long.
 */
const SEARCH_WAIT = 90_000

/**
 * The speed profiles, from the two quick listings rather than a search of
 * the whole configuration, which on a full C320 outlasted the reading and
 * failed it. As a real C320 (V2.1.0) prints them:
 *
 *   Profile name :T-UP-4M
 *    Type           FBW(kbps)   ABW(kbps)   MBW(kbps)   PRIORITY   WEIGHT
 *    4              0           0           4096        N/A         N/A
 *
 *   Profile name  :P-10M
 *     SIR(kbps)           PIR(kbps)           CBS(kbytes)         PBS(kbytes)
 *    11264               11264               default             default
 *
 * Each is turned back into the words that define it, for undo.
 */
async function readSpeedProfiles(session: TelnetSession): Promise<OltSpeedProfile[]> {
  const out: OltSpeedProfile[] = []
  const blocks = (text: string) => (refused(text) ? [] : text.split(/Profile name\s*:/i).slice(1))

  for (const block of blocks(await run(session, 'show gpon profile tcont'))) {
    const name = /^\s*(\S+)/.exec(block)?.[1]
    const row = /^\s*(\d)\s+(\d+)\s+(\d+)\s+(\d+)\s/m.exec(block.split('\n').slice(2).join('\n'))
    if (!name || !row) continue
    const [type, fbw, abw, mbw] = [row[1], Number(row[2]), Number(row[3]), Number(row[4])]
    const raw =
      type === '1' ? 'type 1 fixed ' + fbw
        : type === '2' ? 'type 2 assured ' + abw
          : type === '3' ? 'type 3 assured ' + abw + ' maximum ' + mbw
            : type === '4' ? 'type 4 maximum ' + mbw
              : 'type 5 fixed ' + fbw + ' assured ' + abw + ' maximum ' + mbw
    out.push({ name, direction: 'up', kbps: mbw || fbw || abw || null, raw })
  }

  for (const block of blocks(await run(session, 'show gpon profile traffic'))) {
    const name = /^\s*(\S+)/.exec(block)?.[1]
    const row = /^\s*(\d+)\s+(\d+)\s/m.exec(block.split('\n').slice(2).join('\n'))
    if (!name || !row || name === 'default') continue
    out.push({ name, direction: 'down', kbps: Number(row[2]), raw: 'sir ' + row[1] + ' pir ' + row[2] })
  }
  return out
}

const UPLINK = /^x?gei_\d+\/\d+\/\d+$/
const PON = /^gpon-olt_\d+\/\d+\/\d+$/

/** A port's settings as printed, every line kept. */
async function portLines(session: TelnetSession, port: string): Promise<string[]> {
  const text = await run(session, 'show running-config interface ' + port)
  if (refused(text)) throw new CliError('The OLT has no port called ' + port + '.')
  const out: string[] = []
  let inside = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!inside) {
      if (line.startsWith('interface ')) inside = true
      continue
    }
    if (line === '!' || line === 'end') break
    if (line) out.push(line)
  }
  return out
}

/** VLAN interfaces with an address on them: the OLT's management. */
async function managementVlans(session: TelnetSession): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  for (const line of (await run(session, 'show ip interface brief')).split('\n')) {
    const m = /^\s*vlan(\d+)\s+(\d+\.\d+\.\d+\.\d+)/i.exec(line)
    if (m) out.set(Number(m[1]), m[2])
  }
  return out
}

const validVlan = (v: number) => Number.isInteger(v) && v >= 1 && v <= 4094

async function planOne(session: TelnetSession, change: OltConfigChange): Promise<OltChangePlan> {
  const say = (s: string): never => {
    throw new CliError(s)
  }

  if (change.kind === 'vlan-add' || change.kind === 'vlan-remove') {
    const v = Number(change.vlan)
    if (!validVlan(v) || v === 1) say('Choose a VLAN from 2 to 4094.')
    const existing = new Set(parseVlanList(await run(session, 'show vlan summary')))

    if (change.kind === 'vlan-add') {
      if (existing.has(v)) say('VLAN ' + v + ' already exists on this OLT.')
      const name = cliWord(change.name ?? '', 30)
      return {
        summary: 'Create VLAN ' + v + (name ? ' (' + name + ')' : ''),
        commands: ['vlan ' + v, ...(name ? ['name ' + name] : []), 'exit'],
        undo: ['no vlan ' + v],
      }
    }

    if (!existing.has(v)) say('There is no VLAN ' + v + ' on this OLT.')
    const mgmt = await managementVlans(session)
    if (mgmt.has(v)) {
      say(
        'VLAN ' + v + ' is how this OLT is managed: its address ' + mgmt.get(v) + ' is on it. ' +
          'Removing it would cut ISPMan, and you, off from the OLT.'
      )
    }
    // Still carrying customers or uplinks: say so rather than strand them.
    const uses = (await run(session, 'show running-config | include vlan ' + v, SEARCH_WAIT))
      .split('\n')
      .map((l) => l.trim())
    const onus = uses.filter((l) => new RegExp('^service-port\\s.*\\svlan\\s' + v + '\\b').test(l)).length
    const ports = uses.filter((l) => new RegExp('^switchport\\s+(?:vlan|default vlan)\\s' + v + '\\b').test(l)).length
    if (onus || ports) {
      say(
        'VLAN ' + v + ' is still in use: ' +
          [onus ? onus + (onus === 1 ? ' ONU' : ' ONUs') : '', ports ? ports + ' uplink setting' + (ports === 1 ? '' : 's') : '']
            .filter(Boolean)
            .join(' and ') +
          '. Move them to another VLAN first.'
      )
    }
    const was = parseVlan(v, await run(session, 'show vlan ' + v))
    return {
      summary: 'Remove VLAN ' + v,
      commands: ['no vlan ' + v],
      undo: ['vlan ' + v, ...(was.name && !/^VLAN0*\d+$/i.test(was.name) ? ['name ' + cliWord(was.name, 30)] : []), 'exit'],
    }
  }

  if (change.kind === 'uplink-vlan-add' || change.kind === 'uplink-vlan-remove') {
    const port = String(change.port)
    const v = Number(change.vlan)
    if (!UPLINK.test(port)) say('That is not an uplink port.')
    if (!validVlan(v)) say('Choose a VLAN from 1 to 4094.')
    const lines = await portLines(session, port)
    const mode = /^switchport mode (\S+)/.exec(lines.find((l) => l.startsWith('switchport mode')) ?? '')?.[1] ?? 'access'
    const has = lines
      .map((l) => /^switchport vlan (\S+) (tag|untag)$/.exec(l))
      .find((m) => m && m[1].split(',').some((part) => {
        const r = /^(\d+)(?:-(\d+))?$/.exec(part)
        return !!r && v >= Number(r[1]) && v <= Number(r[2] ?? r[1])
      }))

    if (change.kind === 'uplink-vlan-add') {
      if (!parseVlanList(await run(session, 'show vlan summary')).includes(v)) {
        say('There is no VLAN ' + v + ' on this OLT yet. Create it first.')
      }
      if (has) say(port + ' already carries VLAN ' + v + (has[2] === 'tag' ? ', tagged.' : ', untagged.'))
      if (mode === 'access') say(port + ' is an access port, which carries one VLAN only. Change it to trunk or hybrid on the OLT first.')
      if (!change.tagged && mode === 'trunk') {
        say(port + ' is a trunk port, which carries VLANs tagged only. Add it tagged, or set the port to hybrid on the OLT first.')
      }
      const how = change.tagged ? 'tag' : 'untag'
      // Untagged traffic arriving on a hybrid port goes into the port's
      // default VLAN, whatever else it carries untagged on the way out.
      const pvid = Number(/^switchport default vlan (\d+)$/.exec(lines.find((l) => l.startsWith('switchport default vlan')) ?? '')?.[1] ?? 1)
      return {
        summary: 'Carry VLAN ' + v + ' ' + (change.tagged ? 'tagged' : 'untagged') + ' on ' + port,
        commands: ['interface ' + port, 'switchport vlan ' + v + ' ' + how, 'exit'],
        undo: ['interface ' + port, 'no switchport vlan ' + v, 'exit'],
        warning:
          !change.tagged && pvid !== v
            ? 'Untagged traffic coming in on ' + port + ' goes to VLAN ' + pvid + ', the port\'s default. ' +
              'This adds VLAN ' + v + ' going out untagged only.'
            : undefined,
      }
    }

    if (!has) say(port + ' does not carry VLAN ' + v + '.')
    const mgmt = await managementVlans(session)
    const off = lines.includes('shutdown')
    if (mgmt.has(v) && !off) {
      say(
        'VLAN ' + v + ' carries this OLT\'s management (' + mgmt.get(v) + '), and ' + port + ' is switched on: ' +
          'this may be the way ISPMan, and you, reach the OLT. Change it at the OLT itself if you are sure.'
      )
    }
    return {
      summary: 'Stop carrying VLAN ' + v + ' on ' + port,
      commands: ['interface ' + port, 'no switchport vlan ' + v, 'exit'],
      undo: ['interface ' + port, 'switchport vlan ' + v + ' ' + (has?.[2] ?? 'tag'), 'exit'],
    }
  }

  if (change.kind === 'uplink-mode' || change.kind === 'uplink-pvid') {
    const port = String(change.port)
    if (!UPLINK.test(port)) say('That is not an uplink port.')
    const lines = await portLines(session, port)
    const mode = /^switchport mode (\S+)/.exec(lines.find((l) => l.startsWith('switchport mode')) ?? '')?.[1] ?? 'access'
    const pvid = Number(/^switchport default vlan (\d+)$/.exec(lines.find((l) => l.startsWith('switchport default vlan')) ?? '')?.[1] ?? 1)
    const carried = lines
      .map((l) => /^switchport vlan (\S+) (tag|untag)$/.exec(l))
      .filter((m): m is RegExpExecArray => !!m)
      .flatMap((m) => m[1].split(',').flatMap((part) => {
        const r = /^(\d+)(?:-(\d+))?$/.exec(part)
        if (!r) return []
        const out: number[] = []
        for (let v = Number(r[1]); v <= Number(r[2] ?? r[1]) && out.length < 4094; v += 1) out.push(v)
        return out
      }))
    const mgmt = await managementVlans(session)
    const live = !lines.includes('shutdown')
    const carriesMgmt = [...mgmt.keys()].some((v) => carried.includes(v) || pvid === v)

    if (change.kind === 'uplink-mode') {
      const to = change.mode
      if (to !== 'trunk' && to !== 'hybrid' && to !== 'access') say('Choose trunk, hybrid or access.')
      if (to === mode) say(port + ' is already ' + mode + '.')
      // Changing the mode can clear what the port carries. On the port the
      // OLT is managed through, that is the OLT gone until someone is there.
      if (live && carriesMgmt) {
        say(
          port + ' carries this OLT\'s management VLAN and is switched on. Changing its mode can drop that, ' +
            'and with it ISPMan and you. Change it at the OLT itself, or move management to another port first.'
        )
      }
      return {
        summary: 'Set ' + port + ' to ' + to + ' mode',
        commands: ['interface ' + port, 'switchport mode ' + to, 'exit'],
        undo: [
          'interface ' + port,
          'switchport mode ' + mode,
          ...lines.filter((l) => /^switchport (vlan|default vlan) /.test(l)),
          'exit',
        ],
        warning:
          'Changing the mode can clear the VLANs ' + port + ' carries' +
          (carried.length ? ' (' + [...new Set(carried)].slice(0, 8).join(', ') + ')' : '') +
          '. Check them afterwards; Undo puts them back.',
      }
    }

    const v = Number(change.vlan)
    if (!validVlan(v)) say('Choose a VLAN from 1 to 4094.')
    if (v === pvid) say(port + '\'s default VLAN is already ' + v + '.')
    if (mode === 'trunk') say(port + ' is a trunk port, which has no use for a default VLAN. Set it to hybrid first.')
    if (!parseVlanList(await run(session, 'show vlan summary')).includes(v)) say('There is no VLAN ' + v + ' on this OLT yet. Create it first.')
    if (live && mgmt.has(pvid) && !mgmt.has(v)) {
      say(
        'Untagged traffic on ' + port + ' now goes to VLAN ' + pvid + ', which this OLT is managed on. Moving it ' +
          'could cut ISPMan, and you, off from the OLT. Change it at the OLT itself if you are sure.'
      )
    }
    return {
      summary: 'Send untagged traffic on ' + port + ' to VLAN ' + v,
      commands: ['interface ' + port, 'switchport default vlan ' + v, 'exit'],
      undo: ['interface ' + port, 'switchport default vlan ' + pvid, 'exit'],
    }
  }

  if (change.kind === 'speed-add' || change.kind === 'speed-remove') {
    const name = String(change.name).trim()
    if (!PROFILE_NAME.test(name)) say('Use letters, numbers, dots, dashes or underscores for the name, up to 32.')
    const up = change.direction === 'up'
    const word = up ? 'tcont' : 'traffic'
    const all = await readSpeedProfiles(session)
    const found = all.find((p) => p.name === name && p.direction === change.direction)

    if (change.kind === 'speed-add') {
      const mbps = Number(change.mbps)
      if (!(mbps > 0 && mbps <= 10000)) say('Choose a speed from 1 to 10000 Mbps.')
      if (found) say('There is already a' + (up ? 'n upload' : ' download') + ' profile called ' + name + '.')
      const kbps = Math.round(mbps * 1024)
      // Upload: a type 4 T-CONT, best effort up to the maximum. Download: a
      // traffic profile with committed and peak rate both at the limit.
      const line = up ? 'profile tcont ' + name + ' type 4 maximum ' + kbps : 'profile traffic ' + name + ' sir ' + kbps + ' pir ' + kbps
      return {
        summary: 'Create ' + (up ? 'upload' : 'download') + ' speed profile ' + name + ' (' + mbps + ' Mbps)',
        commands: ['gpon', line, 'exit'],
        undo: ['gpon', 'no profile ' + word + ' ' + name, 'exit'],
      }
    }

    if (!found) say('There is no ' + (up ? 'upload' : 'download') + ' profile called ' + name + '.')
    if (up && name === UP_PROFILE) say(name + ' is the profile ISPMan gives ONUs with no upload limit. It cannot be removed from here.')
    const uses = (await run(session, 'show running-config | include ' + name, SEARCH_WAIT))
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => (up ? new RegExp('^tcont\\s+\\d+\\s+(?:name\\s+\\S+\\s+)?profile\\s+' + name.replace(/[.]/g, '\\.') + '$') : new RegExp('traffic-limit.*\\s' + name.replace(/[.]/g, '\\.') + '(\\s|$)')).test(l)).length
    if (uses) say(name + ' is used by ' + uses + (uses === 1 ? ' ONU' : ' ONUs') + '. Move them to another profile first.')
    return {
      summary: 'Remove ' + (up ? 'upload' : 'download') + ' speed profile ' + name,
      commands: ['gpon', 'no profile ' + word + ' ' + name, 'exit'],
      undo: ['gpon', 'profile ' + word + ' ' + name + ' ' + found!.raw, 'exit'],
    }
  }

  if (change.kind === 'port-description') {
    const port = String(change.port)
    if (!UPLINK.test(port) && !PON.test(port)) say('That is not a port on this OLT.')
    const lines = await portLines(session, port)
    const old = /^description (.+)$/.exec(lines.find((l) => l.startsWith('description ')) ?? '')?.[1] ?? null
    const text = cliWord(change.text, 60)
    return {
      summary: (text ? 'Label ' + port + ' "' + text + '"' : 'Remove the label from ' + port),
      commands: ['interface ' + port, text ? 'description ' + text : 'no description', 'exit'],
      undo: ['interface ' + port, old ? 'description ' + old : 'no description', 'exit'],
    }
  }

  // PON port on or off.
  const port = String(change.port)
  if (!PON.test(port)) say('That is not a PON port.')
  const lines = await portLines(session, port)
  const off = lines.includes('shutdown')
  if (change.kind === 'pon-enable') {
    if (!off) say(port + ' is already switched on.')
    return {
      summary: 'Switch on ' + port,
      commands: ['interface ' + port, 'no shutdown', 'exit'],
      undo: ['interface ' + port, 'shutdown', 'exit'],
    }
  }
  if (off) say(port + ' is already switched off.')
  const working = [...parseStates(await run(session, 'show gpon onu state ' + port)).values()].filter((s) =>
    /working/i.test(s)
  ).length
  return {
    summary: 'Switch off ' + port,
    commands: ['interface ' + port, 'shutdown', 'exit'],
    undo: ['interface ' + port, 'no shutdown', 'exit'],
    warning: working
      ? working + (working === 1 ? ' ONU is' : ' ONUs are') + ' working on this port right now. ' +
        (working === 1 ? 'That customer loses' : 'Those customers lose') + ' service until it is switched back on.'
      : undefined,
  }
}

/* -------------------------------------------------------------------------- */
/* One ONU: what it reports, and what can be done to it                       */
/* -------------------------------------------------------------------------- */

const ONU_ID = /^gpon-onu_(\d+\/\d+\/\d+):(\d+)$/

/** A value the OLT prints as N/A, empty or zero-dated is no value. */
const real = (v: string | undefined): string | null => {
  const t = (v ?? '').trim()
  return t && t !== 'N/A' && !t.startsWith('0000-00-00') ? t : null
}

const dbm = (v: string | undefined): number | null => {
  const n = Number.parseFloat(v ?? '')
  return Number.isFinite(n) ? n : null
}

/**
 * Everything one ONU reports, from three commands a real C320 printed:
 *
 *   show gpon onu detail-info      name, state, distance, time online, and
 *                                  the last ten times it came up and went down
 *   show pon power attenuation     light levels in both directions
 *   show gpon remote-onu equip     what the ONU says it is
 *
 * LIGHT LEVELS ARE READ FROM THE ROW, NOT THE COLUMN HEADER. The table is
 *
 *    up      Rx :-21.4(dbm)      Tx:2.1(dbm)      23.5(dB)
 *    down    Tx :3.9(dbm)        Rx:-19.8(dbm)    23.7(dB)
 *
 * where "up" is OLT-receives / ONU-sends and "down" is the reverse. The figure
 * that decides whether a customer has a good connection is the ONU's receive
 * level on the "down" row.
 */
async function readOnuDetail(session: TelnetSession, id: string): Promise<OltOnuDetail> {
  const info = await run(session, 'show gpon onu detail-info ' + id)
  const power = await run(session, 'show pon power attenuation ' + id)
  const equip = await run(session, 'show gpon remote-onu equip ' + id)
  // `show interface gpon-onu_…` as a real C320 printed it:
  //   Input rate :   0 Bps   0 pps      (from the customer)
  //   Output rate:   0 Bps   0 pps      (to the customer)
  //   Input:  Bytes:0  Packets:0
  const iface = await run(session, 'show interface ' + id)
  const total = (which: 'Input' | 'Output'): number | null => {
    const m = new RegExp('^\\s*' + which + ':\\s*\\n\\s*Bytes:\\s*(\\d+)', 'im').exec(iface)
    return m ? Number(m[1]) : null
  }

  const field = (text: string, label: string): string | null => {
    const m = new RegExp('^\\s*' + label + '\\s*:[ \\t]*(.*)$', 'im').exec(text)
    return real(m?.[1])
  }

  const history: OltOnuDetail['history'] = []
  for (const line of info.split('\n')) {
    const m = /^\s*\d+\s+(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\s+(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\s*(.*)$/.exec(line)
    if (!m || !real(m[1])) continue
    history.push({ up: m[1], down: real(m[2]), cause: real(m[3]) })
  }

  const up = /up\s+Rx\s*:\s*(\S+?)(?:\(dbm\))?\s+Tx\s*:\s*(\S+?)(?:\(dbm\))?\s/i.exec(power)
  const down = /down\s+Tx\s*:\s*(\S+?)(?:\(dbm\))?\s+Rx\s*:\s*(\S+?)(?:\(dbm\))?\s/i.exec(power)
  const phase = field(info, 'Phase state') ?? 'unknown'
  // Its VLAN and speed as configured, so the page can show and prefill them.
  const setup = summarise(await readTemplate(session, id))

  return {
    id,
    setup,
    name: field(info, 'Name'),
    description: field(info, 'Description'),
    type: field(info, 'Type'),
    sn: field(info, 'Serial number'),
    phase,
    online: phase.toLowerCase() === 'working',
    distance: field(info, 'ONU Distance'),
    onlineFor: field(info, 'Online Duration'),
    oltRx: dbm(up?.[1]),
    onuTx: dbm(up?.[2]),
    oltTx: dbm(down?.[1]),
    onuRx: dbm(down?.[2]),
    vendor: field(equip, 'Vendor ID'),
    model: field(equip, 'Model') ?? field(equip, 'Equipment ID'),
    firmware: field(equip, 'Version'),
    history,
    traffic: refused(iface)
      ? null
      : { upBps: rateOf(iface, 'input'), downBps: rateOf(iface, 'output'), upBytes: total('Input'), downBytes: total('Output') },
    disabled: /^\s*Admin state\s*:\s*disable/im.test(info),
  }
}

/** A name the command line takes as one word: no spaces, nothing it treats specially. */
function cliWord(raw: string, max: number): string {
  return raw
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9_.@#-]/g, '')
    .slice(0, max)
}

/** "1,100,200-205" as the OLT prints it, expanded to a list of numbers. */
function parseVlanList(text: string): number[] {
  const ids: number[] = []
  const body = text.split('\n').slice(1).join(',')
  for (const part of body.split(',')) {
    const range = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(part)
    if (range) {
      for (let v = Number(range[1]); v <= Number(range[2]) && ids.length < 4096; v += 1) ids.push(v)
    } else if (/^\s*\d+\s*$/.test(part)) {
      ids.push(Number(part))
    }
  }
  return ids
}

export const zte: OltDriver = {
  brand: 'zte',
  label: 'ZTE (C320, C300)',

  async inspect(target, creds): Promise<OltInfo> {
    const session = new TelnetSession(target)
    await session.open()
    try {
      await login(session, creds)
      await run(session, 'terminal length 0')
      const system = await run(session, 'show system-group')
      const cards = parseCards(await run(session, 'show card'))
      addProcessors(cards, await run(session, 'show processor'))

      // PORTS ARE NAMED FROM THE CARDS, not listed by a command: this software
      // has no "show all interfaces" that it accepts. A control card (SMXA)
      // carries the uplinks as gei_; a PON card carries gpon-olt_ ports.
      const uplinks: OltUplink[] = []
      const ponPorts: OltPonPort[] = []
      for (const card of cards) {
        const type = (card.actual ?? card.configured).toUpperCase()
        const count = Math.min(card.ports ?? 0, 32)
        // A slot with no card in it has no ports worth asking about.
        if (card.status === 'OFFLINE') continue
        for (let p = 1; p <= count; p += 1) {
          if (type.startsWith('SM')) {
            const name = 'gei_1/' + card.slot + '/' + p
            const text = await run(session, 'show interface ' + name)
            if (!refused(text)) {
              // Its mode and default VLAN, for the Settings tab.
              const conf = await portLines(session, name).catch(() => [] as string[])
              const mode = /^switchport mode (\S+)/.exec(conf.find((l) => l.startsWith('switchport mode')) ?? '')?.[1]
              const pvid = /^switchport default vlan (\d+)$/.exec(conf.find((l) => l.startsWith('switchport default vlan')) ?? '')?.[1]
              uplinks.push({ ...parseUplink(name, text), mode: mode ?? 'access', pvid: pvid ? Number(pvid) : 1 })
            }
          } else if (type.startsWith('GT')) {
            const name = 'gpon-olt_1/' + card.slot + '/' + p
            const text = await run(session, 'show interface ' + name)
            if (!refused(text)) ponPorts.push(parsePonPort(name, text))
          }
        }
      }

      // THE THREE NUMBERS AT THE TOP OF THE OLT PAGE. Authorised is every ONU
      // registered on a port; offline is the ones among them not in service;
      // unauthorised is the ones plugged in and waiting to be let on.
      const states = countStates(await run(session, 'show gpon onu state'))
      const registered = ponPorts.reduce((n, p) => n + (p.registered ?? 0), 0)
      const onus = {
        authorised: Math.max(registered, states.total),
        offline: states.offline,
        unauthorised: countUnauthorised(await run(session, 'show gpon onu uncfg')),
      }

      const vlanIds = parseVlanList(await run(session, 'show vlan summary'))
      const vlans: OltVlan[] = []
      for (const id of vlanIds) {
        if (vlans.length < VLAN_DETAIL_LIMIT) {
          vlans.push(parseVlan(id, await run(session, 'show vlan ' + id)))
        } else {
          vlans.push({ id, name: null, description: null, untagged: null, tagged: null })
        }
      }

      const description = /System Description:\s*(.+)/i.exec(system)?.[1]?.trim() ?? null
      const uptime = /Started before:\s*(.+)/i.exec(system)?.[1]?.trim() ?? null
      const name = /System name:\s*(\S+)/i.exec(system)?.[1] ?? null
      const version = /Version\s+(V[\d.]+)/i.exec(description ?? '')?.[1] ?? null
      const model = /^(\S+)\s+Version/i.exec(description ?? '')?.[1] ?? null

      // Never allowed to fail the reading: an OLT that answers everything else
      // is reachable, whatever this does.
      const speedProfiles = await readSpeedProfiles(session).catch(() => undefined)
      return { name, model, version, uptime, cards, uplinks, ponPorts, vlans, onus, speedProfiles }
    } finally {
      session.close()
    }
  },

  async listOnus(target, creds): Promise<OltOnuLists> {
    const session = new TelnetSession(target)
    await session.open()
    try {
      await login(session, creds)
      await run(session, 'terminal length 0')
      const cards = parseCards(await run(session, 'show card'))
      const pending = parsePending(await run(session, 'show gpon onu uncfg'))
      const onus: OltOnu[] = []
      for (const port of livePonPorts(cards)) onus.push(...(await readOnusOnPort(session, port)))
      return { pending, onus }
    } finally {
      session.close()
    }
  },

  async onuDetail(target, creds, id): Promise<OltOnuDetail> {
    if (!ONU_ID.test(id)) throw new CliError('That is not an ONU on this OLT.')
    const session = new TelnetSession(target)
    await session.open()
    try {
      await login(session, creds)
      await run(session, 'terminal length 0')
      return await readOnuDetail(session, id)
    } finally {
      session.close()
    }
  },

  /**
   * Reboot, rename or remove one ONU. Each was accepted by a real C320.
   *
   * REMOVE TAKES THE ONU OFF THE OLT ENTIRELY: its registration and its
   * service settings go, and it reappears under Unauthorized if it is still
   * plugged in. That is the intended way to move an ONU to another customer.
   */
  async onuAction(target, creds, id, action): Promise<void> {
    if (action.kind === 'vsol-fix') throw new CliError('That setting is only for V-SOL ONUs on a GCOM OLT.')
    const m = ONU_ID.exec(id)
    if (!m) throw new CliError('That is not an ONU on this OLT.')
    const port = 'gpon-olt_' + m[1]
    const index = m[2]

    const session = new TelnetSession(target)
    await session.open()
    try {
      await login(session, creds)
      await run(session, 'terminal length 0')
      await run(session, 'configure terminal')

      const must = async (command: string, what: string) => {
        const out = await run(session, command)
        if (refused(out)) {
          const said = out.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? ''
          await run(session, 'end')
          throw new CliError('The OLT refused ' + what + ': ' + said)
        }
      }

      let save = false
      if (action.kind === 'reboot') {
        await must('pon-onu-mng ' + id, 'opening the ONU')
        // Some software asks "are you sure"; answer it rather than hang.
        session.send('reboot')
        const out = await session.until(/\[yes\/no\]:?\s*$|[>#] ?$/i, 'rebooting the ONU')
        if (/\[yes\/no\]/i.test(out)) {
          session.send('yes')
          await session.until(PROMPT, 'rebooting the ONU')
        }
      } else if (action.kind === 'remove') {
        await must('interface ' + port, 'opening the PON port')
        await must('no onu ' + index, 'removing the ONU')
        save = true
      } else if (action.kind === 'disable' || action.kind === 'enable') {
        // Accepted by a real C320: the Admin State column turns to "disable"
        // and back. The ONU keeps its registration and every setting.
        await must('interface ' + id, 'opening the ONU')
        await must(action.kind === 'disable' ? 'shutdown' : 'no shutdown', action.kind === 'disable' ? 'disabling the ONU' : 'enabling the ONU')
        save = true
      } else if (action.kind === 'speed') {
        // On whichever T-CONT and GEM port the ONU actually has, which for an
        // ONU set up by hand need not be number 1.
        await run(session, 'end')
        const now = await readTemplate(session, id)
        const tcont = /^tcont\s+(\d+)\s/.exec(now.iface.find((l) => /^tcont\s+\d+\s/.test(l)) ?? '')?.[1] ?? '1'
        const gem = /^gemport\s+(\d+)\s/.exec(now.iface.find((l) => /^gemport\s+\d+\s+(?:name\s+\S+\s+)?tcont/.test(l)) ?? '')?.[1] ?? '1'
        const named = (v: string) => PROFILE_NAME.test(v)
        if ((action.up != null && !named(action.up)) || (action.down != null && action.down !== '' && !named(action.down))) {
          throw new CliError('That is not a profile name.')
        }
        await run(session, 'configure terminal')
        await must('interface ' + id, 'opening the ONU')
        if (action.up != null) await must('tcont ' + tcont + ' profile ' + action.up, 'setting its upload profile to ' + action.up)
        if (action.down != null) {
          // "default" is the OLT's own unlimited traffic profile.
          await must('gemport ' + gem + ' traffic-limit downstream ' + (action.down || 'default'), 'setting its download profile')
        }
        await must('exit', 'leaving the ONU')
        save = true
      } else if (action.kind === 'service') {
        // Swap only the VLAN half — the service-port on the OLT side and the
        // service line on the ONU side — and leave the channel, profile and
        // everything else as it is. The ONU stays registered throughout.
        const s = action.setup
        const ok = (v: number) => Number.isInteger(v) && v >= 1 && v <= 4094
        if (!ok(s.vlan) || (s.onuVlan != null && !ok(s.onuVlan))) {
          await run(session, 'end')
          throw new CliError('Choose VLANs from 1 to 4094.')
        }
        await run(session, 'end')
        const now = await readTemplate(session, id)
        const fresh = templateFor(s)
        const oldPorts = now.iface.map((l) => /^service-port\s+(\d+)\s/i.exec(l)?.[1]).filter((n): n is string => !!n)
        const oldServices = now.mng.map((l) => /^service\s+(\S+)\s+gemport/i.exec(l)?.[1]).filter((n): n is string => !!n)

        await run(session, 'configure terminal')
        await must('interface ' + id, 'opening the ONU')
        for (const n of oldPorts) await must('no service-port ' + n, 'removing its old VLAN setting')
        await must(fresh.iface[fresh.iface.length - 1], 'putting it on VLAN ' + s.vlan)
        await must('exit', 'leaving the ONU')
        await must('pon-onu-mng ' + id, 'opening the ONU settings')
        for (const n of oldServices) await must('no service ' + n, 'removing its old service line')
        await must(fresh.mng[0], 'telling the ONU its VLAN')
        await must('exit', 'leaving the ONU settings')
        save = true
      } else {
        await must('interface ' + id, 'opening the ONU')
        const name = cliWord(action.name, 60)
        const description = cliWord(action.description, 120)
        if (name) await must('name ' + name, 'setting the name')
        if (description) await must('description ' + description, 'setting the description')
        save = true
      }

      await run(session, 'end')
      if (save) {
        session.send('write')
        await session.until(/\[OK\]|%Error|%Code/i, 'saving the configuration')
      }
    } finally {
      session.close()
    }
  },

  async planChange(target, creds, change): Promise<OltChangePlan> {
    const session = new TelnetSession(target)
    await session.open()
    try {
      await login(session, creds)
      await run(session, 'terminal length 0')
      return await planOne(session, change)
    } finally {
      session.close()
    }
  },

  async runCommands(target, creds, commands): Promise<number> {
    const session = new TelnetSession(target)
    await session.open()
    try {
      await login(session, creds)
      await run(session, 'terminal length 0')
      await run(session, 'configure terminal')
      let ran = 0
      for (const command of commands) {
        const out = await run(session, command)
        if (refused(out)) {
          const said = out.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? ''
          await run(session, 'end')
          throw new CliError('The OLT refused "' + command + '" after ' + ran + ' of ' + commands.length + ' commands: ' + said)
        }
        ran += 1
      }
      await run(session, 'end')
      session.send('write')
      await session.until(/\[OK\]|%Error|%Code/i, 'saving the configuration')
      return ran
    } finally {
      session.close()
    }
  },

  async learnSetup(target, creds, port): Promise<LearnedSetup | null> {
    if (!/^gpon-olt_\d+\/\d+\/\d+$/.test(port)) return null
    const session = new TelnetSession(target)
    await session.open()
    try {
      await login(session, creds)
      await run(session, 'terminal length 0')
      const found = await learnOnPort(session, port)
      if (!found) return null
      const { template, ...rest } = found
      return { ...rest, lines: [...template.iface, ...template.mng] }
    } finally {
      session.close()
    }
  },

  async authorise(target, creds, items, vlan): Promise<OltAuthoriseResult[]> {
    const session = new TelnetSession(target)
    await session.open()
    try {
      await login(session, creds)
      await run(session, 'terminal length 0')
      await prepare(session)

      // The slots already taken on each port, read once and then kept up to
      // date here, so two ONUs on one port in the same batch get two numbers.
      const taken = new Map<string, Set<number>>()
      // What the working ONUs on each port look like, read once per port.
      const learned = new Map<string, Awaited<ReturnType<typeof learnOnPort>>>()
      const results: OltAuthoriseResult[] = []
      for (const item of items) {
        if (!/^gpon-olt_\d+\/\d+\/\d+$/.test(item.port) || !SERIAL.test(item.sn)) {
          results.push({ sn: item.sn, port: item.port, ok: false, error: 'Not a valid port and serial number.' })
          continue
        }
        let used = taken.get(item.port)
        if (!used) {
          used = new Set(parseBaseInfo(await run(session, 'show gpon onu baseinfo ' + item.port)).keys())
          taken.set(item.port, used)
        }
        let index = 0
        for (let i = 1; i <= 128; i += 1) {
          if (!used.has(i)) {
            index = i
            break
          }
        }
        if (!index) {
          results.push({ sn: item.sn, port: item.port, ok: false, error: 'That PON port is full (128 ONUs).' })
          continue
        }
        // LEARN, OR FALL BACK TO WHAT ISPMAN ALWAYS DID. A port with nothing
        // working on it yet has nothing to copy: untagged on the OLT's VLAN.
        let template: Template
        let setup: OnuServiceSetup
        let learnedFrom: string | undefined
        const choice = item.setup ?? { onuVlan: null, vlan }
        if (choice === 'learn') {
          if (!learned.has(item.port)) learned.set(item.port, await learnOnPort(session, item.port))
          const copy = learned.get(item.port)
          if (copy) {
            template = copy.template
            setup = { onuVlan: copy.onuVlan, vlan: copy.vlan, upProfile: copy.upProfile }
            learnedFrom = copy.from
          } else {
            setup = { onuVlan: null, vlan }
            template = templateFor(setup)
          }
        } else {
          setup = choice
          template = templateFor(choice)
        }

        const problem = await authoriseOne(session, item.port, index, item.sn.toUpperCase(), template)
        if (problem) {
          results.push({ sn: item.sn, port: item.port, ok: false, error: problem })
        } else {
          used.add(index)
          results.push({
            sn: item.sn,
            port: item.port,
            ok: true,
            id: item.port.replace('gpon-olt_', 'gpon-onu_') + ':' + index,
            setup,
            learnedFrom,
          })
        }
      }

      // Saved once at the end, not per ONU: a save takes several seconds and
      // an OLT that loses power before it would simply have the ONUs waiting
      // to be authorised again.
      if (results.some((r) => r.ok)) {
        session.send('write')
        await session.until(/\[OK\]|%Error|%Code/i, 'saving the configuration')
      }
      return results
    } finally {
      session.close()
    }
  },
}
