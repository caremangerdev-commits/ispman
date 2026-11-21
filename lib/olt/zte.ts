import 'server-only'

import { CliError, TelnetSession } from '@/lib/olt/telnet'
import type { OltCard, OltDriver, OltInfo, OltLogin } from '@/lib/olt/types'

/**
 * ZTE ZXA10 (C320, C300) over its command line.
 *
 * WRITTEN AGAINST A REAL C320 ON V2.1.0, not against a manual. The prompts,
 * the login sequence and the layout of `show card` below are what that unit
 * printed on 20 Nov 2026.
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
      software: full ? f[7] : null,
      status,
    })
  }
  return cards
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

      const description = /System Description:\s*(.+)/i.exec(system)?.[1]?.trim() ?? null
      const uptime = /Started before:\s*(.+)/i.exec(system)?.[1]?.trim() ?? null
      const name = /System name:\s*(\S+)/i.exec(system)?.[1] ?? null
      const version = /Version\s+(V[\d.]+)/i.exec(description ?? '')?.[1] ?? null
      const model = /^(\S+)\s+Version/i.exec(description ?? '')?.[1] ?? null

      return { name, model, version, uptime, cards }
    } finally {
      session.close()
    }
  },
}
