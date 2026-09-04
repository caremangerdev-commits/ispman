'use client'

import Link from 'next/link'
import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { CheckCircle2, MessageSquare, Pencil, RotateCcw, User, X } from 'lucide-react'

import {
  assignTicket, reopenTicket, resolveTicket, updateTicket, type ActionResult,
} from '@/app/actions/tickets'
import { TicketPriorityBadge, TicketStatusBadge } from '@/components/tickets/TicketBadges'
import { GpsField } from '@/components/ui/GpsField'
import { GpsLink } from '@/components/ui/GpsLink'
import type { AgentOption } from '@/lib/data/checkoff'
import type { TicketDetail as TicketDetailRow } from '@/lib/data/tickets'
import { fullName } from '@/lib/format'
import { hasGps } from '@/lib/gps'
import { can, type Role } from '@/lib/permissions'
import {
  TICKET_PRIORITIES, TICKET_PRIORITY_LABELS, toTicketStatus,
} from '@/lib/tickets'

const inputCls =
  'w-full rounded-md border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-white outline-none transition focus:border-blue-500 focus:ring-1 focus:ring-blue-500/40'

const dateTimeFmt = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString('en-US', {
        day: 'numeric', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      })
    : '—'

function Card({
  title, icon: Icon, children,
}: {
  title: string
  icon: React.ElementType
  children: React.ReactNode
}) {
  return (
    <section className="rounded-xl border border-gray-800 bg-gray-900">
      <header className="flex items-center gap-2 border-b border-gray-800 px-4 py-2.5">
        <Icon className="h-4 w-4 text-gray-500" aria-hidden />
        <h2 className="text-sm font-semibold text-white">{title}</h2>
      </header>
      {children}
    </section>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2">
      <dt className="shrink-0 text-xs text-gray-500">{label}</dt>
      <dd className="min-w-0 flex-1 text-right text-sm text-gray-200">{value}</dd>
    </div>
  )
}

function SubmitButton({ label, pendingLabel, className }: {
  label: string
  pendingLabel: string
  className: string
}) {
  const { pending } = useFormStatus()
  return (
    <button type="submit" disabled={pending} className={className + ' disabled:opacity-60'}>
      {pending ? pendingLabel : label}
    </button>
  )
}

