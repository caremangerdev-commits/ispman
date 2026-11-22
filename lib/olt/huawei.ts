import 'server-only'

import { CliError, TelnetSession } from '@/lib/olt/telnet'
import type {
  OltAuthoriseResult, OltCard, OltDriver, OltInfo, OltLogin, OltOnu, OltOnuDetail, OltOnuLists,
  OltPendingOnu, OltPonPort,
} from '@/lib/olt/types'

/**
 * Huawei SmartAX (MA5608T, MA5683T, MA5800) over its command line.
 *
 * WRITTEN FROM PUBLISHED COMMAND REFERENCES, NOT AGAINST A REAL UNIT. Unlike
 * the ZTE module, nothing here has been run on a Huawei OLT. The commands are
 * the long-standing documented ones and the layouts are the ones Huawei's own
 * guides and operators' write-ups show, but a firmware that words something
 * differently will only be found by connecting one. Every reading is therefore
 * taken by what a field looks like (a serial number, "online", a dBm figure)
 * rather than by its column, and anything not recognised is left empty rather
 * than guessed.
 *
 * HOW HUAWEI DIFFERS FROM ZTE, which is why this is its own module:
 *
 *   - An ONU is addressed as frame/slot/port and a number, e.g. 0/1/3 ONT 12.
 *     Here that is written "0/1/3:12".
 *   - The command line stops to ask for optional words ("{ <cr>|... }:") and
 *     to page long output. `undo smart` and `scroll 512` turn both off, and
 *     the reader below still answers either if it appears.
 *   - Service for an ONU needs two profiles to exist first, and a separate
 *     "service port" that joins the ONU to a VLAN.
 */

const PROMPT = /(?:^|[\r\n])[^\r\n (]{1,40}(?:\([^\r\n)]{1,60}\))?[>#] ?$/
const MORE = /---- More[^\r\n]*----[^\r\n]*$/
const ASKS_MORE_WORDS = /\}:\s*$/
const ASKS_YES_NO = /\(y\/n\)\s*\[[yn]\]\s*:\s*$/i
const STOPS = new RegExp(
  '(' + [MORE.source, ASKS_MORE_WORDS.source, ASKS_YES_NO.source, PROMPT.source].join('|') + ')',
  'i'
)

