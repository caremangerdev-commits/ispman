import 'server-only'

import net from 'node:net'

/**
 * The MikroTik RouterOS API, over TCP 8728.
 *
 * WHY THIS EXISTS RATHER THAN A LIBRARY. The protocol is small enough to read
 * in one sitting, and every npm client for it either bundles a connection pool
 * we do not want, or has not been touched since RouterOS 6. What follows is
 * the whole protocol: there is no part of it hidden somewhere else.
 *
 * THE WIRE FORMAT. Everything is a "sentence": a list of words, each prefixed
 * with its length, terminated by a zero-length word. The length prefix is
 * variable-width, which is the only fiddly part:
 *
 *   < 0x80        1 byte,  the length itself
 *   < 0x4000      2 bytes, length | 0x8000
 *   < 0x200000    3 bytes, length | 0xC00000
 *   < 0x10000000  4 bytes, length | 0xE0000000
 *   otherwise     5 bytes, 0xF0 then a 4-byte length
 *
 * A reply sentence starts with !re (a row), !done (end), !trap (an error) or
 * !fatal (an error, connection closing). Rows carry words like "=name=value".
 *
 * LOGIN IS THE PLAIN ONE. RouterOS 6.43 and later accept name and password in
 * a single /login sentence. The old challenge-response handshake is gone from
 * RouterOS 7 entirely, and every router this talks to is 7 (the setup script
 * refuses to run on 6). A 6.x router returns a !trap we surface as-is.
 *
 * READ-MOSTLY BY HABIT, NOT BY ENFORCEMENT. Nothing here blocks a write
 * command, because the OLT work needs one. But the only caller today is the
 * usage poller, which sends two print commands and nothing else.
 *
 * NEVER LOGS A PASSWORD. The only place one appears is the /login sentence,
 * and the error paths report the router's own message, never the credentials.
 */

const DEFAULT_PORT = 8728
const DEFAULT_TIMEOUT_MS = 12_000

export type RouterOsRow = Record<string, string>

export class RouterOsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RouterOsError'
  }
}

/* -------------------------------------------------------------------------- */
/* The wire format                                                            */
/* -------------------------------------------------------------------------- */

function encodeLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len])
  if (len < 0x4000) {
    const v = len | 0x8000
    return Buffer.from([(v >> 8) & 0xff, v & 0xff])
  }
  if (len < 0x200000) {
    const v = len | 0xc00000
    return Buffer.from([(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff])
  }
  if (len < 0x10000000) {
    const v = len | 0xe0000000
    return Buffer.from([(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff])
  }
  return Buffer.from([
    0xf0,
    (len >>> 24) & 0xff,
    (len >> 16) & 0xff,
    (len >> 8) & 0xff,
    len & 0xff,
  ])
}

function encodeWord(word: string): Buffer {
  const body = Buffer.from(word, 'utf8')
  return Buffer.concat([encodeLength(body.length), body])
}

/** A sentence: every word, then a zero-length word to end it. */
function encodeSentence(words: string[]): Buffer {
  return Buffer.concat([...words.map(encodeWord), Buffer.from([0])])
}

/**
 * Reads length-prefixed words out of a growing buffer.
 *
 * RETURNS null WHEN THERE IS NOT ENOUGH YET, rather than throwing or blocking.
 * TCP gives us whatever arrived, which is routinely half a word; the caller
 * keeps appending and asking again.
 */
function readLength(buf: Buffer, at: number): { length: number; next: number } | null {
  if (at >= buf.length) return null
  const first = buf[at]
  if ((first & 0x80) === 0x00) return { length: first, next: at + 1 }
  if ((first & 0xc0) === 0x80) {
    if (at + 2 > buf.length) return null
    return { length: ((first & 0x3f) << 8) | buf[at + 1], next: at + 2 }
  }
  if ((first & 0xe0) === 0xc0) {
    if (at + 3 > buf.length) return null
    return { length: ((first & 0x1f) << 16) | (buf[at + 1] << 8) | buf[at + 2], next: at + 3 }
  }
  if ((first & 0xf0) === 0xe0) {
    if (at + 4 > buf.length) return null
    return {
      length: ((first & 0x0f) << 24) | (buf[at + 1] << 16) | (buf[at + 2] << 8) | buf[at + 3],
      next: at + 4,
    }
  }
  if (first === 0xf0) {
    if (at + 5 > buf.length) return null
    return { length: buf.readUInt32BE(at + 1), next: at + 5 }
  }
  throw new RouterOsError('The router sent a length byte this protocol has no meaning for.')
}

/* -------------------------------------------------------------------------- */
/* The connection                                                             */
/* -------------------------------------------------------------------------- */

export type RouterOsTarget = {
  host: string
  port?: number | null
  user: string
  password: string
  timeoutMs?: number
}

/**
 * One connection, one set of commands, then closed.
 *
 * NO POOLING, ON PURPOSE. The poller visits each router once every five
 * minutes and sends two commands. A pool would hold ten idle TCP sessions open
 * across a tunnel for 299 of every 300 seconds, and a dropped tunnel would
 * leave stale sockets that fail in a more confusing way than connecting afresh.
 */
export class RouterOsSession {
  private socket: net.Socket | null = null
  private buffer = Buffer.alloc(0)
  private readonly timeoutMs: number

  constructor(private readonly target: RouterOsTarget) {
    this.timeoutMs = target.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  private async connect(): Promise<net.Socket> {
    const port = this.target.port ?? DEFAULT_PORT
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.target.host, port })
      const onError = (err: Error) => {
        socket.destroy()
        reject(new RouterOsError('Could not reach ' + this.target.host + ': ' + err.message))
      }
      socket.setTimeout(this.timeoutMs, () => {
        socket.destroy()
        reject(
          new RouterOsError(
            this.target.host + ' did not answer within ' + Math.round(this.timeoutMs / 1000) + 's.'
          )
        )
      })
      socket.once('error', onError)
      socket.once('connect', () => {
        socket.off('error', onError)
        socket.on('error', () => {
          // Handled per-read; an unhandled 'error' would take the process down.
        })
        resolve(socket)
      })
    })
  }

  /**
   * Sends a sentence and collects replies until !done, !trap or !fatal.
   *
   * A !trap is the router refusing the command — a bad login, an unknown path.
   * It carries =message=, which is almost always the clearest description of
   * the problem available, so it is passed through rather than replaced.
   */
  private async send(words: string[]): Promise<RouterOsRow[]> {
    const socket = this.socket
    if (!socket) throw new RouterOsError('Not connected.')

    socket.write(encodeSentence(words))

    const rows: RouterOsRow[] = []
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        cleanup()
        reject(
          new RouterOsError(
            this.target.host + ' stopped replying partway through ' + (words[0] ?? 'a command') + '.'
          )
        )
      }, this.timeoutMs)

      const cleanup = () => {
        clearTimeout(deadline)
        socket.off('data', onData)
        socket.off('close', onClose)
      }

      const onClose = () => {
        cleanup()
        reject(new RouterOsError(this.target.host + ' closed the connection.'))
      }

      // One word at a time out of the buffer, grouped into sentences.
      let current: RouterOsRow = {}
      let tag = ''

      const onData = (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk])
        try {
          for (;;) {
            const head = readLength(this.buffer, 0)
            if (!head) return
            if (head.length === 0) {
              // End of a sentence.
              this.buffer = this.buffer.subarray(head.next)
              if (tag === '!done') {
                cleanup()
                resolve(rows)
                return
              }
              if (tag === '!trap' || tag === '!fatal') {
                const message = current.message ?? 'the router refused the command'
                cleanup()
                reject(new RouterOsError(this.target.host + ': ' + message))
                return
              }
              if (tag === '!re') rows.push(current)
              current = {}
              tag = ''
              continue
            }
            if (this.buffer.length < head.next + head.length) return
            const word = this.buffer
              .subarray(head.next, head.next + head.length)
              .toString('utf8')
            this.buffer = this.buffer.subarray(head.next + head.length)

            if (word.startsWith('!')) {
              tag = word
            } else if (word.startsWith('=')) {
              // =key=value, where the value may itself contain '='.
              const eq = word.indexOf('=', 1)
              if (eq === -1) current[word.slice(1)] = ''
              else current[word.slice(1, eq)] = word.slice(eq + 1)
            }
            // .tag= and anything else is ignored: nothing here uses tags.
          }
        } catch (err) {
          cleanup()
          reject(err instanceof Error ? err : new RouterOsError(String(err)))
        }
      }

      socket.on('data', onData)
      socket.once('close', onClose)
    })
  }

  /** Connect and log in, or throw with a reason worth showing an operator. */
  async open(): Promise<void> {
    this.socket = await this.connect()
    this.buffer = Buffer.alloc(0)
    try {
      await this.send(['/login', '=name=' + this.target.user, '=password=' + this.target.password])
    } catch (err) {
      this.close()
      const message = err instanceof RouterOsError ? err.message : String(err)
      // The router says "cannot log in" for a wrong password; say what that
      // means for us, since the fix is specific.
      if (/cannot log in|invalid user name or password/i.test(message)) {
        throw new RouterOsError(
          this.target.host +
            ' refused the login. Paste the setup line on this router again to reset it.'
        )
      }
      throw err
    }
  }

  /** `/queue/simple/print`, `=.proplist=...` and so on, as separate words. */
  async command(...words: string[]): Promise<RouterOsRow[]> {
    return this.send(words)
  }

  close(): void {
    this.socket?.destroy()
    this.socket = null
    this.buffer = Buffer.alloc(0)
  }
}

