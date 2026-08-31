'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import { createTicket, type ActionResult } from '@/app/actions/tickets'
import type { AgentOption } from '@/lib/data/checkoff'
import type { TicketCustomerOption } from '@/lib/data/tickets'
import { fullName } from '@/lib/format'
import { TICKET_PRIORITIES, TICKET_PRIORITY_LABELS } from '@/lib/tickets'

const inputBase =
  'w-full rounded-lg border bg-gray-800 px-3 py-2 text-sm text-white placeholder:text-gray-500 outline-none transition focus:ring-2'
const inputOk = ' border-gray-700 focus:border-blue-500 focus:ring-blue-500/30'
const inputBad = ' border-red-700 focus:border-red-500 focus:ring-red-500/30'

function Field({
  label, htmlFor, error, hint, required, children,
}: {
  label: string
  htmlFor?: string
  error?: string
  hint?: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-xs font-medium text-gray-400">
        {label}
        {required ? <span className="ml-0.5 text-red-400" aria-hidden>*</span> : null}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-xs text-red-400">{error}</p>
      ) : hint ? (
        <p className="text-[11px] text-gray-600">{hint}</p>
      ) : null}
    </div>
  )
}

function SaveButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? 'Saving…' : 'Create Ticket'}
    </button>
  )
}

export function NewTicketForm({
  customers,
  agents,
  presetCustomerId,
}: {
  customers: TicketCustomerOption[]
  agents: AgentOption[]
  /** From ?customer= on the customer record's New Ticket button. */
  presetCustomerId: string
}) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(createTicket, null)

  const prior = state && !state.ok ? (state.values ?? {}) : {}
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {}
  const v = (name: string) => prior[name] ?? ''
  const cls = (name: string) => inputBase + (errors[name] ? inputBad : inputOk)

  return (
    <form action={formAction} className="space-y-4">
      {state && !state.ok ? (
        <p role="alert" className="rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-2.5 text-sm text-red-300">
          {state.error}
        </p>
      ) : null}

      <section className="space-y-4 rounded-xl border border-gray-800 bg-gray-900 p-5">
        <Field label="Customer" htmlFor="customer_id" error={errors.customer_id} required>
          <select
            id="customer_id"
            name="customer_id"
            // A failed submit re-seeds from what was posted; otherwise the
            // preset from the customer record wins.
            defaultValue={v('customer_id') || presetCustomerId}
            className={cls('customer_id')}
          >
            <option value="">Select a customer…</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{fullName(c)}</option>
            ))}
          </select>
        </Field>

        <Field label="Title" htmlFor="title" error={errors.title} required>
          <input
            id="title"
            name="title"
            defaultValue={v('title')}
            placeholder="Short summary of the problem"
            className={cls('title')}
          />
        </Field>

        <Field
          label="Description"
          htmlFor="description"
          hint="What the customer reported, and anything already tried."
        >
          <textarea
            id="description"
            name="description"
            rows={4}
            defaultValue={v('description')}
            className={cls('description') + ' resize-y'}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Priority" htmlFor="priority">
            <select
              id="priority"
              name="priority"
              defaultValue={v('priority') || 'medium'}
              className={cls('priority')}
            >
              {TICKET_PRIORITIES.map((p) => (
                <option key={p} value={p}>{TICKET_PRIORITY_LABELS[p]}</option>
              ))}
            </select>
          </Field>

          <Field
            label="Assign To"
            htmlFor="assigned_to"
            error={errors.assigned_to}
            hint="Optional — can be assigned later."
          >
            <select
              id="assigned_to"
              name="assigned_to"
              defaultValue={v('assigned_to')}
              className={cls('assigned_to')}
            >
              <option value="">Unassigned</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </Field>
        </div>
      </section>

      <div className="flex items-center gap-2">
        <SaveButton />
        <Link
          href="/dashboard/tickets"
          className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-semibold text-gray-300 transition hover:bg-gray-700"
        >
          Cancel
        </Link>
      </div>
    </form>
  )
}
