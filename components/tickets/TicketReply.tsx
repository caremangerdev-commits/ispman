'use client'

import { useActionState, useState } from 'react'

import { replyTicket, type ActionResult } from '@/app/actions/tickets'

/**
 * Adds to a ticket's thread: a reply the customer sees (and is texted about, if
 * the company has ticket-reply SMS switched on — off by default), or an
 * internal note only staff see. Either may carry one photo.
 *
 * The note option is there only once migration 0041 has added the column that
 * keeps notes out of the customer's thread (`notesAvailable`); the server
 * refuses a note without it, so nothing meant for staff lands as a reply.
 */
export function TicketReply({ ticketId, notesAvailable }: { ticketId: number; notesAvailable: boolean }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(replyTicket, null)
  const [kind, setKind] = useState<'reply' | 'note'>('reply')
  const note = notesAvailable && kind === 'note'

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="ticket_id" value={ticketId} />
      <input type="hidden" name="kind" value={note ? 'note' : 'reply'} />

      {notesAvailable ? (
        <div className="flex gap-1.5" role="group" aria-label="Message type">
          {(['reply', 'note'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              aria-pressed={kind === k}
              className={
                'rounded-md px-2.5 py-1 text-xs font-semibold transition ' +
                (kind === k
                  ? k === 'note' ? 'bg-amber-600 text-white' : 'bg-indigo-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200')
              }
            >
              {k === 'reply' ? 'Reply to customer' : 'Internal note'}
            </button>
          ))}
        </div>
      ) : null}

      <textarea
        name="body"
        rows={3}
        placeholder={note ? 'A note for staff — the customer never sees this…' : 'Reply to the customer…'}
        className={
          'w-full rounded-md border bg-gray-900 px-3 py-2 text-sm text-gray-100 outline-none ' +
          (note ? 'border-amber-900/70 focus:border-amber-600' : 'border-gray-700 focus:border-gray-500')
        }
      />

      <label className="block text-xs text-gray-400">
        <span className="mb-1 block">Photo <span className="text-gray-600">(optional, under 4 MB)</span></span>
        <input
          type="file"
          name="photo"
          accept="image/*"
          className="block w-full text-xs text-gray-400 file:mr-3 file:rounded-md file:border-0 file:bg-gray-800 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-gray-300 hover:file:bg-gray-700"
        />
      </label>

      {state && !state.ok ? <p className="text-xs text-red-400">{state.error}</p> : null}
      {state && state.ok ? <p className="text-xs text-green-400">Posted.</p> : null}
      <button
        type="submit"
        disabled={pending}
        className={
          'rounded-md px-4 py-2 text-sm font-medium text-white transition disabled:opacity-50 ' +
          (note ? 'bg-amber-600 hover:bg-amber-500' : 'bg-indigo-600 hover:bg-indigo-500')
        }
      >
        {pending ? 'Posting…' : note ? 'Add note' : 'Send reply'}
      </button>
    </form>
  )
}
