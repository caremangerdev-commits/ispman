import 'server-only'

import { CliError, TelnetSession } from '@/lib/olt/telnet'
import type {
  OltCard, OltDriver, OltInfo, OltLogin, OltPonPort, OltUplink, OltVlan,
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

const PROMPT = /(?:^|[\r\n])[^\r\n ]{1,40}[>#] ?$/
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

      return { name, model, version, uptime, cards, uplinks, ponPorts, vlans }
    } finally {
      session.close()
    }
  },
}
