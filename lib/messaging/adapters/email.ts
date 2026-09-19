import 'server-only'

import type { MessagingSettings } from '@/lib/data/sms'
import { isEmail } from '@/lib/email'
import type { ChannelAdapter, RecipientSource, RecipientVerdict } from '@/lib/messaging/adapter'

/**
 * Email through Resend — the second channel.
 *
 * ONE PLATFORM SENDING DOMAIN for every tenant, verified once in Resend and
 * named by EMAIL_FROM_DOMAIN. Each company supplies only what a recipient
 * sees: the display name and where replies go. A company with its own
 * verified domain (settings.email_from_domain, later) sends from that instead;
 * until then the columns exist and are ignored.
 *
 * IDEMPOTENT ON THE OUTBOX ID. Resend honours an Idempotency-Key header for
 * 24 hours, so the same guarantee the relay gives SMS — post, time out, retry,
 * never deliver twice — holds here through the same key, the row id.
 *
 * Paths and fields are from Resend's API reference (POST /emails, GET
 * /emails/{id}); nothing here is recalled from memory of an SDK. No SDK is
 * installed: the API is one JSON call and a dependency would be more code than
 * this file.
 */

const API = 'https://api.resend.com'
const TIMEOUT_MS = 15_000

/** Resend's default is two requests a second; one a second leaves headroom. */
const THROTTLE_SECONDS = 1

type EmailContext = {
  apiKey: string
  from: string
  replyTo: string | null
}

export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM_DOMAIN)
}

/** The From header for a company: its name, at the platform domain. */
function fromFor(settings: MessagingSettings, companyName: string): string {
  const domain = settings.emailFromDomainVerified && settings.emailFromDomain
    ? settings.emailFromDomain
    : (process.env.EMAIL_FROM_DOMAIN ?? '')
  const name = (settings.emailFromName || companyName).replace(/["<>]/g, '').trim()
  return name + ' <notifications@' + domain + '>'
}

async function call(
  apiKey: string,
  path: string,
  init: { method: 'GET' | 'POST'; body?: string; idempotencyKey?: string }
): Promise<{ status: number; body: unknown; text: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(API + path, {
      method: init.method,
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        ...(init.idempotencyKey ? { 'Idempotency-Key': init.idempotencyKey } : {}),
      },
      body: init.body,
      signal: controller.signal,
    })
    const text = await res.text()
    let body: unknown = null
    try { body = JSON.parse(text) } catch { body = null }
    return { status: res.status, body, text }
  } finally {
    clearTimeout(timer)
  }
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

export const emailAdapter: ChannelAdapter<EmailContext> = {
  channel: 'email',
  label: 'Email',
  supportsAttachments: true,
  supportsHtml: true,

  configured: () => emailConfigured(),

  async tenantReady(_companyId, settings) {
    if (!emailConfigured()) return { ready: false, reason: 'This server has no email provider configured.' }
    if (!settings.emailEnabled) return { ready: false, reason: 'Email is switched off for this company.' }
    return {
      ready: true,
      context: {
        apiKey: process.env.RESEND_API_KEY as string,
        from: fromFor(settings, settings.companyName),
        replyTo: settings.emailReplyTo || settings.companyEmail || null,
      },
    }
  },

  recipientFor(customer: RecipientSource): RecipientVerdict {
    if (customer.email_opted_out) return { ok: false, reason: 'Opted out of email' }
    const address = String(customer.email ?? '').trim().toLowerCase()
    if (!address) return { ok: false, reason: 'No email address on file' }
    if (!isEmail(address)) return { ok: false, reason: 'Email address is not valid' }
    return { ok: true, address }
  },

  throttleSeconds: () => THROTTLE_SECONDS,

  async send(context, message) {
    // Documents and inline images are both `attachments` to Resend; what makes
    // an image inline is its content_id, which the HTML names as cid:<id>.
    // Field names are from Resend's "Embed Inline Images" reference. The batch
    // endpoint does not take inline images; this adapter never uses it.
    const attachments = [
      ...(message.attachment
        ? [{
            filename: message.attachment.filename,
            content: base64(message.attachment.bytes),
            content_type: message.attachment.contentType,
          }]
        : []),
      ...message.inlineImages.map((image) => ({
        filename: image.filename,
        content: base64(image.bytes),
        content_type: image.contentType,
        content_id: image.contentId,
      })),
    ]

    let res
    try {
      res = await call(context.apiKey, '/emails', {
        method: 'POST',
        idempotencyKey: 'ispman-outbox-' + message.id,
        body: JSON.stringify({
          from: context.from,
          to: [message.recipient],
          ...(context.replyTo ? { reply_to: context.replyTo } : {}),
          subject: message.subject ?? '',
          // ALWAYS the text part, with the HTML beside it when there is one.
          // A client that refuses HTML shows this, and a spam filter scores a
          // message with both parts better than one with HTML alone.
          text: message.body,
          ...(message.html ? { html: message.html } : {}),
          ...(attachments.length ? { attachments } : {}),
        }),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: 'email provider unreachable: ' + msg, retryable: true }
    }

    if (res.status >= 200 && res.status < 300) {
      const id = (res.body as { id?: string } | null)?.id
      if (!id) return { ok: false, error: 'email provider accepted the message but returned no id', retryable: false }
      return { ok: true, providerId: id, state: null }
    }

    // 401/403 is the platform key; 422 is a rejected address or sender; both
    // are terminal. Rate limits and server errors are worth another go.
    const retryable = res.status === 429 || res.status >= 500
    const detail = (res.body as { message?: string } | null)?.message ?? res.text.slice(0, 300)
    return { ok: false, error: 'email provider returned ' + res.status + ': ' + detail, retryable }
  },

  async deliveryState(context, providerId) {
    try {
      const res = await call(context.apiKey, '/emails/' + encodeURIComponent(providerId), { method: 'GET' })
      if (res.status < 200 || res.status >= 300) return { state: 'unknown', error: null }
      const last = String((res.body as { last_event?: string } | null)?.last_event ?? '').toLowerCase()
      if (last === 'delivered') return { state: 'delivered', error: null }
      if (last === 'bounced') return { state: 'failed', error: 'Bounced: the address did not accept it' }
      if (last === 'complained') return { state: 'failed', error: 'Marked as spam by the recipient' }
      if (last === 'failed') return { state: 'failed', error: 'The email provider could not deliver it' }
      return { state: 'pending', error: null }
    } catch {
      return { state: 'unknown', error: null }
    }
  },
}
