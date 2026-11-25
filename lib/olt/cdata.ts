import 'server-only'

import { CliError, TelnetSession } from '@/lib/olt/telnet'
import type {
  OltAuthoriseResult, OltChangePlan, OltConfigChange, OltDriver, OltInfo, OltLogin, OltOnu, OltOnuDetail,
  OltOnuLists, OltPendingOnu, OltPonPort,
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

async function run(session: TelnetSession, command: string, waitMs?: number): Promise<string> {
  session.send(command)
  let out = ''
  for (let i = 0; i < 400; i += 1) {
    const chunk = await session.until(STOPS, 'running "' + command + '"', waitMs)
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

/**
 * Logs in and goes to config mode. Returns the model, read off the prompt: an
 * FD1608S-B1 prompts "FD1608S-B1>". `show version` does not name the model on
 * this firmware (V3.2.24), so the prompt is the one place it shows.
 */
async function login(session: TelnetSession, creds: OltLogin): Promise<string | null> {
  const banner = await session.until(/(User ?name|Username|Login)\s*:/i, 'waiting for the login prompt')
  session.send(creds.user)
  await session.until(/password\s*:/i, 'waiting for the password prompt')
  session.send(creds.password)
  const after = await session.until(/((User ?name|Username|Login)\s*:|invalid|incorrect|fail|[>#] ?$)/i, 'logging in')
  if (!/[>#] ?$/.test(after)) throw new CliError('The OLT refused that username and password.')
  const model =
    /([A-Za-z0-9][A-Za-z0-9-]{2,30})[>#] ?$/.exec(after.trim())?.[1] ??
    /Device Model\s*:\s*(\S+)/i.exec(banner)?.[1] ??
    null
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
  return model
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

/** How many PON ports the box has, from its model: FD1601S → 1, FD1608S-B1 → 8. */
function ponCount(model: string | null): number {
  const m = /FD1[16](\d{2})/i.exec(model ?? '')
  const n = m ? Number(m[1]) : 0
  return n >= 1 && n <= 16 ? n : 1
}

/**
 * `show ont info all` (or `<port> all`), as a real FD1608S-B1 prints it:
 *
 *     F/S P  ONT    SN               Control  Run     Config    Match     Last
 *            ID                      flag     state   state     state     down-cause
 *     0/0 1  2      RTEGC60B1514     Active   Online  success   match     LOS
 *     0/0 1  5      DE29E6DB0DC2     Active   Offline initial   initial   --
 *
 * "Last down-cause" is the reason it last went down, which for an ONU that is
 * online now is history, not its state.
 */
function parseOnus(text: string): OltOnu[] {
  const out: OltOnu[] = []
  if (refused(text)) return out
  for (const line of text.split('\n')) {
    const m = /^\s*0\/0\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/.exec(line)
    if (!m) continue
    const [, port, index, sn, control, run, config, , cause] = m
    const online = /^online$/i.test(run)
    const disabled = /^deactiv/i.test(control)
    out.push({
      id: '0/0/' + port + ':' + index,
      port: '0/0/' + port,
      index: Number(index),
      type: null,
      sn: asSerial(sn) ?? sn.toUpperCase(),
      // "failed" means the ONU is up but rejected its settings: it shows
      // online and passes nothing, which is worth seeing in the list.
      phase: online ? (/^failed$/i.test(config) ? 'config failed' : 'working') : cause !== '--' ? cause : 'offline',
      online,
      rx: null,
      tx: null,
      macs: [],
      disabled,
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

/**
 * Every ONU on every port in one command, then light levels for each port
 * that has an ONU online. Asking port by port would miss ports the model
 * name does not account for, which is how only port 1 was being read.
 */
async function readAll(session: TelnetSession, ports: number): Promise<{ onus: OltOnu[]; pending: OltPendingOnu[] }> {
  const macs = parseMacs(await run(session, 'show mac-address all'))
  await run(session, 'interface gpon 0/0')
  const pending = parsePending(await run(session, 'show ont autofind all'), ports)
  const onus = parseOnus(await run(session, 'show ont info all'))
  const live = [...new Set(onus.filter((o) => o.online).map((o) => o.port))]
  for (const port of live) {
    const light = parseOptical(await run(session, 'show ont optical-info ' + port.split('/')[2] + ' all'))
    for (const o of onus) {
      if (o.port !== port) continue
      const reading = light.get(o.index)
      if (reading) {
        o.rx = reading.rx
        o.tx = reading.oltRx
      }
    }
  }
  for (const o of onus) o.macs = macs.get(o.id) ?? []
  await run(session, 'exit')
  return { onus, pending }
}

const ONU_ID = /^0\/0\/(\d+):(\d+)$/
const PORT = /^0\/0\/(\d+)$/

const word = (raw: string, max: number) =>
  raw.trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9._@#/-]/g, '').slice(0, max)

const lastLine = (text: string) => text.trim().split('\n').pop()?.trim() || 'The OLT refused that.'

/* -------------------------------------------------------------------------- */
/* The OLT's own settings                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Read from `show current-config`, as a real FD1608S-B1 (V3.2.24) prints it:
 *
 *   dba-profile profile-id 1 profile-name dba-profile_1
 *     type4 max 1024000
 *     commit
 *    exit
 *   vlan 1,20
 *   interface ge 0/0
 *    vlan mode 1 trunk
 *    vlan trunk 1 20
 *   exit
 *   interface vlanif 1
 *    ip address 10.10.4.3 23
 *
 * VLANs live in one list, uplinks are numbered inside `interface ge 0/0`
 * (and `xge 0/0`), upload speed is a DBA profile with a number and a name,
 * and the VLAN with an address on it is how the OLT is managed. The
 * configuration also carries ONU serials and settings, which nothing here
 * keeps.
 */
type CdataUplink = { name: string; group: 'ge' | 'xge'; port: number; mode: string; tagged: number[] }
type CdataConfig = {
  vlans: number[]
  uplinks: CdataUplink[]
  dba: { id: number; name: string; raw: string; kbps: number | null }[]
  mgmt: Map<number, string>
  /** Every line, for "is this still used" checks. */
  lines: string[]
}

function vlanList(text: string): number[] {
  const out: number[] = []
  for (const part of text.split(',')) {
    const r = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part)
    if (!r) continue
    for (let v = Number(r[1]); v <= Number(r[2] ?? r[1]) && out.length < 4096; v += 1) out.push(v)
  }
  return out
}

function parseConfig(text: string): CdataConfig {
  const lines = text.replace(/\r/g, '').split('\n')
  const vlans: number[] = []
  const uplinks = new Map<string, CdataUplink>()
  const dba: CdataConfig['dba'] = []
  const mgmt = new Map<number, string>()
  let group: 'ge' | 'xge' | null = null
  let vlanif: number | null = null
  let profile: { id: number; name: string } | null = null

  const uplink = (g: 'ge' | 'xge', n: number) => {
    const name = g + '0/0/' + n
    let u = uplinks.get(name)
    if (!u) {
      u = { name, group: g, port: n, mode: 'access', tagged: [] }
      uplinks.set(name, u)
    }
    return u
  }

  for (const raw of lines) {
    const line = raw.trim()
    let m: RegExpExecArray | null
    if ((m = /^vlan ([\d,\s-]+)$/.exec(line))) vlans.push(...vlanList(m[1]))
    if ((m = /^interface (ge|xge) 0\/0$/.exec(line))) {
      group = m[1] as 'ge' | 'xge'
      continue
    }
    if ((m = /^interface vlanif (\d+)$/.exec(line))) {
      vlanif = Number(m[1])
      continue
    }
    if ((m = /^dba-profile profile-id (\d+) profile-name (\S+)/.exec(line))) {
      profile = { id: Number(m[1]), name: m[2] }
      continue
    }
    if (line === 'exit') {
      group = null
      vlanif = null
      profile = null
      continue
    }
    if (profile && (m = /^(type\d .+)$/.exec(line))) {
      const k = /(\d+)\s*$/.exec(m[1])
      dba.push({ ...profile, raw: m[1].trim(), kbps: k ? Number(k[1]) : null })
      continue
    }
    if (vlanif != null && (m = /^ip address (\d+\.\d+\.\d+\.\d+)/.exec(line))) mgmt.set(vlanif, m[1])
    if (group) {
      if ((m = /^vlan mode (\d+) (\S+)$/.exec(line))) uplink(group, Number(m[1])).mode = m[2]
      else if ((m = /^vlan trunk (\d+) ([\d,\s-]+)$/.exec(line))) uplink(group, Number(m[1])).tagged.push(...vlanList(m[2]))
      else if ((m = /^port (\d+) /.exec(line))) uplink(group, Number(m[1]))
    }
  }
  return { vlans: [...new Set(vlans)].sort((a, b) => a - b), uplinks: [...uplinks.values()], dba, mgmt, lines }
}

async function readConfig(session: TelnetSession): Promise<CdataConfig> {
  // The whole configuration: a few seconds on a small box, longer on a full one.
  const text = await run(session, 'show current-config', 60_000)
  if (refused(text) && !/Current configuration/i.test(text)) {
    throw new CliError('The OLT did not show its configuration.')
  }
  return parseConfig(text)
}

/** For the OLT reading: VLANs, uplinks and upload profiles. Never fails the reading. */
async function configForInfo(session: TelnetSession): Promise<Pick<OltInfo, 'vlans' | 'uplinks' | 'speedProfiles'>> {
  try {
    const c = await readConfig(session)
    return {
      vlans: c.vlans.map((id) => ({
        id,
        name: null,
        description: c.mgmt.has(id) ? 'Management (' + c.mgmt.get(id) + ')' : null,
        untagged: null,
        tagged: c.uplinks.filter((u) => u.tagged.includes(id)).map((u) => u.name).join(' ') || null,
      })),
      uplinks: c.uplinks.map((u) => ({
        name: u.name,
        enabled: true,
        // Its link is not in the configuration; shown as not read rather than down.
        up: false,
        linkKnown: false,
        medium: u.group === 'xge' ? 'fibre' : 'copper',
        duplex: null,
        description: null,
        inBps: null,
        outBps: null,
        mode: u.mode,
      })),
      speedProfiles: c.dba.map((d) => ({ name: d.name, direction: 'up', kbps: d.kbps, raw: d.raw })),
    }
  } catch {
    return {}
  }
}

const CDATA_UPLINK = /^(x?ge)0\/0\/(\d+)$/

async function planCdata(session: TelnetSession, change: OltConfigChange): Promise<OltChangePlan> {
  const say = (s: string): never => {
    throw new CliError(s)
  }
  const c = await readConfig(session)
  const valid = (v: number) => Number.isInteger(v) && v >= 2 && v <= 4094
  const usedBy = (pattern: RegExp) => c.lines.filter((l) => pattern.test(l.trim()) && !l.trim().startsWith('#')).length

  switch (change.kind) {
    case 'vlan-add': {
      const v = Number(change.vlan)
      if (!valid(v)) say('Choose a VLAN from 2 to 4094.')
      if (c.vlans.includes(v)) say('VLAN ' + v + ' already exists on this OLT.')
      return { summary: 'Create VLAN ' + v, commands: ['vlan ' + v], undo: ['no vlan ' + v] }
    }
    case 'vlan-remove': {
      const v = Number(change.vlan)
      if (!valid(v)) say('Choose a VLAN from 2 to 4094.')
      if (!c.vlans.includes(v)) say('There is no VLAN ' + v + ' on this OLT.')
      if (c.mgmt.has(v)) {
        say('VLAN ' + v + ' is how this OLT is managed: its address ' + c.mgmt.get(v) + ' is on it. Removing it would cut ISPMan, and you, off from the OLT.')
      }
      const onUplinks = c.uplinks.filter((u) => u.tagged.includes(v)).length
      const inProfiles = usedBy(new RegExp('(?:gem mapping .*vlan|gemport \\d+ vlan|translation|user-vlan)\\s+' + v + '\\b'))
      if (onUplinks || inProfiles) {
        say(
          'VLAN ' + v + ' is still in use: ' +
            [onUplinks ? onUplinks + ' uplink' + (onUplinks === 1 ? '' : 's') : '', inProfiles ? inProfiles + ' profile setting' + (inProfiles === 1 ? '' : 's') : '']
              .filter(Boolean)
              .join(' and ') +
            '. Move them to another VLAN first.'
        )
      }
      return { summary: 'Remove VLAN ' + v, commands: ['no vlan ' + v], undo: ['vlan ' + v] }
    }
    case 'uplink-vlan-add':
    case 'uplink-vlan-remove': {
      const m = CDATA_UPLINK.exec(String(change.port))
      const u = c.uplinks.find((x) => x.name === change.port)
      if (!m || !u) say('That is not an uplink port on this OLT.')
      const v = Number(change.vlan)
      const iface = 'interface ' + u!.group + ' 0/0'
      if (change.kind === 'uplink-vlan-add') {
        if (!c.vlans.includes(v)) say('There is no VLAN ' + v + ' on this OLT yet. Create it first.')
        if (u!.tagged.includes(v)) say(u!.name + ' already carries VLAN ' + v + '.')
        if (u!.mode !== 'trunk') say(u!.name + ' is in ' + u!.mode + ' mode. ISPMan adds VLANs to trunk ports on C-Data so far.')
        if (!change.tagged) say('On C-Data, ISPMan adds VLANs tagged so far. Choose tagged.')
        return {
          summary: 'Carry VLAN ' + v + ' tagged on ' + u!.name,
          commands: [iface, 'vlan trunk ' + u!.port + ' ' + v, 'exit'],
          undo: [iface, 'no vlan trunk ' + u!.port + ' ' + v, 'exit'],
        }
      }
      if (!u!.tagged.includes(v)) say(u!.name + ' does not carry VLAN ' + v + '.')
      if (c.mgmt.has(v)) {
        say('VLAN ' + v + ' carries this OLT\'s management (' + c.mgmt.get(v) + '). Taking it off an uplink could cut ISPMan, and you, off from the OLT.')
      }
      return {
        summary: 'Stop carrying VLAN ' + v + ' on ' + u!.name,
        commands: [iface, 'no vlan trunk ' + u!.port + ' ' + v, 'exit'],
        undo: [iface, 'vlan trunk ' + u!.port + ' ' + v, 'exit'],
      }
    }
    case 'speed-add': {
      if (change.direction !== 'up') say('Download profiles are not available on C-Data from ISPMan yet. Upload profiles are.')
      const name = String(change.name).trim()
      if (!/^[A-Za-z0-9_.-]{1,32}$/.test(name)) say('Use letters, numbers, dots, dashes or underscores for the name, up to 32.')
      if (c.dba.some((d) => d.name === name)) say('There is already an upload profile called ' + name + '.')
      const mbps = Number(change.mbps)
      if (!(mbps > 0 && mbps <= 10000)) say('Choose a speed from 1 to 10000 Mbps.')
      const id = Math.max(-1, ...c.dba.map((d) => d.id)) + 1
      const kbps = Math.round(mbps * 1024)
      return {
        summary: 'Create upload speed profile ' + name + ' (' + mbps + ' Mbps)',
        commands: ['dba-profile profile-id ' + id + ' profile-name ' + name, 'type4 max ' + kbps, 'commit', 'exit'],
        undo: ['no dba-profile profile-id ' + id],
      }
    }
    case 'speed-remove': {
      if (change.direction !== 'up') say('Download profiles are not available on C-Data from ISPMan yet.')
      const d = c.dba.find((x) => x.name === change.name)
      if (!d) say('There is no upload profile called ' + change.name + '.')
      if (d!.id === 0) say(d!.name + ' is the OLT\'s default profile and cannot be removed.')
      const uses = usedBy(new RegExp('dba-profile-id\\s+' + d!.id + '\\b'))
      if (uses) say(d!.name + ' is used by ' + uses + ' line profile setting' + (uses === 1 ? '' : 's') + '. Move them to another profile first.')
      return {
        summary: 'Remove upload speed profile ' + d!.name,
        commands: ['no dba-profile profile-id ' + d!.id],
        undo: ['dba-profile profile-id ' + d!.id + ' profile-name ' + d!.name, d!.raw, 'commit', 'exit'],
      }
    }
    default:
      return say('That change is not available on C-Data OLTs from ISPMan yet.')
  }
}

export const cdata: OltDriver = {
  brand: 'cdata',
  label: 'C-Data FD1601S / FD1604 / FD1608 / FD1616',

  async inspect(target, creds): Promise<OltInfo> {
    const session = new TelnetSession(target)
    await session.open()
    try {
      const model = await login(session, creds)
      const version = await run(session, 'show version')
      const { onus, pending } = await readAll(session, ponCount(model))
      // The model gives the port count; an ONU seen on a higher port than that
      // wins, so a misread model never hides a port.
      const ports = Math.max(ponCount(model), ...onus.map((o) => Number(o.port.split('/')[2]) || 0))
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
      const settings = await configForInfo(session)
      // `show version` on V3.2.24:
      //   Software version V3.2.24
      //   GPON OLT uptime is 0 weeks, 5 days, 9 hours, 11 minutes.
      return {
        name: null,
        model: model ?? 'C-Data GPON OLT',
        version: /Software version\s+(\S+)/i.exec(version)?.[1] ?? null,
        uptime: /uptime is\s+([^\n]+?)\.?\s*$/im.exec(version)?.[1] ?? null,
        cards: [],
        uplinks: settings.uplinks ?? [],
        ponPorts,
        vlans: settings.vlans ?? [],
        speedProfiles: settings.speedProfiles,
        onus: { authorised: onus.length, unauthorised: pending.length, offline: onus.filter((o) => !o.online).length },
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
      return await planCdata(session, change)
    } finally {
      session.close()
    }
  },

  async runCommands(target, creds, commands): Promise<number> {
    const session = new TelnetSession(target)
    await session.open()
    try {
      await login(session, creds)
      let ran = 0
      for (const command of commands) {
        const out = await run(session, command)
        if (refused(out)) {
          const said = out.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? ''
          throw new CliError('The OLT refused "' + command + '" after ' + ran + ' of ' + commands.length + ' commands: ' + said)
        }
        ran += 1
      }
      await run(session, 'save', 60_000)
      return ran
    } finally {
      session.close()
    }
  },

  async listOnus(target, creds): Promise<OltOnuLists> {
    const session = new TelnetSession(target)
    await session.open()
    try {
      return await readAll(session, ponCount(await login(session, creds)))
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
      const list = parseOnus(await run(session, 'show ont info ' + p + ' all')).find((o) => o.index === Number(n))
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
        onlineFor: list?.online ? field(info, /Online\s+time/) : null,
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
    if (action.kind === 'vsol-fix') throw new CliError('That setting is only for V-SOL ONUs on a GCOM OLT.')
    if (action.kind === 'speed') throw new CliError('Setting an ONU\'s speed is only available on ZTE OLTs so far.')
    if (action.kind === 'service') throw new CliError('Changing the VLAN setup of an ONU is only available on ZTE OLTs so far.')
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
        const taken = new Set(parseOnus(await run(session, 'show ont info ' + p[1] + ' all')).map((o) => o.index))
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
