'use client'

import { Download, Loader2, Printer, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { loadReceipt } from '@/app/actions/receipts'
import { renderReceipt, type Receipt } from '@/lib/receipt'
import { receiptFilename, receiptPdf } from '@/lib/receipt-pdf'

/**
 * The receipt itself, as fixed-width lines.
 *
 * Rendered from `renderReceipt` rather than laid out in HTML, because the
 * printed receipt, the PDF and this are required to be the same thing. Columns
 * built out of flex rows here would align differently from the PDF's monospace
 * grid, and the first receipt where the amount did not line up would be the
 * one the customer queries.
 *
 * `receipt-print` is the hook the print stylesheet uses to make this the only
 * thing on the page (app/globals.css).
 */
function ReceiptBody({ receipt }: { receipt: Receipt }) {
  return (
    <pre className="receipt-print whitespace-pre font-mono text-[13px] leading-[1.45] text-black">
      {renderReceipt(receipt).join('\n')}
    </pre>
  )
}

/**
 * The receipt shown after a payment, and again whenever one is reprinted.
 *
 * It never receives a receipt as a prop: given a payment id it reads the stored
 * row back through `loadReceipt`. That is what makes a reprint identical to the
 * original — both are this component, reading the same row, running the same
 * renderer.
 */
export function ReceiptModal({
  paymentId,
  title = 'Payment recorded',
  subtitle,
  onClose,
}: {
  paymentId: number
  title?: string
  /** e.g. "J$8,000 from Omar Sinclair". Omitted on a reprint. */
  subtitle?: string
  onClose: () => void
}) {
  // Both results carry the id they belong to, so switching payments shows a
  // loading state immediately without the effect having to synchronously clear
  // anything first. What is on screen is derived from whether the stored result
  // matches the payment being asked for.
  const [loaded, setLoaded] = useState<{ id: number; receipt: Receipt } | null>(null)
  const [failed, setFailed] = useState<{ id: number; message: string } | null>(null)

  const receipt = loaded?.id === paymentId ? loaded.receipt : null
  const error = failed?.id === paymentId ? failed.message : null

  useEffect(() => {
    let live = true

    loadReceipt(paymentId)
      .then((r) => {
        if (!live) return
        if (r) setLoaded({ id: paymentId, receipt: r })
        else setFailed({ id: paymentId, message: 'That receipt could not be found.' })
      })
      .catch(() => {
        if (live) setFailed({ id: paymentId, message: 'The receipt could not be loaded.' })
      })

    return () => {
      live = false
    }
  }, [paymentId])

  // Escape closes, matching every other dialog in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function download() {
    if (!receipt) return

    const bytes = receiptPdf(renderReceipt(receipt))
    // Copied into a fresh ArrayBuffer so the Blob is built from a plain
    // ArrayBuffer rather than a possibly-shared view.
    const blob = new Blob([bytes.slice().buffer], { type: 'application/pdf' })
    const url = URL.createObjectURL(blob)

    const a = document.createElement('a')
    a.href = url
    a.download = receiptFilename(receipt.number)
    document.body.appendChild(a)
    a.click()
    a.remove()

    // Revoked on the next tick: revoking synchronously can cancel the download
    // in some browsers before it has read the blob.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div
      // `receipt-overlay` is hidden wholesale by the print stylesheet; the
      // receipt inside it is made visible again. Printing therefore produces
      // the receipt alone, with no dialog frame or backdrop around it.
      className="receipt-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Payment receipt"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="max-h-full w-full max-w-sm overflow-y-auto rounded-xl border border-gray-800 bg-gray-900 shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-gray-800 px-5 py-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-white">{title}</p>
            {subtitle ? <p className="mt-0.5 text-xs text-gray-400">{subtitle}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-md p-1 text-gray-400 transition hover:bg-gray-800 hover:text-white"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="p-5">
          {error ? (
            <p role="alert" className="rounded-lg border border-red-900/60 bg-red-950/50 px-3 py-2 text-sm text-red-300">
              {error}
            </p>
          ) : !receipt ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Loading receipt…
            </div>
          ) : (
            // White paper on a dark app, because that is what it will print as.
            <div className="overflow-x-auto rounded-lg bg-white p-4">
              <ReceiptBody receipt={receipt} />
            </div>
          )}
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-gray-800 px-5 py-4">
          <button
            type="button"
            onClick={() => window.print()}
            disabled={!receipt}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Printer className="h-4 w-4" aria-hidden />
            Print
          </button>
          <button
            type="button"
            onClick={download}
            disabled={!receipt}
            className="inline-flex items-center gap-1.5 rounded-lg bg-gray-800 px-3.5 py-2 text-sm font-semibold text-gray-200 transition hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Download className="h-4 w-4" aria-hidden />
            Download
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-gray-800 px-3.5 py-2 text-sm font-semibold text-gray-200 transition hover:bg-gray-700"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * A Print action for one payment, for the payment list and detail pages.
 *
 * Opens the same modal the cashier saw when the payment was taken.
 */
export function ReceiptButton({
  paymentId,
  className,
  children,
}: {
  paymentId: number
  className?: string
  children?: React.ReactNode
}) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Print receipt"
        className={
          className ??
          'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold text-gray-400 transition hover:bg-gray-800 hover:text-white'
        }
      >
        <Printer className="h-3.5 w-3.5" aria-hidden />
        {children ?? 'Print'}
      </button>

      {open ? (
        <ReceiptModal
          paymentId={paymentId}
          title="Receipt"
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}
