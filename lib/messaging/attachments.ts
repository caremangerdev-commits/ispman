import 'server-only'

import { billFilename, billPdf } from '@/lib/bill/pdf'
import { toBillTemplate, type BillTemplate } from '@/lib/bill/settings'
import { loadBill } from '@/lib/data/bill'
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
 * A BILL is '{"kind":"bill","id":<customer id>,"template":"statement"}': the
 * customer's current bill, drawn by lib/bill/pdf.ts#billPdf from
 * lib/data/bill.ts#loadBill — the same loader and renderer as the portal's
 * download and the staff "Bill (PDF)" link, so an emailed bill cannot be a
 * different document from either. The template is the company's choice at the
 * moment staff pressed Email, pinned so the cover note that was written then
 * and the PDF drawn now name the same kind of document.
 */

export type AttachmentRef =
  | { kind: 'receipt'; id: number }
  | { kind: 'bill'; id: number; template: BillTemplate }

export type RenderedAttachment = { filename: string; bytes: Uint8Array; contentType: string }

export function parseAttachmentRef(raw: string | null | undefined): AttachmentRef | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as { kind?: string; id?: number; template?: string }
    if (!Number.isInteger(v.id)) return null
    if (v.kind === 'receipt') return { kind: 'receipt', id: v.id as number }
    if (v.kind === 'bill') return { kind: 'bill', id: v.id as number, template: toBillTemplate(v.template) }
  } catch { /* fall through */ }
  return null
}

export function serialiseAttachmentRef(ref: AttachmentRef): string {
  return JSON.stringify(ref.kind === 'bill'
    ? { kind: ref.kind, id: ref.id, template: ref.template }
    : { kind: ref.kind, id: ref.id })
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
    case 'bill': {
      const bill = await loadBill(companyId, ref.id, { template: ref.template })
      if (!bill) return { error: 'Customer #' + ref.id + ' no longer exists.' }
      return { filename: billFilename(bill), bytes: billPdf(bill), contentType: 'application/pdf' }
    }
  }
}