export function TicketDetail({
  ticket,
  agents,
  role,
}: {
  ticket: TicketDetailRow
  agents: AgentOption[]
  role: Role
}) {
  const [editing, setEditing] = useState(false)
  const [resolving, setResolving] = useState(false)

  const [editState, editAction] = useActionState<ActionResult | null, FormData>(
    updateTicket, null
  )
  const [resolveState, resolveAction] = useActionState<ActionResult | null, FormData>(
    resolveTicket, null
  )

  const editErrors = editState && !editState.ok ? (editState.fieldErrors ?? {}) : {}
  const resolveErrors = resolveState && !resolveState.ok ? (resolveState.fieldErrors ?? {}) : {}

  const status = toTicketStatus(ticket.status)
  const isResolved = status === 'resolved'

  // The prompt appears only where it can do any good: a ticket attached to a
  // customer who has no coordinates on file. This is how coordinates actually
  // get collected — a technician already standing at the house taps a button.
  const customerGps = ticket.customers ? ticket.customers.gps : null
  const offerLocation = ticket.customer_id !== null && !hasGps(customerGps)

  const mayEdit = can(role, 'edit_ticket')
  const mayAssign = can(role, 'assign_ticket')
  const mayResolve = can(role, 'resolve_ticket')
  const mayReopen = can(role, 'reopen_ticket')

  const assigneeName = ticket.assignee
    ? [ticket.assignee.first_name, ticket.assignee.last_name].filter(Boolean).join(' ') ||
      ticket.assignee.email
    : null

  return (
    <div className="space-y-4">
      {/* ---------------- Header ---------------- */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          <h1 className="text-xl font-semibold tracking-tight text-white">{ticket.title}</h1>
          <TicketStatusBadge status={ticket.status} />
          <TicketPriorityBadge priority={ticket.priority} />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {mayEdit && !editing ? (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="inline-flex items-center gap-1 rounded-lg bg-gray-800 px-3 py-1.5 text-xs font-semibold text-gray-300 transition hover:bg-gray-700"
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden />
              Edit
            </button>
          ) : null}

          {mayResolve && !isResolved && !resolving ? (
            <button
              type="button"
              onClick={() => setResolving(true)}
              className="inline-flex items-center gap-1 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-green-500"
            >
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
              Resolve
            </button>
          ) : null}

          {mayReopen && isResolved ? (
            <form action={reopenTicket}>
              <input type="hidden" name="id" value={ticket.id} />
              <SubmitButton
                label="Reopen"
                pendingLabel="Reopening…"
                className="inline-flex items-center gap-1 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-amber-500"
              />
            </form>
          ) : null}
        </div>
      </div>

      {/* ---------------- Resolve form ---------------- */}
      {resolving && !isResolved ? (
        <form action={resolveAction} className="rounded-xl border border-green-900/50 bg-green-950/20 p-4">
          <input type="hidden" name="id" value={ticket.id} />

          <label htmlFor="resolution_notes" className="block text-xs font-medium text-gray-300">
            Resolution notes
            <span className="ml-0.5 text-red-400" aria-hidden>*</span>
          </label>
          <p className="mb-2 mt-0.5 text-[11px] text-gray-500">
            Required. What was actually done — this stays on the record if the ticket is
            reopened later.
          </p>

          <textarea
            id="resolution_notes"
            name="resolution_notes"
            rows={3}
            autoFocus
            className={inputCls + ' resize-y'}
          />

          {resolveErrors.resolution_notes ? (
            <p role="alert" className="mt-1 text-xs text-red-400">
              {resolveErrors.resolution_notes}
            </p>
          ) : null}

          {/* Optional, and it says so. Leaving it blank resolves the ticket
              exactly as it did before this step existed — the server treats an
              empty value as "nothing to record", never as a missing field. */}
          {offerLocation ? (
            <div className="mt-4 rounded-lg border border-gray-800 bg-gray-900/60 p-3">
              <label htmlFor="ticket-gps" className="block text-xs font-medium text-gray-300">
                Capture location
                <span className="ml-1.5 font-normal text-gray-500">Optional</span>
              </label>
              <p className="mb-2 mt-0.5 text-[11px] leading-snug text-gray-500">
                This customer has no coordinates on file. If you are at the property,
                capture them now. Skip it and the ticket resolves as normal.
              </p>
              <GpsField id="ticket-gps" name="gps" existing={null} />
            </div>
          ) : null}

          <div className="mt-3 flex items-center gap-2">
            <SubmitButton
              label="Confirm Resolve"
              pendingLabel="Resolving…"
              className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-green-500"
            />
            <button
              type="button"
              onClick={() => setResolving(false)}
              className="inline-flex items-center gap-1 rounded-lg bg-gray-800 px-3 py-1.5 text-xs font-semibold text-gray-300 transition hover:bg-gray-700"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ---------------- Details / edit ---------------- */}
        <Card title="Ticket" icon={MessageSquare}>
          {editing ? (
            <form action={editAction} className="space-y-3 p-4">
              <input type="hidden" name="id" value={ticket.id} />

              <div className="space-y-1.5">
                <label htmlFor="title" className="block text-xs font-medium text-gray-400">
                  Title<span className="ml-0.5 text-red-400" aria-hidden>*</span>
                </label>
                <input id="title" name="title" defaultValue={ticket.title} className={inputCls} />
                {editErrors.title ? (
                  <p role="alert" className="text-xs text-red-400">{editErrors.title}</p>
                ) : null}
              </div>

              <div className="space-y-1.5">
                <label htmlFor="description" className="block text-xs font-medium text-gray-400">
                  Description
                </label>
                <textarea
                  id="description"
                  name="description"
                  rows={5}
                  defaultValue={ticket.description ?? ''}
                  className={inputCls + ' resize-y'}
                />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="priority" className="block text-xs font-medium text-gray-400">
                  Priority
                </label>
                <select
                  id="priority"
                  name="priority"
                  defaultValue={ticket.priority ?? 'medium'}
                  className={inputCls}
                >
                  {TICKET_PRIORITIES.map((p) => (
                    <option key={p} value={p}>{TICKET_PRIORITY_LABELS[p]}</option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <SubmitButton
                  label="Save Changes"
                  pendingLabel="Saving…"
                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-blue-500"
                />
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="rounded-lg bg-gray-800 px-3 py-1.5 text-xs font-semibold text-gray-300 transition hover:bg-gray-700"
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <>
              <dl className="divide-y divide-gray-800/70">
                <Row
                  label="Customer"
                  value={
                    ticket.customer_id ? (
                      <Link
                        href={'/dashboard/customers/' + ticket.customer_id}
                        className="text-blue-400 transition hover:text-blue-300"
                      >
                        {fullName(ticket.customers)}
                      </Link>
                    ) : (
                      <span className="text-gray-500">—</span>
                    )
                  }
                />
                {/* Only where there is something to open. A customer with no
                    coordinates gets no row rather than an empty one. */}
                {hasGps(customerGps) ? (
                  <Row label="Location" value={<GpsLink value={customerGps} />} />
                ) : null}
                <Row label="Created" value={dateTimeFmt(ticket.created_at)} />
                <Row
                  label="Resolved"
                  value={
                    ticket.resolved_at ? (
                      dateTimeFmt(ticket.resolved_at)
                    ) : (
                      <span className="text-gray-500">—</span>
                    )
                  }
                />
              </dl>

              <div className="border-t border-gray-800/70 px-4 py-3">
                <p className="text-xs text-gray-500">Description</p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-gray-200">
                  {ticket.description ?? <span className="text-gray-600">None given.</span>}
                </p>
              </div>
            </>
          )}
        </Card>

        {/* ---------------- Assignment and resolution ---------------- */}
        <div className="space-y-4">
          <Card title="Assignment" icon={User}>
            <div className="p-4">
              <p className="text-xs text-gray-500">Currently assigned to</p>
              <p className="mt-0.5 text-sm font-medium text-gray-200">
                {assigneeName ?? <span className="text-gray-500">Unassigned</span>}
              </p>

              {mayAssign ? (
                <form action={assignTicket} className="mt-3 flex items-center gap-2">
                  <input type="hidden" name="id" value={ticket.id} />
                  <select
                    name="assigned_to"
                    defaultValue={ticket.assigned_to ?? ''}
                    aria-label="Reassign ticket"
                    className={inputCls}
                  >
                    <option value="">Unassigned</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                  <SubmitButton
                    label="Assign"
                    pendingLabel="Saving…"
                    className="shrink-0 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-blue-500"
                  />
                </form>
              ) : null}
            </div>
          </Card>

          {/* Shown whenever notes exist, including on a reopened ticket — what
              was tried last time is the most useful thing to know. */}
          {ticket.resolution_notes ? (
            <Card title="Resolution Notes" icon={RotateCcw}>
              <div className="p-4">
                <p className="whitespace-pre-wrap text-sm text-gray-200">
                  {ticket.resolution_notes}
                </p>
                {!isResolved ? (
                  <p className="mt-2 text-[11px] text-gray-600">
                    From a previous resolution. This ticket has since been reopened.
                  </p>
                ) : null}
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  )
}
