'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import { createTicket, type ActionResult } from '@/app/actions/tickets'
import { TicketCustomerPicker } from '@/components/tickets/TicketCustomerPicker'
import type { AgentOption } from '@/lib/data/checkoff'
import type { CustomerHit } from '@/lib/data/customer-search'
import {
  DEFAULT_TICKET_PRIORITY, TICKET_PRIORITIES, TICKET_PRIORITY_LABELS,
} from '@/lib/tickets'

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
  agents,
  presetCustomer,
  self,
  mayAssign,
  maySetPriority,
}: {
  /** Everyone a ticket can go to. Empty when the role may not assign. */
  agents: AgentOption[]
  /** From ?customer= on the customer record's New Ticket button. */
  presetCustomer: CustomerHit | null
  /** The signed-in user, offered as "Me" to a role that may not assign. */
  self: { id: number; name: string }
  /** assign_ticket: may put anyone on it. Without it, themselves or nobody. */
  mayAssign: boolean
  /** edit_ticket: may choose the priority. Without it, the default. */
  maySetPriority: boolean
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
        <Field
          label="Customer"
          htmlFor="customer_search"
          error={errors.customer_id}
          hint="Search as you would in the header: name, phone, address, MAC or #id."
          required
        >
          {/* The pick lives in the picker's own state, so a failed submit
              keeps it without re-seeding from what was posted. */}
          <TicketCustomerPicker
            initial={presetCustomer}
            inputId="customer_search"
            inputClassName={cls('customer_id')}
          />
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
          {/* Without edit_ticket nothing is posted and the ticket opens at the
              default; createTicket refuses a priority from such a role. */}
          {maySetPriority ? (
            <Field label="Priority" htmlFor="priority">
              <select
                id="priority"
                name="priority"
                defaultValue={v('priority') || DEFAULT_TICKET_PRIORITY}
                className={cls('priority')}
              >
                {TICKET_PRIORITIES.map((p) => (
                  <option key={p} value={p}>{TICKET_PRIORITY_LABELS[p]}</option>
                ))}
              </select>
            </Field>
          ) : (
            <Field label="Priority" hint="The office sets the priority.">
              <p className="py-2 text-sm text-gray-300">{TICKET_PRIORITY_LABELS[DEFAULT_TICKET_PRIORITY]}</p>
            </Field>
          )}

          <Field
            label="Assign To"
            htmlFor="assigned_to"
            error={errors.assigned_to}
            hint={mayAssign ? 'Optional — can be assigned later.' : 'Take it yourself, or leave it for the office to assign.'}
          >
            <select
              id="assigned_to"
              name="assigned_to"
              defaultValue={v('assigned_to')}
              className={cls('assigned_to')}
            >
              <option value="">Unassigned</option>
              {mayAssign
                ? agents.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))
                : <option value={self.id}>Me ({self.name})</option>}
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