/** Open, run, close — even if the body throws. */
export async function withRouter<T>(
  target: RouterOsTarget,
  body: (session: RouterOsSession) => Promise<T>
): Promise<T> {
  const session = new RouterOsSession(target)
  await session.open()
  try {
    return await body(session)
  } finally {
    session.close()
  }
}

/* -------------------------------------------------------------------------- */
/* What the poller asks for                                                   */
/* -------------------------------------------------------------------------- */

export type SimpleQueue = {
  name: string
  /** The address or range the queue applies to, as the router has it. */
  target: string
  /** Bytes the customer has downloaded, since the counter last started. */
  rx: number
  /** Bytes the customer has uploaded. */
  tx: number
  disabled: boolean
}

/**
 * Every simple queue on the router.
 *
 * .proplist KEEPS THE REPLY SMALL. A queue row has thirty-odd fields and a
 * router with 250 of them is a reply measured in tens of kilobytes over a
 * tunnel, nearly all of it burst limits and priorities nothing here reads.
 *
 * THE BYTES FIELD IS "rx/tx" IN ONE STRING, download first. That is the
 * router's own order for a simple queue, where "target-upload" is traffic
 * going to the target. Reversing these two is the easiest mistake to make here
 * and the hardest to notice, since both numbers look plausible either way.
 */
export async function readSimpleQueues(session: RouterOsSession): Promise<SimpleQueue[]> {
  const rows = await session.command(
    '/queue/simple/print',
    '=.proplist=name,target,bytes,disabled'
  )
  const queues: SimpleQueue[] = []
  for (const row of rows) {
    const target = (row.target ?? '').trim()
    if (!target) continue
    const [rx, tx] = (row.bytes ?? '0/0').split('/')
    queues.push({
      name: row.name ?? '',
      target,
      rx: Number.parseInt(rx, 10) || 0,
      tx: Number.parseInt(tx, 10) || 0,
      disabled: row.disabled === 'true',
    })
  }
  return queues
}

export type DhcpLease = { address: string; mac: string }

/**
 * Every DHCP lease the router is holding, as address to MAC.
 *
 * THIS IS THE JOIN. A queue knows an address and ISPMan knows a MAC, so
 * without the lease table there is no way to say whose queue is whose. It is
 * also why usage can only be read while a customer has a current lease: an
 * address with no lease is a queue we cannot attribute, and the poller leaves
 * those alone rather than guessing.
 */
