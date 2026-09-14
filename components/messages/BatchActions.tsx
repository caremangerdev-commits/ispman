'use client'

import { AlertTriangle, RefreshCw, RotateCcw } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { checkBatchDelivery, retryFailedInBatch } from '@/app/actions/sms'

/**
 * The two things an operator can do about a batch after it has gone out.
 *
 * Check delivery asks the relay what the phone did with every message still
 * marked 'sent'. Retry re-queues the ones that failed — and only those; a
 * message that was delivered, or that the relay still holds as sent, is not
 * touched. Retry is offered only once something IS marked failed, which is why
 * the check comes first: "291 sent" with 196 quietly dead on the handset is
 * exactly the state this pair exists to get out of.
 */
export function BatchActions({
  batchId, failed, unresolved,
}: {
  batchId: number
  /** Rows currently marked failed. */
  failed: number
  /** Rows marked sent that the relay has not yet answered for. */
  unresolved: number
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  const run = (action: () => Promise<{ ok: true; message: string } | { ok: false; error: string }>) => {
    setNote(null)
    startTransition(async () => {
      const res = await action()
      setNote(res.ok ? { ok: true, text: res.message } : { ok: false, text: res.error })
      router.refresh()
    })
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => run(() => checkBatchDelivery(batchId))}
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-lg bg-gray-800 px-3 py-1.5 text-xs font-semibold text-gray-200 transition hover:bg-gray-700 disabled:opacity-50"
        >
          <RefreshCw className={'h-3.5 w-3.5 ' + (pending ? 'animate-spin' : '')} aria-hidden />
          Check delivery{unresolved > 0 ? ' (' + unresolved + ' unresolved)' : ''}
        </button>

        {failed > 0 ? (
          <button
            type="button"
            onClick={() => {
              if (confirm('Re-queue the ' + failed + ' failed message' + (failed === 1 ? '' : 's') + '? Delivered ones are not resent.')) {
                run(() => retryFailedInBatch(batchId))
              }
            }}
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-blue-500 disabled:opacity-50"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            Retry {failed} failed
          </button>
        ) : null}
      </div>

      {note ? (
        <p
          className={
            'flex items-start gap-1.5 rounded-lg px-3 py-2 text-xs ' +
            (note.ok ? 'bg-gray-950 text-gray-300' : 'bg-red-950/40 text-red-300')
          }
        >
          {note.ok ? null : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />}
          {note.text}
        </p>
      ) : null}
    </div>
  )
}
