import 'server-only'

import { getReceipt } from '@/lib/data/receipts'
import { renderReceipt } from '@/lib/receipt'
import { receiptFilename, receiptPdf } from '@/lib/receipt-pdf'

/**
 * Documents that can ride along with a message, keyed by kind.
 *
 * AN ATTACHMENT IS A REFERENCE, RENDERED AT SEND TIME. The outbox row stores
 * '{"kind":"receipt","id":8123}' and the dispatcher asks this module for the
 * bytes when the adapter is about to send. Nothing is stored twice, a
 * document is always generated from the record it describes, and a row that
 * refers to a record since deleted fails with a reason rather than sending a
 * stale copy.
 *
 * ADDING A KIND is a case in the switch: bills (migration 0014) are the next
 * one, and an emailed bill is their main delivery.
 */

export type AttachmentRef =
  | { kind: 'receipt'; id: number }
  | { kind: 'bill'; id: number }

export type RenderedAttachment = { filename: string; bytes: Uint8Array; contentType: string }

export function parseAttachmentRef(raw: string | null | undefined): AttachmentRef | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as { kind?: string; id?: number }
    if ((v.kind === 'receipt' || v.kind === 'bill') && Number.isInteger(v.id)) {
      return { kind: v.kind, id: v.id as number }
    }
  } catch { /* fall through */ }
  return null
}

export function serialiseAttachmentRef(ref: AttachmentRef): string {
  return JSON.stringify({ kind: ref.kind, id: ref.id })
}

export async function renderAttachment(
  companyId: number,
  ref: AttachmentRef
): Promise<RenderedAttachment | { error: string }> {
  switch (ref.kind) {
    case 'receipt': {
      const receipt = await getReceipt(companyId, ref.id)
      if (!receipt) return { error: 'Receipt #' + ref.id + ' no longer exists.' }
      return {
        filename: receiptFilename(receipt.number),
        bytes: receiptPdf(renderReceipt(receipt)),
        contentType: 'application/pdf',
      }
    }
    case 'bill':
      // The slot bills will fill. Refused rather than sent empty, so a row
      // queued before the renderer exists fails visibly.
      return { error: 'Bill documents are not available yet.' }
  }
}
