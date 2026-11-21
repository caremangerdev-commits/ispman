import 'server-only'

import { CliError, TelnetSession } from '@/lib/olt/telnet'
import type {
  OltAuthoriseResult, OltDriver, OltInfo, OltLogin, OltOnu, OltOnuDetail, OltOnuLists,
  OltPendingOnu, OltPonPort,
} from '@/lib/olt/types'

/**
 * V-SOL GPON OLTs (V1600G series) over their command line.
 *
 * WRITTEN FROM PUBLISHED COMMAND GUIDES, NOT AGAINST A REAL UNIT. The commands
 * are the ones V-SOL's own setup examples use. Far less of this brand's output
 * is published than Huawei's, so almost every reading here is taken by what a
 * field looks like — a serial number, the word "working", a figure followed by
 * dBm — and where the guides show nothing at all (the address table, what the
 * OLT receives from an ONU) the value is left empty until a real unit shows
 * what it prints.
 *
 * These boxes have their PON ports built in, numbered 0/1 upward, and an ONU
 * is a number on a port. Here that is written "0/1:12".
 */

const PROMPT = /(?:^|[\r\n])[^\r\n (]{1,40}(?:\([^\r\n)]{1,60}\))?[>#] ?$/
const MORE = /--\s*More\s*--[^\r\n]*$/i
const STOPS = new RegExp('(' + MORE.source + '|' + PROMPT.source + ')', 'i')

/** No box in this series has more PON ports than this. */
const MAX_PON = 16
/** Light is read one ONU at a time on this brand; a full port is a lot of commands. */
const MAX_LIGHT_READS = 128

async function run(session: TelnetSession, command: string): Promise<string> {
  session.send(command)
  let out = ''
  for (let i = 0; i < 400; i += 1) {
    const chunk = await session.until(STOPS, 'running "' + command + '"')
    out += chunk
    if (!MORE.test(chunk)) break
    session.send(' ')
  }
  const lines = out
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\b]+/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => !/--\s*More\s*--/i.test(l))
  return lines.slice(1, -1).join('\n')
}

const refused = (text: string) => /^\s*%|Unknown command|Invalid|Error|fail/im.test(text)

