import 'server-only'

import { CliError, TelnetSession } from '@/lib/olt/telnet'
import type {
  OltAuthoriseResult, OltDriver, OltInfo, OltLogin, OltOnu, OltOnuDetail, OltOnuLists, OltPonPort,
} from '@/lib/olt/types'

/**
 * GCOM / New GreenNet GPON OLTs ("OptiWay", e.g. GL5600-08P) over telnet.
 *
 * WRITTEN AGAINST A REAL UNIT: a GL5600-08P, software V100R001B01D002P009.
 * Every layout below is what that unit printed.
 *
 * HOW THIS BRAND WORKS, which is why it is its own module:
 *
 *   - The login prompt carries its length rule: "Username(1-32 chars):" and
 *     "Password(1-16 chars):". It lands at "OptiWay>"; `enable` gives
 *     "OptiWay#" with no second password.
 *   - An ONU is named slot/port/number: 0/1/1 is ONU 1 on PON port 1.
 *   - ONUs ARE ADDED BY THE OLT ITSELF (ont-auto-find and ont-auto-auth on
 *     every PON port) and all share one group's settings. So nothing waits to
 *     be authorized.
 *   - There is no one command for every ONU's light. Each ONU is asked on its
 *     own (`show optical info ont 0/1/1`), and so is the address list behind
 *     it (`show mac-address-table ont 0/1/1`) — the OLT-wide table only says
 *     which PON port an address came in on, not which ONU.
 *   - Changes to one ONU are made inside `ont 0/1/1` from config mode:
 *     ont-reboot, active, deactive, description. Saving is
 *     `copy running-config startup-config`, which asks (y/n).
 */

const PROMPT = /(?:^|[\r\n])[^\r\n (]{1,40}(?:\([^\r\n)]{1,60}\))?[>#] ?$/
const MORE = /(--\s*More[^\r\n]*|next page[^\r\n]*)$/i
const ASKS_YES_NO = /\(y\/n\)[^\r\n]*$/i
const STOPS = new RegExp('(' + [MORE.source, ASKS_YES_NO.source, PROMPT.source].join('|') + ')', 'i')

async function run(session: TelnetSession, command: string): Promise<string> {
  session.send(command)
  let out = ''
  for (let i = 0; i < 400; i += 1) {
    const chunk = await session.until(STOPS, 'running "' + command + '"')
    out += chunk
    if (MORE.test(chunk)) session.send(' ')
    else if (ASKS_YES_NO.test(chunk)) session.send('y')
    else break
  }
  return out
    // The OLT clears the screen and moves the cursor with escape codes.
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\b]+/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => !MORE.test(l))
    .slice(1, -1)
    .join('\n')
}

/** "% Unrecognized command" and "% Incomplete command" are how it says no. */
const refused = (text: string) => /^\s*%\s|Unrecognized command|Incomplete command|error detected/im.test(text)