export async function readDhcpLeases(session: RouterOsSession): Promise<DhcpLease[]> {
  const rows = await session.command(
    '/ip/dhcp-server/lease/print',
    '=.proplist=address,mac-address'
  )
  const leases: DhcpLease[] = []
  for (const row of rows) {
    const address = (row.address ?? '').trim()
    const mac = (row['mac-address'] ?? '').trim().toUpperCase()
    if (address && mac) leases.push({ address, mac })
  }
  return leases
}

/* -------------------------------------------------------------------------- */
/* What the Network page asks for                                             */
/* -------------------------------------------------------------------------- */

export type RouterLive = {
  /** CPU load, percent. */
  cpu: number | null
  /** Memory in use, percent. */
  memory: number | null
  /** As the router words it, e.g. "3w2d4h10m". */
  uptime: string | null
  version: string | null
  board: string | null
  /** Supply voltage. Null on boards with no sensor, which is most small ones. */
  voltage: number | null
  /** Degrees C. Null on boards with no sensor. */
  temperature: number | null
  /** The ports the router reaches the internet through; more than one when it balances providers. */
  uplinks: string[]
  /** Power supplies that report a state, e.g. psu1 "fail". Empty on boards that report none. */
  power: { name: string; state: string }[]
  /** Bits per second arriving on the uplinks, added up: what customers are downloading. */
  downBps: number | null
  /** Bits per second leaving on the uplinks, added up: what customers are uploading. */
  upBps: number | null
}

const num = (raw: string | undefined): number | null => {
  if (raw === undefined || raw === '') return null
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) ? n : null
}

/** A name safe to hand back to the router as an argument. */
export function safeInterfaceName(raw: string | null | undefined): string | null {
  if (!raw) return null
  // Letters, digits, and the punctuation people really put in port names.
  // No comma: a comma separates names when several are monitored at once.
  return /^[A-Za-z0-9_.+ -]{1,64}$/.test(raw) ? raw : null
}

/**
 * The ports the router reaches the internet through.
 *
 * RouterOS 7 words an active default route's next hop as
 * "192.0.2.1%ether1": the address, a percent sign, the interface. A PPPoE or
 * LTE uplink has the interface itself as the gateway.
 *
 * MORE THAN ONE IS NORMAL. A router balancing two providers has two active
 * default routes, and "total traffic" is both ports added together — West
 * Central's CCR1036 runs "1 - Wan" and "2 - Wan" side by side.
 *
 * ONLY ACTIVE ROUTES COUNT, and an inactive route does not say active=false:
 * the field is simply absent. So a row is used when it says active=true, and
 * rows without the field are a fallback only if no row has it at all.
 */