async function login(session: TelnetSession, creds: OltLogin): Promise<void> {
  await session.until(/(Login|Username)\s*:/i, 'waiting for the login prompt')
  session.send(creds.user)
  await session.until(/Password\s*:/i, 'waiting for the password prompt')
  session.send(creds.password)
  const after = await session.until(/((Login|Username)\s*:|incorrect|failed|[>#] ?$)/i, 'logging in')
  if (!/[>#] ?$/.test(after)) throw new CliError('The OLT refused that username and password.')
  if (/> ?$/.test(after)) {
    session.send('enable')
    const step = await session.until(/(Password\s*:|[>#] ?$)/i, 'entering enable mode')
    if (/Password\s*:/i.test(step)) {
      session.send(creds.enablePassword ?? creds.password)
      const done = await session.until(/(Password\s*:|[>#] ?$)/i, 'entering enable mode')
      if (!/# ?$/.test(done)) throw new CliError('The OLT refused the enable password.')
    }
  }
  await run(session, 'terminal length 0')
  await run(session, 'configure terminal')
}

const SERIAL = /^[A-Za-z0-9]{4}[0-9A-Fa-f]{8}$/
/** An ONU as these OLTs write it: GPON0/1:3, 0/1:3, or 1/1/1:3. The PON port is the number before the colon. */
const ONU_REF = /(?:GPON\s*)?(?:\d+\/)?\d+\/(\d+):(\d+)/i
const PON_REF = /(?:GPON|PON)\s*\d+\/(\d+)/i

function parsePending(text: string, fallbackPon: number | null): OltPendingOnu[] {
  const out: OltPendingOnu[] = []
  if (refused(text)) return out
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/)
    const sn = fields.find((f) => SERIAL.test(f))
    if (!sn) continue
    const pon = ONU_REF.exec(line)?.[1] ?? PON_REF.exec(line)?.[1] ?? (fallbackPon != null ? String(fallbackPon) : null)
    if (!pon) continue
    const model = fields.find((f) => f !== sn && /[A-Za-z]/.test(f) && !ONU_REF.test(f) && !PON_REF.test(f) && !/^(sn|unknown|N\/A)$/i.test(f))
    out.push({ port: '0/' + pon, sn: sn.toUpperCase(), model: model ?? null })
  }
  return out
}

/** `show onu state` and `show onu info`, merged by ONU number. */
function parseOnus(pon: number, state: string, info: string): OltOnu[] {
  const onus = new Map<number, OltOnu>()
  const at = (n: number): OltOnu => {
    const port = '0/' + pon
    const o = onus.get(n) ?? { id: port + ':' + n, port, index: n, type: null, sn: null, phase: 'unknown', online: false, rx: null, tx: null, macs: [] }
    onus.set(n, o)
    return o
  }
  for (const line of state.split('\n')) {
    const ref = ONU_REF.exec(line)
    if (!ref) continue
    const phase = /\b(working|los|dying\s*gasp|dyinggasp|offline|logging|syncmib|auth\w*)\b/i.exec(line)?.[1]
    const o = at(Number(ref[2]))
    o.phase = phase ?? 'unknown'
    o.online = (phase ?? '').toLowerCase() === 'working'
  }
  for (const line of info.split('\n')) {
    const ref = ONU_REF.exec(line)
    if (!ref) continue
    const fields = line.trim().split(/\s+/)
    const o = at(Number(ref[2]))
    const sn = fields.map((f) => f.replace(/^SN:/i, '')).find((f) => SERIAL.test(f))
    if (sn) o.sn = sn.toUpperCase()
    const model = fields[1]
    if (model && !ONU_REF.test(model) && !SERIAL.test(model)) o.type = model
  }
  return [...onus.values()].sort((a, b) => a.index - b.index)
}

const dbm = (text: string, label: RegExp): number | null => {
  const m = new RegExp(label.source + '[^\\n]*?(-?\\d+(?:\\.\\d+)?)\\s*\\(?\\s*dbm', 'i').exec(text)
  return m ? Number.parseFloat(m[1]) : null
}

async function enterPon(session: TelnetSession, pon: number): Promise<boolean> {
  return !refused(await run(session, 'interface gpon 0/' + pon))
}

async function readAll(session: TelnetSession): Promise<{ onus: OltOnu[]; ponCount: number }> {
  const all: OltOnu[] = []
  let ponCount = 0
  let lightReads = 0
  for (let pon = 1; pon <= MAX_PON; pon += 1) {
    if (!(await enterPon(session, pon))) break
    ponCount = pon
    const onus = parseOnus(pon, await run(session, 'show onu state'), await run(session, 'show onu info'))
    for (const o of onus) {
      if (!o.online || lightReads >= MAX_LIGHT_READS) continue
      lightReads += 1
      o.rx = dbm(await run(session, 'show onu ' + o.index + ' optical_info'), /Rx\s*optical/)
    }
    await run(session, 'exit')
    all.push(...onus)
  }
  return { onus: all, ponCount }
}

const ONU_ID = /^0\/(\d+):(\d+)$/
const PORT = /^0\/(\d+)$/
const ONU_PROFILE = 'ISPMAN'
const DBA = 'ISPMAN-UP'

const word = (raw: string, max: number) =>
  raw.trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9._@#/-]/g, '').slice(0, max)

export const vsol: OltDriver = {
  brand: 'vsol',
  label: 'V-SOL V1600G series (not yet tested on a real unit)',

  async inspect(target, creds): Promise<OltInfo> {
    const session = new TelnetSession(target)
    await session.open()
    try {
      await login(session, creds)
      const version = await run(session, 'show version')
      const pending = parsePending(await run(session, 'show onu auto-find'), null)
      const { onus, ponCount } = await readAll(session)
      const ponPorts: OltPonPort[] = []
      for (let pon = 1; pon <= ponCount; pon += 1) {
        const here = onus.filter((o) => o.port === '0/' + pon)
        ponPorts.push({
          name: '0/' + pon,
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
        model: pick(/(Product|Model|Device)\s*(name|type)?/) ?? 'V-SOL GPON OLT',
        version: pick(/(Software|Firmware)\s*version/),
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
      const pending = parsePending(await run(session, 'show onu auto-find'), null)
      return { pending, onus: (await readAll(session)).onus }
    } finally {
      session.close()
    }
  },

  async onuDetail(target, creds, id): Promise<OltOnuDetail> {
    const m = ONU_ID.exec(id)
    if (!m) throw new CliError('That is not an ONU on this OLT.')
    const pon = Number(m[1])
    const n = Number(m[2])
    const session = new TelnetSession(target)
    await session.open()
    try {
      await login(session, creds)
      if (!(await enterPon(session, pon))) throw new CliError('That PON port was not found on the OLT.')
      const onu = parseOnus(pon, await run(session, 'show onu state'), await run(session, 'show onu info')).find((o) => o.index === n)
      const optical = await run(session, 'show onu ' + n + ' optical_info')
      const detail = await run(session, 'show onu ' + n + ' detail-info')
      await run(session, 'exit')
      const field = (label: RegExp) => new RegExp(label.source + '[^:\\n]*:\\s*(.+)', 'i').exec(detail)?.[1]?.trim() || null
      return {
        id,
        name: field(/^\s*(Name|Description)/m),
        description: null,
        type: onu?.type ?? null,
        sn: onu?.sn ?? null,
        phase: onu?.phase ?? 'unknown',
        online: onu?.online ?? false,
        distance: field(/Distance/),
        onlineFor: field(/Online\s*(Duration|time)/),
        onuRx: dbm(optical, /Rx\s*optical/),
        onuTx: dbm(optical, /Tx\s*optical/),
        oltRx: null,
        oltTx: null,
        vendor: field(/Vendor/),
        model: field(/(Model|Equipment)/) ?? onu?.type ?? null,
        firmware: field(/(Software|Firmware)\s*version/),
        history: [],
      }
    } finally {
      session.close()
    }
  },

  async onuAction(target, creds, id, action): Promise<void> {
    const m = ONU_ID.exec(id)
    if (!m) throw new CliError('That is not an ONU on this OLT.')
    const session = new TelnetSession(target)
    await session.open()
    try {
      await login(session, creds)
      if (!(await enterPon(session, Number(m[1])))) throw new CliError('That PON port was not found on the OLT.')
      const n = m[2]
      const out =
        action.kind === 'reboot'
          ? await run(session, 'onu ' + n + ' reboot')
          : action.kind === 'disable'
            ? await run(session, 'onu ' + n + ' deactivate')
            : action.kind === 'enable'
              ? await run(session, 'onu ' + n + ' activate')
          : action.kind === 'remove'
            ? await run(session, 'no onu ' + n)
            : await run(session, 'onu ' + n + ' description ' + (word(action.name || action.description, 60) || 'ONU'))
      await run(session, 'exit')
      if (refused(out)) throw new CliError('The OLT refused that: ' + out.trim().split('\n').pop())
      if (action.kind !== 'reboot') await run(session, 'write')
    } finally {
      session.close()
    }
  },

  /**
   * FOR ONUs WITH VLAN SWITCHED OFF: the ONU's first Ethernet port is put in
   * "tag" mode on the VLAN, which tags the customer's plain traffic as it
   * enters and untags it on the way back. Nothing is set on the ONU by hand.
   */
  async authorise(target, creds, items, vlan): Promise<OltAuthoriseResult[]> {
    const session = new TelnetSession(target)
    await session.open()
    try {
      await login(session, creds)
      // Each answers with an error if it already exists, which is fine.
      await run(session, 'profile onu name ' + ONU_PROFILE)
      await run(session, 'port-num eth 4')
      await run(session, 'commit')
      await run(session, 'exit')
      await run(session, 'profile dba name ' + DBA)
      await run(session, 'type 4 maximum 1000000')
      await run(session, 'commit')
      await run(session, 'exit')

      const results: OltAuthoriseResult[] = []
      for (const item of items) {
        const p = PORT.exec(item.port)
        if (!p || !SERIAL.test(item.sn)) {
          results.push({ sn: item.sn, port: item.port, ok: false, error: 'Not a valid port or serial number.' })
          continue
        }
        const pon = Number(p[1])
        if (!(await enterPon(session, pon))) {
          results.push({ sn: item.sn, port: item.port, ok: false, error: 'That PON port was not found on the OLT.' })
          continue
        }
        const taken = new Set(parseOnus(pon, await run(session, 'show onu state'), '').map((o) => o.index))
        let n = 1
        while (taken.has(n) && n < 128) n += 1
        const added = await run(session, 'onu add ' + n + ' profile ' + ONU_PROFILE + ' sn ' + item.sn)
        if (refused(added)) {
          await run(session, 'exit')
          results.push({ sn: item.sn, port: item.port, ok: false, error: added.trim().split('\n').pop() || 'The OLT did not accept this ONU.' })
          continue
        }
        const steps = [
          'onu ' + n + ' tcont 1 dba ' + DBA,
          'onu ' + n + ' gemport 1 tcont 1',
          'onu ' + n + ' service 1 gemport 1 vlan ' + vlan,
          'onu ' + n + ' service-port 1 gemport 1 uservlan ' + vlan + ' vlan ' + vlan,
          'onu ' + n + ' portvlan eth 1 mode tag vlan ' + vlan,
        ]
        let problem: string | null = null
        for (const step of steps) {
          const out = await run(session, step)
          if (refused(out) && !problem) problem = step + ' → ' + (out.trim().split('\n').pop() ?? 'refused')
        }
        await run(session, 'exit')
        results.push(
          problem
            ? { sn: item.sn, port: item.port, ok: false, id: item.port + ':' + n, error: 'Registered, but a setting was refused: ' + problem }
            : { sn: item.sn, port: item.port, ok: true, id: item.port + ':' + n }
        )
      }
      if (results.some((r) => r.id)) await run(session, 'write')
      return results
    } finally {
      session.close()
    }
  },
}