async function login(session: TelnetSession, creds: OltLogin): Promise<void> {
  await session.until(/User name:/i, 'waiting for the login prompt')
  session.send(creds.user)
  await session.until(/User password:/i, 'waiting for the password prompt')
  session.send(creds.password)
  const after = await session.until(/(User name:|invalid|locked|[>#] ?$)/i, 'logging in')
  if (!/[>#] ?$/.test(after)) throw new CliError('The OLT refused that username and password.')
  if (/> ?$/.test(after)) {
    session.send('enable')
    await session.until(/[>#] ?$/, 'entering enable mode')
  }
  await run(session, 'undo smart')
  await run(session, 'scroll 512')
}

/**
 * Runs one command and returns what it printed. Answers the three ways this
 * command line stops before it is finished: a page break (send a space), a
 * request for optional words (send Enter), and "are you sure" (yes — every
 * command sent from here is one a person has already confirmed on screen).
 */
async function run(session: TelnetSession, command: string): Promise<string> {
  session.send(command)
  let out = ''
  for (let i = 0; i < 400; i += 1) {
    const chunk = await session.until(STOPS, 'running "' + command + '"')
    out += chunk
    if (MORE.test(chunk)) session.send(' ')
    else if (ASKS_YES_NO.test(chunk)) session.send('y')
    else if (ASKS_MORE_WORDS.test(chunk)) session.send('')
    else break
  }
  const lines = out
    // The page-break line is erased on screen with cursor codes; drop both.
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => !/---- More/.test(l))
  return lines.slice(1, -1).join('\n')
}

const failed = (text: string) => /Failure:|% Unknown command|% Parameter error|% Incomplete command|\^\s*$/m.test(text)

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

/** How many PON ports a GPON board has, from its name. Unknown boards are asked instead. */
function ponPortsOf(board: string): number {
  const b = board.toUpperCase()
  if (/GP[FH]D|GPSF|GPHF|GPUF|XGHD|XGSF/.test(b)) return 16
  if (/GPBD|GPBH|XGBD|GPLF/.test(b)) return 8
  return /GP|XG/.test(b) ? 8 : 0
}

/**
 * `display board 0`:
 *
 *   SlotID  BoardName  Status          SubType0 SubType1    Online/Offline
 *   0       H806GPBD   Normal
 *   2       H801MCUD   Active_normal   CPCA
 */
function parseBoards(text: string): OltCard[] {
  const cards: OltCard[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(H\w+)\s+(\S+)/.exec(line)
    if (!m) continue
    const status = m[3]
    const ports = ponPortsOf(m[2])
    cards.push({
      slot: Number(m[1]),
      configured: m[2],
      actual: /normal/i.test(status) ? m[2] : null,
      ports: ports || null,
      software: null,
      // The pages show a card as working on INSERVICE or STANDBY.
      status: /^normal$|active_normal/i.test(status) ? 'INSERVICE' : /standby/i.test(status) ? 'STANDBY' : status.toUpperCase(),
    })
  }
  return cards
}

const SN_HEX = /\b([0-9A-F]{16})\b/
const SN_TEXT = /\(([A-Za-z0-9]{4})-?([0-9A-Fa-f]{8})\)/

/** A serial number in the 12-character form printed on the label: HWTCB0704FD7. */
function serialOf(text: string): string | null {
  const named = SN_TEXT.exec(text)
  if (named) return (named[1] + named[2]).toUpperCase()
  const hex = SN_HEX.exec(text)
  if (!hex) return null
  const vendor = (hex[1].slice(0, 8).match(/.{2}/g) ?? []).map((h) => String.fromCharCode(parseInt(h, 16))).join('')
  return /^[A-Za-z0-9]{4}$/.test(vendor) ? (vendor + hex[1].slice(8)).toUpperCase() : hex[1]
}

/**
 * `display ont autofind all`, one block per ONU:
 *
 *   Number              : 1
 *   F/S/P               : 0/1/0
 *   Ont SN              : 48575443B0704FD7 (HWTC-B0704FD7)
 *   Ont EquipmentID     : HG8546M
 */
function parseAutofind(text: string): OltPendingOnu[] {
  const out: OltPendingOnu[] = []
  for (const block of text.split(/^\s*Number\s*:/m).slice(1)) {
    const port = /F\/S\/P\s*:\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/.exec(block)
    const snLine = /Ont SN\s*:\s*(.+)/i.exec(block)?.[1] ?? ''
    const sn = serialOf(snLine)
    if (!port || !sn) continue
    out.push({
      port: port[1] + '/' + port[2] + '/' + port[3],
      sn,
      model: /Ont EquipmentID\s*:\s*(\S+)/i.exec(block)?.[1] ?? null,
    })
  }
  return out
}

/**
 * `display ont info summary 0/1`: for each port, two tables keyed by ONT id.
 *
 *   In port 0/ 1/0, the total of ONTs are: 2, online: 2
 *   ONT  Run     Last                Last                Last
 *   ID   State   UpTime              DownTime            DownCause
 *   0    online  2026-01-01 10:00:00 -                   -
 *   ONT        SN        Type          Distance Rx/Tx power  Description
 *   ID                                    (m)      (dBm)
 *   0   48575443B0704FD7 HG8546M       2040     -19.51/2.31  House-12
 */
function parseSummary(text: string): OltOnu[] {
  const onus = new Map<string, OltOnu>()
  let port: string | null = null
  for (const line of text.split('\n')) {
    const head = /In port\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/i.exec(line)
    if (head) {
      port = head[1] + '/' + head[2] + '/' + head[3]
      continue
    }
    if (!port) continue
    const row = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!row) continue
    const index = Number(row[1])
    const id = port + ':' + index
    const onu: OltOnu = onus.get(id) ?? { id, port, index, type: null, sn: null, phase: 'unknown', online: false, rx: null, tx: null, macs: [] }
    const rest = row[2]
    const state = /^(online|offline)\b/i.exec(rest)
    if (state) {
      onu.online = state[1].toLowerCase() === 'online'
      const cause = /(dying-gasp|LOS[A-Za-z]*|LOFi|deactive|reset)\S*\s*$/i.exec(rest)?.[1]
      onu.phase = onu.online ? 'working' : cause ?? 'offline'
    } else if (SN_HEX.test(rest)) {
      onu.sn = serialOf(rest)
      const fields = rest.trim().split(/\s+/)
      onu.type = fields[1] && !/^\d+$/.test(fields[1]) && fields[1] !== '-' ? fields[1] : null
      const power = /(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/.exec(rest)
      if (power) onu.rx = Number.parseFloat(power[1])
    } else {
      continue
    }
    onus.set(id, onu)
  }
  return [...onus.values()]
}

/** `display mac-address port F/S/P`: the address, then F /S /P, then the ONT id. */
function parseMacs(text: string): Map<number, string[]> {
  const out = new Map<number, string[]>()
  for (const line of text.split('\n')) {
    const m = /([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4}).*?\d+\s*\/\s*\d+\s*\/\s*\d+\s+(\d+)/i.exec(line)
    if (!m) continue
    const mac = ((m[1] + m[2] + m[3]).toUpperCase().match(/.{2}/g) ?? []).join(':')
    const list = out.get(Number(m[4])) ?? []
    if (!list.includes(mac)) list.push(mac)
    out.set(Number(m[4]), list)
  }
  return out
}

/**
 * `display ont optical-info <port> all`, inside the board's interface: one row
 * per ONT with its receive level, send level, and the level the OLT receives.
 */
function parseOptical(text: string): Map<number, { rx: number | null; oltRx: number | null }> {
  const out = new Map<number, { rx: number | null; oltRx: number | null }>()
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)/.exec(line)
    if (m) out.set(Number(m[1]), { rx: Number.parseFloat(m[2]), oltRx: Number.parseFloat(m[4]) })
  }
  return out
}

async function readOnus(session: TelnetSession, cards: OltCard[]): Promise<OltOnu[]> {
  const all: OltOnu[] = []
  for (const card of cards) {
    if (!card.ports) continue
    const onus = parseSummary(await run(session, 'display ont info summary 0/' + card.slot))
    if (onus.length === 0) continue
    const ports = [...new Set(onus.filter((o) => o.online).map((o) => o.port))]
    if (ports.length) {
      await run(session, 'config')
      await run(session, 'interface gpon 0/' + card.slot)
      for (const port of ports) {
        const optical = parseOptical(await run(session, 'display ont optical-info ' + port.split('/')[2] + ' all'))
        for (const o of onus) {
          if (o.port !== port) continue
          const reading = optical.get(o.index)
          if (reading) {
            o.rx = reading.rx ?? o.rx ?? null
            o.tx = reading.oltRx
          }
        }
      }
      await run(session, 'quit')
      await run(session, 'quit')
      for (const port of ports) {
        const macs = parseMacs(await run(session, 'display mac-address port ' + port))
        for (const o of onus) if (o.port === port) o.macs = macs.get(o.index) ?? []
      }
    }
    all.push(...onus)
  }
  return all.sort((a, b) => a.port.localeCompare(b.port) || a.index - b.index)
}

/* -------------------------------------------------------------------------- */
/* Authorising                                                                */
/* -------------------------------------------------------------------------- */

const DBA = 'ISPMAN-UP'
const profileName = (vlan: number) => 'ISPMAN-' + vlan

/**
 * The profiles an ONU needs, one pair per VLAN, created if missing. Each
 * command answers with a failure if the profile is already there, which is
 * the result wanted.
 *
 * FOR ONUs WITH VLAN SWITCHED OFF. The ONU's first Ethernet port is given the
 * VLAN as its native VLAN, so plain traffic from the customer is tagged as it
 * enters and untagged as it leaves. Nothing is set on the ONU by hand.
 */
async function prepare(session: TelnetSession, vlan: number): Promise<void> {
  await run(session, 'config')
  await run(session, 'dba-profile add profile-name ' + DBA + ' type4 max 1000000')
  await run(session, 'ont-lineprofile gpon profile-name ' + profileName(vlan))
  await run(session, 'tcont 1 dba-profile-name ' + DBA)
  await run(session, 'gem add 1 eth tcont 1')
  await run(session, 'gem mapping 1 0 vlan ' + vlan)
  await run(session, 'commit')
  await run(session, 'quit')
  await run(session, 'ont-srvprofile gpon profile-name ' + profileName(vlan))
  await run(session, 'ont-port eth adaptive pots adaptive')
  await run(session, 'port vlan eth 1 ' + vlan)
  await run(session, 'commit')
  await run(session, 'quit')
  await run(session, 'quit')
}

const PORT = /^(\d+)\/(\d+)\/(\d+)$/
const ONU_ID = /^(\d+)\/(\d+)\/(\d+):(\d+)$/

async function authoriseOne(
  session: TelnetSession,
  item: { port: string; sn: string },
  vlan: number
): Promise<OltAuthoriseResult> {
  const p = PORT.exec(item.port)
  if (!p || !/^[A-Za-z0-9]{12,16}$/.test(item.sn)) {
    return { sn: item.sn, port: item.port, ok: false, error: 'Not a valid port or serial number.' }
  }
  await run(session, 'config')
  await run(session, 'interface gpon ' + p[1] + '/' + p[2])
  const added = await run(
    session,
    'ont add ' + p[3] + ' sn-auth ' + item.sn + ' omci ont-lineprofile-name ' + profileName(vlan) +
      ' ont-srvprofile-name ' + profileName(vlan) + ' desc ISPMan'
  )
  const got = /ONT\s*ID\s*:\s*(\d+)/i.exec(added)
  if (!got) {
    await run(session, 'quit')
    await run(session, 'quit')
    const why = /Failure:\s*(.+)/.exec(added)?.[1]?.trim()
    return { sn: item.sn, port: item.port, ok: false, error: why ?? 'The OLT did not accept this ONU.' }
  }
  const index = got[1]
  await run(session, 'ont port native-vlan ' + p[3] + ' ' + index + ' eth 1 vlan ' + vlan + ' priority 0')
  await run(session, 'quit')
  const joined = await run(
    session,
    'service-port vlan ' + vlan + ' gpon ' + item.port + ' ont ' + index +
      ' gemport 1 multi-service user-vlan ' + vlan + ' tag-transform translate'
  )
  await run(session, 'quit')
  if (failed(joined)) {
    return {
      sn: item.sn,
      port: item.port,
      ok: false,
      id: item.port + ':' + index,
      error: 'Registered, but joining it to VLAN ' + vlan + ' was refused: ' + (/Failure:\s*(.+)/.exec(joined)?.[1]?.trim() ?? 'unknown reason'),
    }
  }
  return { sn: item.sn, port: item.port, ok: true, id: item.port + ':' + index }
}

/* -------------------------------------------------------------------------- */
/* One ONU                                                                    */
/* -------------------------------------------------------------------------- */

const real = (v: string | undefined | null): string | null => {
  const t = (v ?? '').trim()
  return t && t !== '-' && t !== 'ONT_NO_DESCRIPTION' ? t : null
}

async function readDetail(session: TelnetSession, id: string): Promise<OltOnuDetail> {
  const m = ONU_ID.exec(id)
  if (!m) throw new CliError('That is not an ONU on this OLT.')
  const [, f, s, p, n] = m
  const info = await run(session, 'display ont info ' + f + ' ' + s + ' ' + p + ' ' + n)
  const version = await run(session, 'display ont version ' + f + ' ' + s + ' ' + p + ' ' + n)
  await run(session, 'config')
  await run(session, 'interface gpon ' + f + '/' + s)
  const optical = await run(session, 'display ont optical-info ' + p + ' ' + n)
  await run(session, 'quit')
  await run(session, 'quit')

  const field = (text: string, label: string): string | null =>
    real(new RegExp('^\\s*' + label + '[^:\\n]*:[ \\t]*(.*)$', 'im').exec(text)?.[1])
  const level = (label: string): number | null => {
    const v = Number.parseFloat(field(optical, label) ?? '')
    return Number.isFinite(v) ? v : null
  }
  const online = /online/i.test(field(info, 'Run state') ?? '')
  const disabled = /deactiv/i.test(field(info, 'Control flag') ?? '')
  const up = field(info, 'Last up time')
  const distance = field(info, 'ONT distance')
  return {
    id,
    name: field(info, 'Description'),
    description: null,
    type: field(version, 'Equipment-ID') ?? field(version, 'ONT Version'),
    sn: serialOf(field(info, 'SN') ?? ''),
    phase: online ? 'working' : field(info, 'Last down cause') ?? 'offline',
    online,
    distance: distance ? distance + 'm' : null,
    onlineFor: field(info, 'ONT online duration'),
    onuRx: level('Rx optical power'),
    onuTx: level('Tx optical power'),
    oltRx: level('OLT Rx ONT optical power'),
    oltTx: null,
    vendor: field(version, 'Vendor-ID'),
    model: field(version, 'Equipment-ID'),
    firmware: field(version, 'Main Software Version'),
    history: up ? [{ up, down: field(info, 'Last down time'), cause: field(info, 'Last down cause') }] : [],
    disabled,
  }
}

const word = (raw: string, max: number) =>
  raw.trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9._@#/-]/g, '').slice(0, max)

export const huawei: OltDriver = {
  brand: 'huawei',
  label: 'Huawei MA5608T / MA5683T / MA5800 (not yet tested on a real unit)',

  async inspect(target, creds): Promise<OltInfo> {
    const session = new TelnetSession(target)
    await session.open()
    try {
      await login(session, creds)
      const version = await run(session, 'display version')
      const uptime = await run(session, 'display sysuptime')
      const cards = parseBoards(await run(session, 'display board 0'))
      const pending = parseAutofind(await run(session, 'display ont autofind all'))
      const onus = await readOnus(session, cards)

      const ponPorts: OltPonPort[] = []
      for (const card of cards) {
        for (let p = 0; p < (card.ports ?? 0); p += 1) {
          const name = '0/' + card.slot + '/' + p
          const here = onus.filter((o) => o.port === name)
          ponPorts.push({
            name,
            enabled: true,
            up: here.some((o) => o.online),
            description: null,
            capacity: null,
            registered: here.length,
            inBps: null,
            outBps: null,
          })
        }
      }
      return {
        name: null,
        model: /PRODUCT\s*:?\s*(\S+)/i.exec(version)?.[1] ?? null,
        version: /VERSION\s*:\s*(\S+)/i.exec(version)?.[1] ?? null,
        uptime: /System up time:\s*(.+)/i.exec(uptime)?.[1]?.trim() ?? null,
        cards,
        uplinks: [],
        ponPorts,
        vlans: [],
        onus: {
          authorised: onus.length,
          unauthorised: pending.length,
          offline: onus.filter((o) => !o.online).length,
        },
      }
    } finally {
      session.close()
    }
  },

  async listOnus(target, creds): Promise<OltOnuLists> {
    const session = new TelnetSession(target)
    await session.open()
    try {
      await login(session, creds)
      const cards = parseBoards(await run(session, 'display board 0'))
      const pending = parseAutofind(await run(session, 'display ont autofind all'))
      return { pending, onus: await readOnus(session, cards) }
    } finally {
      session.close()
    }
  },

  async onuDetail(target, creds, id): Promise<OltOnuDetail> {
    const session = new TelnetSession(target)
    await session.open()
    try {
      await login(session, creds)
      return await readDetail(session, id)
    } finally {
      session.close()
    }
  },

  async onuAction(target, creds, id, action): Promise<void> {
    if (action.kind === 'vsol-fix') throw new CliError('That setting is only for V-SOL ONUs on a GCOM OLT.')
    const m = ONU_ID.exec(id)
    if (!m) throw new CliError('That is not an ONU on this OLT.')
    const [, f, s, p, n] = m
    const session = new TelnetSession(target)
    await session.open()
    try {
      await login(session, creds)
      await run(session, 'config')
      if (action.kind === 'remove') {
        // An ONU cannot be deleted while a service port still points at it.
        const ports = await run(session, 'display service-port port ' + f + '/' + s + '/' + p + ' ont ' + n)
        for (const line of ports.split('\n')) {
          const index = /^\s*(\d+)\s+\d+\s/.exec(line)?.[1]
          if (index) await run(session, 'undo service-port ' + index)
        }
      }
      await run(session, 'interface gpon ' + f + '/' + s)
      const out =
        action.kind === 'reboot'
          ? await run(session, 'ont reset ' + p + ' ' + n)
          : action.kind === 'disable'
            ? await run(session, 'ont deactivate ' + p + ' ' + n)
            : action.kind === 'enable'
              ? await run(session, 'ont activate ' + p + ' ' + n)
          : action.kind === 'remove'
            ? await run(session, 'ont delete ' + p + ' ' + n)
            : await run(session, 'ont modify ' + p + ' ' + n + ' desc ' + (word(action.name || action.description, 60) || 'ONU'))
      await run(session, 'quit')
      await run(session, 'quit')
      if (failed(out)) throw new CliError(/Failure:\s*(.+)/.exec(out)?.[1]?.trim() ?? 'The OLT refused that.')
      if (action.kind !== 'reboot') await run(session, 'save')
    } finally {
      session.close()
    }
  },

  async authorise(target, creds, items, vlan): Promise<OltAuthoriseResult[]> {
    const session = new TelnetSession(target)
    await session.open()
    try {
      await login(session, creds)
      await prepare(session, vlan)
      const results: OltAuthoriseResult[] = []
      for (const item of items) results.push(await authoriseOne(session, item, vlan))
      if (results.some((r) => r.ok)) await run(session, 'save')
      return results
    } finally {
      session.close()
    }
  },
}
