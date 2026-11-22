import 'server-only'

import { CliError, TelnetSession } from '@/lib/olt/telnet'
import type {
  OltAuthoriseResult, OltDriver, OltInfo, OltLogin, OltOnu, OltOnuDetail, OltOnuLists,
  OltPendingOnu, OltPonPort,
} from '@/lib/olt/types'

/**
 * C-Data GPON OLTs (FD1601S, FD1604, FD1608, FD1616) over their command line.
 *
 * WHERE THIS COMES FROM. The command names were found on a real FD1601S
 * (firmware V3.1.22) over its console: `enable`, `config`, `interface gpon
 * 0/0`, `show ont info <port> all`, `show ont autofind all`, `show mac-address
 * all`, `ont-line-profile gpon profile-id 0`, `save`. What each one PRINTS was
 * not kept from that session, so every reading here is taken by what a field
 * looks like — a serial number, "online", a dBm figure — and is to be checked
 * against the unit once it is connected.
 *
 * HOW C-DATA DIFFERS, which is why this is its own module:
 *
 *   - ONUs ARE ADDED BY THE OLT ITSELF. Out of the box it accepts any ONU that
 *     connects and puts it on line profile 0 and service profile 0. So there is
 *     usually nothing waiting to be authorized, and Authorize is only needed
 *     where the owner has switched that off.
 *   - THE VLAN IS A PORT SETTING, NOT AN ONU SETTING. Which VLAN customer
 *     traffic rides is decided once, on the fibre port and the uplink ports
 *     and in line profile 0. The VLAN chosen on the Authorize screen is
 *     therefore not applied here; the ONU gets whatever the OLT is set up for.
 *   - Every ONU command lives inside `interface gpon 0/0` and names the PON
 *     port and then the ONU's number: `show ont info 1 3`.
 *
 * An ONU is written "0/0/1:3": PON port 1, ONU 3.
 */

const PROMPT = /(?:^|[\r\n])[^\r\n (]{1,40}(?:\([^\r\n)]{1,60}\))?[>#] ?$/
const MORE = /--\s*More[^\r\n]*$/i
const ASKS_MORE_WORDS = /\}:\s*$/
const ASKS_YES_NO = /\(y\/n\)\s*(?:\[[yn]\])?\s*:?\s*$/i
const STOPS = new RegExp(
  '(' + [MORE.source, ASKS_MORE_WORDS.source, ASKS_YES_NO.source, PROMPT.source].join('|') + ')',
  'i'
)

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
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\b]+/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => !/--\s*More/i.test(l))
  return lines.slice(1, -1).join('\n')
}

const refused = (text: string) => /^\s*%|Unknown command|Failure|Error:|Invalid|\^\s*$/im.test(text)