async function findUplinks(session: RouterOsSession): Promise<string[]> {
  const routes = await session.command(
    '/ip/route/print',
    '?dst-address=0.0.0.0/0',
    '=.proplist=gateway,immediate-gw,active,disabled'
  )
  const usable = routes.filter((r) => r.disabled !== 'true')
  const active = usable.filter((r) => r.active === 'true')
  const names: string[] = []
  for (const r of active.length ? active : usable) {
    const hop = r['immediate-gw'] ?? ''
    const at = hop.indexOf('%')
    let name = safeInterfaceName(at >= 0 ? hop.slice(at + 1).trim() : '')
    if (!name) {
      // A gateway that is not an address is an interface name.
      const gw = (r.gateway ?? '').trim()
      if (gw && !gw.includes('.') && !gw.includes(':')) name = safeInterfaceName(gw)
    }
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}

/**
 * One reading of a router's health and its uplink traffic.
 *
 * HEALTH COMES IN TWO SHAPES. RouterOS 7 returns one row per sensor
 * (name=voltage, value=24.1); RouterOS 6 returns a single row with a field per
 * sensor. Boards without sensors return nothing, and that is reported as null
 * rather than zero: "0 V" on a screen reads as a dead power supply.
 *
 * `knownUplinks` IS PASSED BACK IN by a caller that already has them, so the
 * route lookup happens once per page rather than once per reading.
 */
export async function readRouterLive(
  session: RouterOsSession,
  knownUplinks?: string[]
): Promise<RouterLive> {
  const [resource] = await session.command(
    '/system/resource/print',
    '=.proplist=cpu-load,free-memory,total-memory,uptime,version,board-name'
  )

  let voltage: number | null = null
  let temperature: number | null = null
  const power: { name: string; state: string }[] = []
  try {
    const health = await session.command('/system/health/print')
    for (const row of health) {
      if (row.name !== undefined) {
        if (row.name === 'voltage' && voltage === null) voltage = num(row.value)
        // psu1-state / psu2-state on boards with two supplies: "ok" or "fail".
        if (row.name.startsWith('psu') && row.name.endsWith('-state') && row.value) {
          power.push({ name: row.name.replace('-state', '').toUpperCase(), state: row.value })
        }
        if (
          (row.name === 'temperature' || row.name === 'cpu-temperature' ||
            row.name === 'board-temperature1') &&
          temperature === null
        ) {
          temperature = num(row.value)
        }
      } else {
        if (voltage === null) voltage = num(row.voltage)
        if (temperature === null) temperature = num(row.temperature ?? row['cpu-temperature'])
      }
    }
  } catch {
    // No health menu on this board. Not an error worth failing the reading for.
  }

  const given = (knownUplinks ?? [])
    .map((n) => safeInterfaceName(n))
    .filter((n): n is string => n !== null)
  const uplinks = given.length ? given : await findUplinks(session)
  let downBps: number | null = null
  let upBps: number | null = null
  if (uplinks.length) {
    try {
      // One row comes back per port; the total is all of them added together.
      const rows = await session.command(
        '/interface/monitor-traffic',
        '=interface=' + uplinks.join(','),
        '=once='
      )
      for (const row of rows) {
        const rx = num(row['rx-bits-per-second'])
        const tx = num(row['tx-bits-per-second'])
        if (rx !== null) downBps = (downBps ?? 0) + rx
        if (tx !== null) upBps = (upBps ?? 0) + tx
      }
    } catch {
      // A port was renamed or removed since it was found. The next reading
      // looks them up again.
    }
  }

  const total = num(resource?.['total-memory'])
  const free = num(resource?.['free-memory'])
  return {
    cpu: num(resource?.['cpu-load']),
    memory: total && free !== null ? Math.round(((total - free) / total) * 100) : null,
    uptime: resource?.uptime ?? null,
    version: resource?.version ?? null,
    board: resource?.['board-name'] ?? null,
    voltage,
    temperature,
    uplinks: downBps === null && upBps === null ? [] : uplinks,
    power,
    downBps,
    upBps,
  }
}

/* -------------------------------------------------------------------------- */
/* What the router can hear around it                                         */
/* -------------------------------------------------------------------------- */

export type Neighbour = {
  identity: string | null
  address: string | null
  mac: string | null
  platform: string | null
  board: string | null
  version: string | null
  /** The port on this router the device was heard on. */
  heardOn: string | null
  description: string | null
}

/**
 * Every device this router has heard announce itself.
 *
 * NOTHING IS SCANNED. Routers, radios and switches broadcast who they are to
 * the link they sit on (MikroTik's own discovery, CDP, LLDP), and RouterOS
 * keeps a table of what it has heard. This reads that table. No address range
 * is probed and nothing is logged in to, so it cannot disturb the network or
 * trip anyone's intrusion alarm.
 *
 * It also means a device that announces nothing — discovery switched off, or
 * a brand that does not speak any of the three — is not in the list. That is
 * what adding a device by hand is for.
 */
export async function readNeighbours(session: RouterOsSession): Promise<Neighbour[]> {
  const rows = await session.command(
    '/ip/neighbor/print',
    '=.proplist=identity,address,mac-address,platform,board,version,interface,system-description'
  )
  const text = (v: string | undefined) => (v && v.trim() ? v.trim() : null)
  return rows.map((r) => ({
    identity: text(r.identity),
    address: text(r.address),
    mac: text(r['mac-address'])?.toUpperCase() ?? null,
    platform: text(r.platform),
    board: text(r.board),
    version: text(r.version),
    heardOn: text(r.interface),
    description: text(r['system-description']),
  }))
}
