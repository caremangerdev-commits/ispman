import 'server-only'

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

/**
 * The one place ISPMan encrypts something it has to be able to read back.
 *
 * WHAT BELONGS HERE AND WHAT DOES NOT. A router login and an OLT login belong:
 * ISPMan has to present them to the device later, so a one-way hash is no use.
 * Passwords for PEOPLE never come here — those are Supabase's, hashed, and
 * nothing in this codebase can read one. If a new use looks like "we need to
 * show this to a human again", that is the wrong instinct; a login we type at
 * a machine is the only case.
 *
 * AES-256-GCM, not CBC. GCM authenticates: a row someone edited in the
 * database fails to decrypt instead of decrypting to different plaintext. That
 * matters because the plaintext here is pasted into a router command, and a
 * forged value is a forged command.
 *
 * THE FORMAT. v1.<iv>.<tag>.<ciphertext>, all base64url. The version prefix is
 * not decoration: changing the key or the cipher later means reading both for a
 * while, and a stored blob that cannot say which it is has to be guessed at.
 *
 * NEVER LOGS, NEVER THROWS THE PLAINTEXT. Every error here says what failed
 * and nothing about the value, because these messages reach screens and log
 * files.
 */

const VERSION = 'v1'
const IV_BYTES = 12
const KEY_BYTES = 32

/**
 * ROUTER_SECRET_KEY: 32 bytes, base64. Generate with
 *   openssl rand -base64 32
 *
 * Read on every call rather than at import. A module that throws at import
 * takes the whole app down over a feature nobody has turned on yet, and this
 * key is only needed by the pages that talk to routers.
 */
function key(): Buffer {
  const raw = process.env.ROUTER_SECRET_KEY
  if (!raw) {
    throw new Error('ROUTER_SECRET_KEY is not configured, so router logins cannot be stored.')
  }
  let buf: Buffer
  try {
    buf = Buffer.from(raw.trim(), 'base64')
  } catch {
    throw new Error('ROUTER_SECRET_KEY is not valid base64.')
  }
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      'ROUTER_SECRET_KEY must decode to ' + KEY_BYTES + ' bytes; this one is ' + buf.length + '.'
    )
  }
  return buf
}

/** True when the key is present and usable, for the forms that offer this at all. */
export function secretStorageReady(): boolean {
  try {
    key()
    return true
  } catch {
    return false
  }
}

export function encryptSecret(plaintext: string): string {
  if (!plaintext) throw new Error('Nothing to encrypt.')
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [
    VERSION,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    body.toString('base64url'),
  ].join('.')
}

/**
 * Returns null rather than throwing on anything malformed, so one bad row
 * reads as "no login stored" instead of taking out the page that lists every
 * router. A caller that needs to know the difference checks for null.
 */
export function decryptSecret(stored: string | null | undefined): string | null {
  if (!stored) return null
  const parts = stored.split('.')
  if (parts.length !== 4 || parts[0] !== VERSION) return null
  try {
    const iv = Buffer.from(parts[1], 'base64url')
    const tag = Buffer.from(parts[2], 'base64url')
    const body = Buffer.from(parts[3], 'base64url')
    if (iv.length !== IV_BYTES) return null
    const decipher = createDecipheriv('aes-256-gcm', key(), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  } catch {
    // Wrong key, edited row, or a blob from a cipher we no longer run.
    return null
  }
}

/**
 * A password for a device, not for a person.
 *
 * NO PUNCTUATION, ON PURPOSE. This string is pasted into a RouterOS command
 * line inside double quotes and later into a URL, and the characters that make
 * a password look strong to a human — quotes, backslashes, semicolons — are
 * exactly the ones that end a RouterOS argument early. 24 characters from a
 * 62-character alphabet is about 143 bits, which is not the weak link in
 * anything here.
 */
export function devicePassword(length = 24): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const out: string[] = []
  // Rejection sampling: 256 % 62 is not 0, so plain modulo would favour the
  // first few letters. Cheap to do properly.
  const limit = 256 - (256 % alphabet.length)
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte >= limit) continue
      out.push(alphabet[byte % alphabet.length])
      if (out.length === length) break
    }
  }
  return out.join('')
}

/** A URL-safe one-time token, and the hash that is all we keep of it. */
export function mintToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: hashToken(token) }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Constant-time compare for anything secret-shaped. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
