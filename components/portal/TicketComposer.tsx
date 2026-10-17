'use client'

import { useActionState } from 'react'

import { openTicket, replyToTicket, type TicketActionState } from '@/app/actions/portal'
import { primaryButtonClass } from '@/components/portal/Brand'
import type { BrandPalette } from '@/lib/brand'

/**
 * Opens a ticket or replies to one. A real form with a file input so a customer
 * can attach a photo straight from the camera; on success the action redirects
 * to the ticket, so only the error is rendered here.
 */
export function TicketComposer(
  props: ({ mode: 'new' } | { mode: 'reply'; ticketId: number }) & { palette: BrandPalette }
) {
  const action = props.mode === 'new' ? openTicket : replyToTicket
  const [state, submit, pending] = useActionState<TicketActionState, FormData>(action, null)

  return (
    <form action={submit} className="flex flex-col gap-4">
      {props.mode === 'reply' ? <input type="hidden" name="ticket_id" value={props.ticketId} /> : null}

      {props.mode === 'new' ? (
        <input
          name="subject"
          required
          maxLength={120}
          placeholder="What’s the problem? (e.g. No internet)"
          aria-label="Subject"
          className="w-full rounded-xl border border-neutral-300 px-4 py-4 text-base outline-none focus:border-neutral-900"
        />
      ) : null}

      <textarea
        name={props.mode === 'new' ? 'description' : 'body'}
        rows={props.mode === 'new' ? 4 : 3}
        required={props.mode === 'new'}
        maxLength={2000}
        placeholder={props.mode === 'new' ? 'Describe what’s happening.' : 'Write a reply…'}
        aria-label="Message"
        className="w-full resize-y rounded-xl border border-neutral-300 px-4 py-3 text-base outline-none focus:border-neutral-900"
      />

      <label className="flex flex-col gap-1">
        <span className="text-sm text-neutral-500">Add a photo (optional)</span>
        <input
          name="photo"
          type="file"
          accept="image/*"
          capture="environment"
          className="text-base file:mr-3 file:rounded-lg file:border-0 file:bg-neutral-100 file:px-4 file:py-2 file:text-base"
        />
      </label>

      {state && !state.ok ? <p className="text-base text-red-600">{state.error}</p> : null}

      <button
        type="submit"
        disabled={pending}
        className={primaryButtonClass}
        style={{ backgroundColor: props.palette.accent, color: props.palette.onAccent }}
      >
        {pending ? 'Sending…' : props.mode === 'new' ? 'Open ticket' : 'Send reply'}
      </button>
    </form>
  )
}