async function login(session: TelnetSession, creds: OltLogin): Promise<void> {
  await session.until(/(User ?name|Username|Login)\s*:/i, 'waiting for the login prompt')
  session.send(creds.user)
  await session.until(/password\s*:/i, 'waiting for the password prompt')
  session.send(creds.password)
  const after = await session.until(/((User ?name|Username|Login)\s*:|invalid|incorrect|fail|[>#] ?$)/i, 'logging in')
  if (!/[>#] ?$/.test(after)) throw new CliError('The OLT refused that username and password.')
  if (/> ?$/.test(after)) {
    session.send('enable')
    const step = await session.until(/(password\s*:|[>#] ?$)/i, 'entering enable mode')
    if (/password\s*:/i.test(step)) {
      session.send(creds.enablePassword ?? creds.password)
      const done = await session.until(/(password\s*:|[>#] ?$)/i, 'entering enable mode')
      if (!/# ?$/.test(done)) throw new CliError('The OLT refused the enable password.')
    }
  }
  await run(session, 'config')
}

const SERIAL = /^[A-Za-z0-9]{4}[0-9A-Fa-f]{8}$/
const SERIAL_HEX = /^[0-9A-Fa-f]{16}$/

/** A serial number as printed on the label, from either way an OLT writes it. */
function asSerial(token: string): string | null {
  if (SERIAL.test(token)) return token.toUpperCase()
  if (!SERIAL_HEX.test(token)) return null
  const vendor = (token.slice(0, 8).match(/.{2}/g) ?? []).map((h) => String.fromCharCode(parseInt(h, 16))).join('')
  return /^[A-Za-z0-9]{4}$/.test(vendor) ? (vendor + token.slice(8)).toUpperCase() : null
}

/** How many PON ports the box has, from its model: FD1601S → 1, FD1608 → 8. */
function ponCount(version: string): number {
  const m = /FD16(\d{2})/i.exec(version)
  const n = m ? Number(m[1]) : 0
  return n >= 1 && n <= 16 ? n : 1
}

/**
 * `show ont info <port> all`: one row per ONU. Read as: the ONU's number is
 * the last small number before its serial, and the row says "online" or
 * "offline" somewhere after it.
 */
function parseOnus(port: number, text: string): OltOnu[] {
  const out: OltOnu[] = []
  if (refused(text)) return out
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/)
    const at = fields.findIndex((f) => asSerial(f) !== null)
    if (at < 1) continue
    const numbers = fields.slice(0, at).filter((f) => /^\d{1,3}$/.test(f))
    if (numbers.length === 0) continue
    const index = Number(numbers[numbers.length - 1])
    const rest = fields.slice(at + 1).join(' ').toLowerCase()
    const online = /\bonline\b/.test(rest)
    const cause = /(dying-?gasp|los[a-z]*|lofi|deactiv\w*)/i.exec(rest)?.[1]
    out.push({
      id: '0/0/' + port + ':' + index,
      port: '0/0/' + port,
      index,
      type: null,
      sn: asSerial(fields[at]),
      phase: online ? 'working' : cause ?? 'offline',
      online,
      rx: null,
      tx: null,
      macs: [],
      disabled: /\bdeactiv/.test(rest),
    })
  }
  return out
}

/** `show ont autofind all`: any line or block carrying a serial number and a port. */
function parsePending(text: string, ports: number): OltPendingOnu[] {
  const out: OltPendingOnu[] = []
  if (refused(text)) return out
  const seen = new Set<string>()
  // Block form (one field per line) and table form (one ONU per line) both
  // put the port and the serial close together; walk line by line and carry
  // the last port seen.
  let port: number | null = ports === 1 ? 1 : null
  let model: string | null = null
  for (const line of text.split('\n')) {
    const ref = /\b0\s*\/\s*0\s*\/\s*(\d+)\b/.exec(line) ?? /\bF\/S\/P\s*:\s*\d+\/\d+\/(\d+)/i.exec(line)
    if (ref) port = Number(ref[1])
    const eq = /(Equipment-?ID|Model)\s*:\s*(\S+)/i.exec(line)
    if (eq) model = eq[2]
    for (const token of line.trim().split(/[\s()]+/)) {
      const sn = asSerial(token)
      if (!sn || seen.has(sn) || port === null) continue
      seen.add(sn)
      out.push({ port: '0/0/' + port, sn, model })
      model = null
    }
  }
  return out
}

/** A row of light levels: the ONU's number, then its receive level, then others. */
function parseOptical(text: string): Map<number, { rx: number | null; oltRx: number | null }> {
  const out = new Map<number, { rx: number | null; oltRx: number | null }>()
  if (refused(text)) return out
  for (const line of text.split('\n')) {
    const m = /^\s*(?:\d+\/\d+\s+\d+\s+)?(\d{1,3})\s+(-?\d+\.\d+)(?:\s+(-?\d+\.\d+))?(?:\s+(-?\d+\.\d+))?/.exec(line)
    if (!m) continue
    out.set(Number(m[1]), { rx: Number.parseFloat(m[2]), oltRx: m[4] ? Number.parseFloat(m[4]) : null })
  }
  return out
}

/** `show mac-address all`: an address, and on the same line the PON port and ONU it came in on. */
function parseMacs(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  if (refused(text)) return out
  for (const line of text.split('\n')) {
    const mac = /\b([0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}|[0-9a-f]{4}[.-][0-9a-f]{4}[.-][0-9a-f]{4})\b/i.exec(line)
    const where = /gpon\s*0\/0\/(\d+)\D+?(\d{1,3})\b/i.exec(line) ?? /\b0\/0\/(\d+):(\d+)/.exec(line)
    if (!mac || !where) continue
    const hex = mac[1].replace(/[^0-9a-f]/gi, '').toUpperCase()
    const pretty = (hex.match(/.{2}/g) ?? []).join(':')
    const id = '0/0/' + where[1] + ':' + where[2]
    const list = out.get(id) ?? []
    if (!list.includes(pretty)) list.push(pretty)
    out.set(id, list)
  }
  return out
}

async function readAll(session: TelnetSession, ports: number): Promise<{ onus: OltOnu[]; pending: OltPendingOnu[] }> {
  const macs = parseMacs(await run(session, 'show mac-address all'))
  await run(session, 'interface gpon 0/0')
  const pending = parsePending(await run(session, 'show ont autofind all'), ports)
  const onus: OltOnu[] = []
  for (let port = 1; port <= ports; port += 1) {
    const here = parseOnus(port, await run(session, 'show ont info ' + port + ' all'))
    if (here.some((o) => o.online)) {
      const light = parseOptical(await run(session, 'show ont optical-info ' + port + ' all'))
      for (const o of here) {
        const reading = light.get(o.index)
        if (reading) {
          o.rx = reading.rx
          o.tx = reading.oltRx
        }
      }
    }
    for (const o of here) o.macs = macs.get(o.id) ?? []
    onus.push(...here)
  }
  await run(session, 'exit')
  return { onus, pending }
}

const ONU_ID = /^0\/0\/(\d+):(\d+)$/
const PORT = /^0\/0\/(\d+)$/

const word = (raw: string, max: number) =>
  raw.trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9._@#/-]/g, '').slice(0, max)

const lastLine = (text: string) => text.trim().split('\n').pop()?.trim() || 'The OLT refused that.'

export const cdata: OltDriver = {
  brand: 'cdata',
  label: 'C-Data FD1601S / FD1604 / FD1608 / FD1616',

  async inspect(target, creds): Promise<OltInfo> {
    const session = new TelnetSession(target)
    await session.open()
    try {
      await login(session, creds)
      const version = await run(session, 'show version')
      const ports = ponCount(version)
      const { onus, pending } = await readAll(session, ports)
      const ponPorts: OltPonPort[] = []
      for (let p = 1; p <= ports; p += 1) {
        const here = onus.filter((o) => o.port === '0/0/' + p)
        ponPorts.push({
          name: '0/0/' + p,
          enabled: true,
          up: here.some((o) => o.online),
          description: null,
          capacity: null,
          registered: here.length,
          inBps: null,
          outBps: null,
        })
      }
      const pick = (label: RegExp) => new RegExp(label.source + '[^:\\n]*:\\s*(.+)', 'i').exec(version)?.[1]?.trim() ?? null
      return {
        name: null,
        model: /\b(FD16\d{2}[A-Za-z0-9-]*)/i.exec(version)?.[1] ?? pick(/(Product|Model|Device)/) ?? 'C-Data GPON OLT',
        version: pick(/(Software|Firmware)\s*version/) ?? /\b(V\d+\.\d+\.\d+\S*)/.exec(version)?.[1] ?? null,
        uptime: pick(/Up\s*time/),
        cards: [],
        uplinks: [],
        ponPorts,
        vlans: [],
        onus: { authorised: onus.length, unauthorised: pending.length, offline: onus.filter((o) => !o.online).length },
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
      return await readAll(session, ponCount(await run(session, 'show version')))
    } finally {
      session.close()
    }
  },

  async onuDetail(target, creds, id): Promise<OltOnuDetail> {
    const m = ONU_ID.exec(id)
    if (!m) throw new CliError('That is not an ONU on this OLT.')
    const [, p, n] = m
    const session = new TelnetSession(target)
    await session.open()
    try {
      await login(session, creds)
      await run(session, 'interface gpon 0/0')
      const list = parseOnus(Number(p), await run(session, 'show ont info ' + p + ' all')).find((o) => o.index === Number(n))
      const info = await run(session, 'show ont info ' + p + ' ' + n)
      const version = await run(session, 'show ont version ' + p + ' ' + n)
      const optical = await run(session, 'show ont optical-info ' + p + ' ' + n)
      await run(session, 'exit')

      const field = (text: string, label: RegExp): string | null => {
        const v = new RegExp('^\\s*' + label.source + '[^:\\n]*:[ \\t]*(.*)$', 'im').exec(text)?.[1]?.trim()
        return v && v !== '-' && v !== 'N/A' ? v : null
      }
      const level = (label: RegExp): number | null => {
        const v = Number.parseFloat(field(optical, label) ?? '')
        return Number.isFinite(v) ? v : null
      }
      const up = field(info, /Last up time/)
      return {
        id,
        name: field(info, /(Description|Name)/),
        description: null,
        type: field(version, /Equipment-?ID/) ?? field(info, /Equipment-?ID/),
        sn: list?.sn ?? asSerial((field(info, /SN/) ?? '').split(/[\s(]/)[0]),
        phase: list?.phase ?? 'unknown',
        online: list?.online ?? /online/i.test(field(info, /Run state/) ?? ''),
        distance: field(info, /distance/),
        onlineFor: field(info, /online duration/),
        onuRx: level(/Rx optical power/),
        onuTx: level(/Tx optical power/),
        oltRx: level(/OLT Rx/),
        oltTx: null,
        vendor: field(version, /Vendor-?ID/),
        model: field(version, /Equipment-?ID/) ?? field(info, /Equipment-?ID/),
        firmware: field(version, /(Main )?Software Version/),
        history: up ? [{ up, down: field(info, /Last down time/), cause: field(info, /Last down cause/) }] : [],
        disabled: list?.disabled ?? false,
      }
    } finally {
      session.close()
    }
  },

  async onuAction(target, creds, id, action): Promise<void> {
    const m = ONU_ID.exec(id)
    if (!m) throw new CliError('That is not an ONU on this OLT.')
    const [, p, n] = m
    const session = new TelnetSession(target)
    await session.open()
    try {
      await login(session, creds)
      await run(session, 'interface gpon 0/0')
      const out =
        action.kind === 'reboot'
          ? await run(session, 'ont reboot ' + p + ' ' + n)
          : action.kind === 'disable'
            ? await run(session, 'ont deactivate ' + p + ' ' + n)
            : action.kind === 'enable'
              ? await run(session, 'ont activate ' + p + ' ' + n)
              : action.kind === 'remove'
                ? await run(session, 'ont delete ' + p + ' ' + n)
                : await run(session, 'ont description ' + p + ' ' + n + ' ' + (word(action.name || action.description, 60) || 'ONU'))
      await run(session, 'exit')
      if (refused(out)) throw new CliError(lastLine(out))
      if (action.kind !== 'reboot') await run(session, 'save')
    } finally {
      session.close()
    }
  },

  /**
   * Only needed where automatic adding has been switched off on the OLT. The
   * ONU goes on line profile 0 and service profile 0, the same pair the OLT
   * uses when it adds one itself. The VLAN is not applied: on this brand it
   * is a port setting (see the top of this file).
   */
  async authorise(target, creds, items): Promise<OltAuthoriseResult[]> {
    const session = new TelnetSession(target)
    await session.open()
    try {
      await login(session, creds)
      await run(session, 'interface gpon 0/0')
      const results: OltAuthoriseResult[] = []
      for (const item of items) {
        const p = PORT.exec(item.port)
        if (!p || !SERIAL.test(item.sn)) {
          results.push({ sn: item.sn, port: item.port, ok: false, error: 'Not a valid port or serial number.' })
          continue
        }
        const taken = new Set(parseOnus(Number(p[1]), await run(session, 'show ont info ' + p[1] + ' all')).map((o) => o.index))
        let n = 1
        while (taken.has(n) && n < 128) n += 1
        const out = await run(
          session,
          'ont add ' + p[1] + ' ' + n + ' sn-auth ' + item.sn + ' ont-lineprofile-id 0 ont-srvprofile-id 0'
        )
        results.push(
          refused(out)
            ? { sn: item.sn, port: item.port, ok: false, error: lastLine(out) }
            : { sn: item.sn, port: item.port, ok: true, id: item.port + ':' + n }
        )
      }
      await run(session, 'exit')
      if (results.some((r) => r.ok)) await run(session, 'save')
      return results
    } finally {
      session.close()
    }
  },
}
