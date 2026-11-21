import 'server-only'

import net from 'node:net'

/**
 * A command-line session to a device over Telnet.
 *
 * JUST ENOUGH TELNET. The protocol's option negotiation is answered with a
 * flat refusal to everything: WILL gets DONT, DO gets WONT. Every OLT accepts
 * that and falls back to a plain line-at-a-time terminal, which is all that is
 * wanted here. Nothing a device asks for is granted.
 *
 * READING UNTIL A PROMPT, NOT FOR A TIME. A command is finished when the
 * device prints its prompt again, so that is what each read waits for. A fixed
 * sleep is either too short for a slow command or wastes seconds on a fast
 * one, across hundreds of commands.
 *
 * PASSWORDS NEVER APPEAR IN AN ERROR. Failures describe what the device said,
 * with the text the device itself sent.
 */

const IAC = 255
const DONT = 254
const DO = 253
const WONT = 252
const WILL = 251
const SB = 250
const SE = 240

export class CliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliError'
  }
}

export type CliTarget = { host: string; port: number; timeoutMs?: number }

export class TelnetSession {
  private socket: net.Socket | null = null
  private text = ''
  private waiter: (() => void) | null = null
  private closed = false
  private readonly timeoutMs: number

  constructor(private readonly target: CliTarget) {
    this.timeoutMs = target.timeoutMs ?? 12_000
  }

  async open(): Promise<void> {
    this.socket = await new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection({ host: this.target.host, port: this.target.port })
      const fail = (err: Error) => {
        socket.destroy()
        reject(new CliError('Could not connect: ' + err.message))
      }
      socket.setTimeout(this.timeoutMs, () => {
        socket.destroy()
        reject(new CliError('No answer within ' + Math.round(this.timeoutMs / 1000) + 's.'))
      })
      socket.once('error', fail)
      socket.once('connect', () => {
        socket.off('error', fail)
        socket.setTimeout(0)
        resolve(socket)
      })
    })
    this.socket.on('data', (chunk: Buffer) => this.onData(chunk))
    this.socket.on('error', () => {
      this.closed = true
      this.waiter?.()
    })
    this.socket.on('close', () => {
      this.closed = true
      this.waiter?.()
    })
  }

  /** Strips Telnet negotiation out of the stream, refusing each option. */
  private onData(chunk: Buffer): void {
    const out: number[] = []
    const reply: number[] = []
    for (let i = 0; i < chunk.length; i += 1) {
      const b = chunk[i]
      if (b !== IAC) {
        out.push(b)
        continue
      }
      const cmd = chunk[i + 1]
      if (cmd === DO || cmd === DONT || cmd === WILL || cmd === WONT) {
        const opt = chunk[i + 2]
        if (cmd === DO) reply.push(IAC, WONT, opt)
        if (cmd === WILL) reply.push(IAC, DONT, opt)
        i += 2
      } else if (cmd === SB) {
        // Skip a sub-negotiation block up to IAC SE.
        let j = i + 2
        while (j < chunk.length - 1 && !(chunk[j] === IAC && chunk[j + 1] === SE)) j += 1
        i = j + 1
      } else if (cmd === IAC) {
        out.push(IAC)
        i += 1
      } else {
        i += 1
      }
    }
    if (reply.length && this.socket) this.socket.write(Buffer.from(reply))
    if (out.length) {
      this.text += Buffer.from(out).toString('latin1')
      this.waiter?.()
    }
  }

  /**
   * Waits until the buffered text matches, then returns everything up to and
   * including the match and removes it from the buffer.
   */
  async until(pattern: RegExp, what: string): Promise<string> {
    const deadline = Date.now() + this.timeoutMs
    for (;;) {
      const m = pattern.exec(this.text)
      if (m) {
        const end = m.index + m[0].length
        const got = this.text.slice(0, end)
        this.text = this.text.slice(end)
        return got
      }
      if (this.closed) throw new CliError('The device closed the connection while ' + what + '.')
      const left = deadline - Date.now()
      if (left <= 0) throw new CliError('The device did not respond while ' + what + '.')
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.waiter = null
          resolve()
        }, Math.min(left, 500))
        this.waiter = () => {
          clearTimeout(timer)
          this.waiter = null
          resolve()
        }
      })
    }
  }

  send(line: string): void {
    this.socket?.write(line + '\r\n')
  }

  close(): void {
    this.socket?.destroy()
    this.socket = null
    this.closed = true
  }
}
