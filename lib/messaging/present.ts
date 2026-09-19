import 'server-only'

import type { Brand } from '@/lib/brand'
import type { OutboundMessage } from '@/lib/messaging/adapter'
import { blocksFromText, LOGO_CID, renderEmailHtml, renderEmailText } from '@/lib/messaging/email-shell'

/**
 * Dressing a queued message in the company's shell, AT SEND TIME.
 *
 * THE OUTBOX STORES WORDS, NOT MARKUP. `sms_outbox.body` is the rendered plain
 * text and stays that: it is what the messages pages show, what an operator
 * reads when a customer says "I never got it", and what a retry re-sends. The
 * HTML is built from it here, the moment before the adapter is called — the
 * same decision lib/messaging/attachments.ts makes for PDFs, for the same
 * reason. Nothing is stored twice, and a company that fixes its logo at 09:00
 * has it on the message that leaves at 09:01, queued or not.
 *
 * The dispatcher calls this only for an adapter that declares supportsHtml, so
 * nothing here names a channel.
 *
 * EVERY KIND'S BLOCKS COME FROM ITS TEXT today. A kind that wants more than
 * words — a bill's amount due as a callout, a pay button — builds its own
 * block list here, switched on `row.kind`; the shell already draws them.
 */

type Presented = Pick<OutboundMessage, 'body' | 'html' | 'inlineImages'>

export function presentMessage(
  brand: Brand,
  row: { kind: string; subject: string | null; body: string }
): Presented {
  const blocks = blocksFromText(row.body)

  return {
    // The text part is generated from the same blocks as the HTML, so the two
    // halves of one message cannot say different things.
    body: renderEmailText({ brand, blocks }),
    html: renderEmailHtml({
      brand,
      logoSrc: brand.logo ? 'cid:' + LOGO_CID : null,
      subject: row.subject ?? '',
      blocks,
    }),
    inlineImages: brand.logo
      ? [{ contentId: LOGO_CID, filename: 'logo.png', bytes: brand.logo.png, contentType: 'image/png' }]
      : [],
  }
}
