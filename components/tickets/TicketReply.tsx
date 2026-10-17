'use client'

import { useActionState } from 'react'

import { replyTicket, type ActionResult } from '@/app/actions/tickets'

/**
 * A staff reply onto a ticket thread. On success it texts the customer if the
 * company has ticket-reply SMS switched on (off by default).
 */
export function TicketReply({ ticketId }: { ticketId: number }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(replyTicket, null)

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="ticket_id" value={ticketId} />
      <textarea
        name="body"
        rows={3}
        required
        placeholder="Reply to the customer…"
        className="w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 outline-none focus:border-gray-500"
      />
      {state && !state.ok ? <p className="text-xs text-red-400">{state.error}</p> : null}
      {state && state.ok ? <p className="text-xs text-green-400">Reply sent.</p> : null}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
      >
        {pending ? 'Sending…' : 'Send reply'}
      </button>
    </form>
  )
}
