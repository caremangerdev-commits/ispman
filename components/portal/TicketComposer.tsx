'use client'

import { useActionState } from 'react'

import { openTicket, replyToTicket, type TicketActionState } from '@/app/actions/portal'
import styles from '@/components/portal/portal.module.css'

/**
 * Opens a ticket or replies to one. A real form with a file input so a customer
 * can attach a photo straight from the camera; on success the action redirects
 * to the ticket, so only the error is rendered here.
 */
export function TicketComposer(props: { mode: 'new' } | { mode: 'reply'; ticketId: number }) {
  const action = props.mode === 'new' ? openTicket : replyToTicket
  const [state, submit, pending] = useActionState<TicketActionState, FormData>(action, null)

  return (
    <form action={submit} className={styles.stack}>
      {props.mode === 'reply' ? <input type="hidden" name="ticket_id" value={props.ticketId} /> : null}

      {props.mode === 'new' ? (
        <input
          name="subject"
          required
          maxLength={120}
          placeholder="What’s the problem? (e.g. No internet)"
          aria-label="Subject"
          className={styles.input}
        />
      ) : null}

      <textarea
        name={props.mode === 'new' ? 'description' : 'body'}
        rows={props.mode === 'new' ? 4 : 3}
        required={props.mode === 'new'}
        maxLength={2000}
        placeholder={props.mode === 'new' ? 'Describe what’s happening.' : 'Write a reply…'}
        aria-label="Message"
        className={styles.input}
      />

      <label>
        <span className={styles.label}>Add a photo (optional)</span>
        <input name="photo" type="file" accept="image/*" capture="environment" className={styles.file} />
      </label>

      {state && !state.ok ? <p className={styles.error + ' ' + styles.mt0} role="alert">{state.error}</p> : null}

      <button type="submit" disabled={pending} className={styles.btn + ' ' + styles.flush}>
        {pending ? 'Sending…' : props.mode === 'new' ? 'Open ticket' : 'Send reply'}
      </button>
    </form>
  )
}
