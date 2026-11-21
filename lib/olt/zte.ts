import 'server-only'

import { CliError, TelnetSession } from '@/lib/olt/telnet'
import type {
  OltAuthoriseResult, OltCard, OltDriver, OltInfo, OltLogin, OltOnu, OltOnuLists, OltPendingOnu,
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
async function run(session: TelnetSession, command: string): Promise<string> {
  session.send(command)
  const raw = await session.until(PROMPT, 'running "' + command + '"')
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

/** The PON ports worth asking about: on a PON card that is actually running. */
function livePonPorts(cards: OltCard[]): string[] {
  const ports: string[] = []
  for (const card of cards) {
    const type = (card.actual ?? card.configured).toUpperCase()
    if (!type.startsWith('GT') || card.status !== 'INSERVICE') continue
    for (let p = 1; p <= Math.min(card.ports ?? 0, 32); p += 1) ports.push('gpon-olt_1/' + card.slot + '/' + p)
  }
  return ports
}

async function readOnusOnPort(session: TelnetSession, port: string): Promise<OltOnu[]> {
  const base = parseBaseInfo(await run(session, 'show gpon onu baseinfo ' + port))
  if (base.size === 0) return []
  const states = parseStates(await run(session, 'show gpon onu state ' + port))
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
  vlan: number
): Promise<string | null> {
  const onu = port.replace('gpon-olt_', 'gpon-onu_') + ':' + index
  const steps: [string, string][] = [
    ['interface ' + port, ''],
    ['onu ' + index + ' type ' + ONU_TYPE + ' sn ' + sn, 'registering it on the port'],
    ['exit', ''],
    ['interface ' + onu, ''],
    ['tcont 1 profile ' + UP_PROFILE, 'setting its upstream profile'],
    ['gemport 1 tcont 1', 'creating its data channel'],
    ['service-port 1 vport 1 user-vlan untagged vlan ' + vlan, 'putting it on VLAN ' + vlan],
    ['exit', ''],
    ['pon-onu-mng ' + onu, ''],
    ['service 1 gemport 1', 'telling the ONU which channel to use'],
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
            if (!refused(text)) uplinks.push(parseUplink(name, text))
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

      return { name, model, version, uptime, cards, uplinks, ponPorts, vlans, onus }
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
        const problem = await authoriseOne(session, item.port, index, item.sn.toUpperCase(), vlan)
        if (problem) {
          results.push({ sn: item.sn, port: item.port, ok: false, error: problem })
        } else {
          used.add(index)
          results.push({
            sn: item.sn,
            port: item.port,
            ok: true,
            id: item.port.replace('gpon-olt_', 'gpon-onu_') + ':' + index,
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