async function login(session: TelnetSession, creds: OltLogin): Promise<void> {
  await session.until(/(User ?name|Login)(\([^)]*\))?\s*:/i, 'waiting for the login prompt')
  session.send(creds.user)
  await session.until(/password(\([^)]*\))?\s*:/i, 'waiting for the password prompt')
  session.send(creds.password)
  const after = await session.until(/((User ?name|Login)(\([^)]*\))?\s*:|invalid|incorrect|fail|[>#] ?$)/i, 'logging in')
  if (!/[>#] ?$/.test(after)) throw new CliError('The OLT refused that username and password.')
  if (/> ?$/.test(after)) {
    session.send('enable')
    const step = await session.until(/(password(\([^)]*\))?\s*:|[>#] ?$)/i, 'entering enable mode')
    if (/password/i.test(step)) {
      session.send(creds.enablePassword ?? creds.password)
      const done = await session.until(/(password(\([^)]*\))?\s*:|[>#] ?$)/i, 'entering enable mode')
      if (!/# ?$/.test(done)) throw new CliError('The OLT refused the enable password.')
    }
  }
}

const ONU_ID = /^0\/(\d+)\/(\d+)$/

/**
 * Make a V-SOL ONU pass traffic on this OLT: `device type c40-210` and
 * `wan 1 default vlan 1`, inside that one ONU.
 *
 * NEVER ON ANYTHING BUT A V-SOL, AND NEVER ON THE GROUP. On 21 Nov 2026 the
 * wan line was pushed to every ONU slot and about 20 customers with other
 * makes lost internet. `no wan 1` is accepted and silently does nothing, so
 * the only way back was `no config` and the group settings typed again, ONU
 * by ONU. So the OLT itself is asked who made this ONU, here, at the moment
 * of the change — not the page, not a serial prefix.
 */
async function vsolFix(session: TelnetSession, id: string): Promise<void> {
  const version = await run(session, 'show ont version ' + id)
  const vendor = /^\s*Vendor-ID\s*:\s*(\S+)/im.exec(version)?.[1] ?? ''
  if (!/^VSOL$/i.test(vendor)) {
    throw new CliError(
      'Not changed: this ONU is ' + (vendor ? 'made by ' + vendor : 'not reporting who made it') +
        '. These settings are only for V-SOL ONUs and cut other makes off.'
    )
  }
  await run(session, 'configure terminal')
  try {
    const entered = await run(session, 'ont ' + id)
    if (refused(entered)) throw new CliError('The OLT would not open that ONU: ' + lastLine(entered))
    for (const line of ['device type c40-210', 'wan 1 default vlan 1']) {
      const out = await run(session, line)
      if (refused(out)) throw new CliError('The OLT refused "' + line + '": ' + lastLine(out))
    }
  } finally {
    await run(session, 'end')
  }
  await run(session, 'copy running-config startup-config')
}

/** "GPON007edebf" → "GPON007EDEBF": the vendor letters stay, the hex goes upper case. */
const serial = (raw: string) => raw.toUpperCase()

/**
 * `show ont brief`, as the GL5600-08P prints it:
 *
 *     ONT     SN             Status    Find     Auth      Config    Reason
 *     0/1/1   GPON007edebf   online    auto     auto      ok        ----
 *     0/1/7   XPON32004450   offline   auto     auto      ok        sf
 *     0/3/7   CDTC1de73fe1   offline   auto     auto      ok        power off
 *
 * Reasons seen: sf (signal failing), lofi (lost the fibre), power off.
 */
function parseBrief(text: string): OltOnu[] {
  const out: OltOnu[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(0\/(\d+)\/(\d+))\s+(\S+)\s+(online|offline)\s+\S+\s+\S+\s+(\S+)\s+(.*?)\s*$/i.exec(line)
    if (!m) continue
    const [, id, port, index, sn, status, config, reason] = m
    const online = status.toLowerCase() === 'online'
    out.push({
      id,
      port: '0/' + port,
      index: Number(index),
      type: null,
      sn: serial(sn),
      phase: online
        ? config.toLowerCase() === 'ok' ? 'working' : 'config ' + config
        : reason && !/^-+$/.test(reason) ? reason : 'offline',
      online,
      rx: null,
      tx: null,
      macs: [],
    })
  }
  return out.sort((a, b) => a.port.localeCompare(b.port, undefined, { numeric: true }) || a.index - b.index)
}

/**
 * `show optical info ont 0/1/1`:
 *     Received Optical Power     :-26.3840 dBm
 *     Mean Optical Launch Power  :2.3100 dBm
 */
function parseOptical(text: string): { rx: number | null; tx: number | null; temp: string | null; volts: string | null } {
  const num = (label: string) => {
    const v = Number.parseFloat(new RegExp(label + '\\s*:\\s*(-?\\d+(?:\\.\\d+)?)', 'i').exec(text)?.[1] ?? '')
    return Number.isFinite(v) ? Math.round(v * 100) / 100 : null
  }
  return {
    rx: num('Received Optical Power'),
    tx: num('Mean Optical Launch Power'),
    temp: /Temperature\s*:\s*([^\n]+)/i.exec(text)?.[1]?.trim() ?? null,
    volts: /Power Feed Voltage\s*:\s*([^\n]+)/i.exec(text)?.[1]?.trim() ?? null,
  }
}

/** `show mac-address-table ont 0/1/1`: "6C:68:A4:7E:DE:C8   0/1/1   GPON007edebf". */
function parseOnuMacs(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*([0-9a-f]{2}(?::[0-9a-f]{2}){5})\s/i.exec(line)
    if (m && !out.includes(m[1].toUpperCase())) out.push(m[1].toUpperCase())
  }
  return out
}

/**
 * Light and addresses for each ONU that is online, one ONU at a time — this
 * OLT has no command that gives them for a whole port. An offline ONU has
 * neither, so it is not asked.
 */
async function readAll(session: TelnetSession): Promise<OltOnu[]> {
  const onus = parseBrief(await run(session, 'show ont brief'))
  for (const o of onus) {
    if (!o.online) continue
    o.rx = parseOptical(await run(session, 'show optical info ont ' + o.id)).rx
    o.macs = parseOnuMacs(await run(session, 'show mac-address-table ont ' + o.id))
  }
  return onus
}

/** `show interface brief`: "p0/1  up  false  f2500-f2500 ..." for the PON ports. */
function parsePonPorts(text: string, onus: OltOnu[]): OltPonPort[] {
  const out: OltPonPort[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*p0\/(\d+)\s+(\S+)?\s*(up|down)\s+(true|false)/i.exec(line)
    if (!m) continue
    const name = '0/' + m[1]
    const here = onus.filter((o) => o.port === name)
    out.push({
      name,
      enabled: m[4].toLowerCase() === 'false',
      up: m[3].toLowerCase() === 'up',
      description: null,
      capacity: 128,
      registered: here.length,
      inBps: null,
      outBps: null,
    })
  }
  return out
}

const word = (raw: string, max: number) =>
  raw.trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9._@#/-]/g, '').slice(0, max)

const lastLine = (text: string) =>
  text.split('\n').map((l) => l.trim()).filter(Boolean).pop() || 'The OLT refused that.'

export const gcom: OltDriver = {
  brand: 'gcom',
  label: 'GCOM / OptiWay (GL5600 series)',

  async inspect(target, creds): Promise<OltInfo> {
    const session = new TelnetSession(target)
    await session.open()
    try {
      await login(session, creds)
      // software version      : OptiWay GL5600-08P V100R001B01D002P009
      const version = await run(session, 'show version')
      const onus = parseBrief(await run(session, 'show ont brief'))
      const ponPorts = parsePonPorts(await run(session, 'show interface brief'), onus)
      const sw = /software version\s*:\s*(.+)/i.exec(version)?.[1]?.trim() ?? ''
      const model = /(GL\d{4}[A-Za-z0-9-]*)/.exec(sw)?.[1] ?? null
      return {
        name: null,
        model: model ? 'GCOM ' + model : 'GCOM OLT',
        version: /(V\d{3}R\S+)/.exec(sw)?.[1] ?? (sw || null),
        uptime: null,
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
      return { pending: [], onus: await readAll(session) }
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
      const onu = parseBrief(await run(session, 'show ont brief')).find((o) => o.id === id)
      if (!onu) throw new CliError('That ONU is no longer on the OLT.')
      // show ont version 0/1/1:
      //   Vendor-ID            : VSOL
      //   Equipment-ID         : VSOLH223
      //   Main Software Version: V2.1.08
      const version = await run(session, 'show ont version ' + id)
      const status = await run(session, 'show ont status ' + id)
      const light = onu.online ? parseOptical(await run(session, 'show optical info ont ' + id)) : null
      const field = (text: string, label: string) => {
        const v = new RegExp('^\\s*' + label + '\\s*:\\s*(.*)$', 'im').exec(text)?.[1]?.trim()
        return v && v !== '-' ? v : null
      }
      // status primary/secondary  : active/active
      const disabled = /status primary\/secondary\s*:\s*deactive/i.test(status)
      return {
        id,
        name: null,
        description: null,
        type: field(version, 'Equipment-ID'),
        sn: onu.sn,
        phase: disabled ? 'disabled' : onu.phase,
        online: onu.online,
        distance: null,
        onlineFor: null,
        onuRx: light?.rx ?? null,
        onuTx: light?.tx ?? null,
        oltRx: null,
        oltTx: null,
        vendor: field(version, 'Vendor-ID'),
        model: field(version, 'Equipment-ID'),
        firmware: field(version, 'Main Software Version'),
        history: [],
        disabled,
      }
    } finally {
      session.close()
    }
  },

  async onuAction(target, creds, id, action): Promise<void> {
    if (!ONU_ID.test(id)) throw new CliError('That is not an ONU on this OLT.')
    if (action.kind === 'remove') {
      throw new CliError(
        'ISPMan cannot remove an ONU from a GCOM OLT yet. Unplug it or switch it off (Disable) instead.'
      )
    }
    const session = new TelnetSession(target)
    await session.open()
    try {
      await login(session, creds)
      if (action.kind === 'vsol-fix') {
        await vsolFix(session, id)
        return
      }
      await run(session, 'configure terminal')
      const entered = await run(session, 'ont ' + id)
      if (refused(entered)) throw new CliError('The OLT would not open that ONU: ' + lastLine(entered))
      const out =
        action.kind === 'reboot'
          ? await run(session, 'ont-reboot')
          : action.kind === 'disable'
            ? await run(session, 'deactive')
            : action.kind === 'enable'
              ? await run(session, 'active')
              : await run(session, 'description ' + (word(action.name || action.description, 60) || 'ONU'))
      await run(session, 'end')
      if (refused(out)) throw new CliError(lastLine(out))
      if (action.kind !== 'reboot') await run(session, 'copy running-config startup-config')
    } finally {
      session.close()
    }
  },

  /** The OLT adds every ONU by itself, so there is never anything to authorize. */
  async authorise(_target, _creds, items): Promise<OltAuthoriseResult[]> {
    return items.map((item) => ({
      sn: item.sn,
      port: item.port,
      ok: false,
      error: 'This OLT adds ONUs by itself. Plug the ONU in and it appears under Authorized within a minute.',
    }))
  },
}
