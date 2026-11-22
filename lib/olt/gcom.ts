import 'server-only'

import { CliError, TelnetSession } from '@/lib/olt/telnet'
import type {
  OltAuthoriseResult, OltDriver, OltInfo, OltLogin, OltOnu, OltOnuDetail, OltOnuLists, OltPonPort,
} from '@/lib/olt/types'

/**
 * GCOM GPON OLTs ("OptiWay" command line) — READ ONLY FOR NOW.
 *
 * WHAT IS KNOWN, from one session on a real unit: it is reached over telnet,
 * logs in as `admin`, switches paging off with `screen-rows per-page 0`, and
 * answers `show ont brief` (the ONUs), `show interface brief` (the ports) and
 * `show mac-address-table` (what is behind them). ONU settings are made
 * through `ont group`, and an ONU needs its `device type` set before traffic
 * passes.
 *
 * WHAT IS NOT. The exact commands to add, restart or remove one ONU were not
 * worked out, and a guess sent to a live OLT is how customers go offline. So
 * this module lists ONUs and reads their state, and refuses to change
 * anything, saying so in plain words. The readings themselves are taken by
 * what a field looks like, to be checked against a unit.
 *
 * An ONU is written as the OLT writes its port, then the ONU's number:
 * "0/1:3".
 */

const PROMPT = /(?:^|[\r\n])[^\r\n (]{1,40}(?:\([^\r\n)]{1,60}\))?[>#] ?$/
const MORE = /--\s*More[^\r\n]*$/i
const STOPS = new RegExp('(' + MORE.source + '|' + PROMPT.source + ')', 'i')

const NOT_YET =
  'ISPMan can read a GCOM OLT but cannot change it yet. Make this change on the OLT itself for now.'

async function run(session: TelnetSession, command: string): Promise<string> {
  session.send(command)
  let out = ''
  for (let i = 0; i < 400; i += 1) {
    const chunk = await session.until(STOPS, 'running "' + command + '"')
    out += chunk
    if (!MORE.test(chunk)) break
    session.send(' ')
  }
  return out
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\b]+/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => !/--\s*More/i.test(l))
    .slice(1, -1)
    .join('\n')
}

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
      await session.until(/[>#] ?$/, 'entering enable mode')
    }
  }
  await run(session, 'screen-rows per-page 0')
}

const SERIAL = /^[A-Za-z0-9]{4}[0-9A-Fa-f]{8}$/

/** `show ont brief`: one ONU per line, found by its serial number. */
function parseOnus(text: string): OltOnu[] {
  const out: OltOnu[] = []
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/)
    const at = fields.findIndex((f) => SERIAL.test(f))
    if (at < 0) continue
    // The port and the ONU's number come before the serial, as "0/1:3",
    // "0/1/3", or a port and a separate number.
    const before = fields.slice(0, at).join(' ')
    const joined = /(\d+\/\d+)[:/](\d+)/.exec(before)
    const split = /(\d+\/\d+)\D+(\d+)/.exec(before)
    const ref = joined ?? split
    if (!ref) continue
    const rest = fields.slice(at + 1).join(' ').toLowerCase()
    const online = /\b(online|working|up)\b/.test(rest) && !/\boffline\b/.test(rest)
    const power = /(-\d+\.\d+)/.exec(rest)
    out.push({
      id: ref[1] + ':' + ref[2],
      port: ref[1],
      index: Number(ref[2]),
      type: null,
      sn: fields[at].toUpperCase(),
      phase: online ? 'working' : /(los|dying|power)/.exec(rest)?.[1] ?? 'offline',
      online,
      rx: power ? Number.parseFloat(power[1]) : null,
      tx: null,
      macs: [],
    })
  }
  return out.sort((a, b) => a.port.localeCompare(b.port) || a.index - b.index)
}

export const gcom: OltDriver = {
  brand: 'gcom',
  label: 'GCOM GPON OLT (view only for now)',

  async inspect(target, creds): Promise<OltInfo> {
    const session = new TelnetSession(target)
    await session.open()
    try {
      await login(session, creds)
      const version = await run(session, 'show version')
      const onus = parseOnus(await run(session, 'show ont brief'))
      const ports = [...new Set(onus.map((o) => o.port))]
      const ponPorts: OltPonPort[] = ports.map((name) => {
        const here = onus.filter((o) => o.port === name)
        return {
          name,
          enabled: true,
          up: here.some((o) => o.online),
          description: null,
          capacity: null,
          registered: here.length,
          inBps: null,
          outBps: null,
        }
      })
      const pick = (label: RegExp) => new RegExp(label.source + '[^:\\n]*:\\s*(.+)', 'i').exec(version)?.[1]?.trim() ?? null
      return {
        name: null,
        model: pick(/(Product|Model|Device|Hardware)\s*(name|type|model)?/) ?? 'GCOM GPON OLT',
        version: pick(/(Software|Firmware)\s*version/),
        uptime: pick(/Up\s*time/),
        cards: [],
        uplinks: [],
        ponPorts,
        vlans: [],
        onus: { authorised: onus.length, unauthorised: 0, offline: onus.filter((o) => !o.online).length },
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
      return { pending: [], onus: parseOnus(await run(session, 'show ont brief')) }
    } finally {
      session.close()
    }
  },

  async onuDetail(target, creds, id): Promise<OltOnuDetail> {
    const session = new TelnetSession(target)
    await session.open()
    try {
      await login(session, creds)
      const onu = parseOnus(await run(session, 'show ont brief')).find((o) => o.id === id)
      if (!onu) throw new CliError('That ONU is no longer on the OLT.')
      return {
        id,
        name: null,
        description: null,
        type: null,
        sn: onu.sn,
        phase: onu.phase,
        online: onu.online,
        distance: null,
        onlineFor: null,
        onuRx: onu.rx ?? null,
        onuTx: null,
        oltRx: null,
        oltTx: null,
        vendor: null,
        model: null,
        firmware: null,
        history: [],
      }
    } finally {
      session.close()
    }
  },

  async onuAction(): Promise<void> {
    throw new CliError(NOT_YET)
  },

  async authorise(_target, _creds, items): Promise<OltAuthoriseResult[]> {
    return items.map((item) => ({ sn: item.sn, port: item.port, ok: false, error: NOT_YET }))
  },
}
