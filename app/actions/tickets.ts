'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { logEvent } from '@/lib/audit'
import { can, type Permission } from '@/lib/permissions'
import { getSession } from '@/lib/session'
import { tenantClient } from '@/lib/supabase/tenant'
import { toTicketPriority } from '@/lib/tickets'

/**
 * Every mutation re-checks its own permission.
 *
 * Same reasoning as app/actions/customers.ts: hiding a button only removes the
 * obvious path — a server action is a public POST endpoint.
 */
async function authorize(permission: Permission) {
  const session = await getSession()
  if (!can(session.profile.role, permission)) {
    throw new Error(
      'Forbidden: role "' + session.profile.role + '" lacks ' + permission + '.'
    )
  }
  return session
}

export type SubmittedValues = Record<string, string>
export type FieldErrors = Record<string, string>

export type ActionResult =
  | { ok: true }
  | { ok: false; error: string; values?: SubmittedValues; fieldErrors?: FieldErrors }

const KEEP_FIELDS = ['customer_id', 'title', 'description', 'priority', 'assigned_to']

function submitted(fd: FormData): SubmittedValues {
  const out: SubmittedValues = {}
  for (const key of KEEP_FIELDS) {
    const v = fd.get(key)
    if (typeof v === 'string') out[key] = v
  }
  return out
}

const str = (fd: FormData, key: string) => {
  const v = fd.get(key)
  return typeof v === 'string' ? v.trim() : ''
}

/** Optional integer form field — empty and non-numeric both mean "not set". */
function idOrNull(fd: FormData, key: string): number | null {
  const raw = str(fd, key)
  if (!raw) return null
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

function toast(path: string, message: string, kind?: 'error'): never {
  redirect(
    path + (path.includes('?') ? '&' : '?') +
    (kind === 'error' ? 'toastKind=error&' : '') +
    'toast=' + encodeURIComponent(message)
  )
}

/**
 * Writes one audit row for a ticket change.
 *
 * Goes through lib/audit.ts#logEvent, the single writer for the `log` table,
 * which owns the tenant id, the actor and the platform-operator marker. A
 * failure is reported to the console and swallowed there: the ticket change
 * already landed, and undoing it to keep the log tidy would take away the thing
 * the operator actually asked for.
 *
 * The type strings follow the app's own convention (`payment_recorded`,
 * `network_provision`), not the shorter values left behind by the seed.
 */
async function logTicketEvent(opts: {
  companyId: number
  userId: number
  customerId: number | null
  type: 'ticket_created' | 'ticket_assigned' | 'ticket_resolved'
  details: string
}) {
  await logEvent({
    companyId: opts.companyId,
    userId: opts.userId,
    customerId: opts.customerId,
    type: opts.type,
    details: opts.details,
    tag: '[tickets]',
  })
}

/** Operator name for the audit line. */
function actor(profile: { first_name: string | null }) {
  return profile.first_name ?? 'an operator'
}

/** Confirms a ticket belongs to this company before any write touches it. */
async function loadTicket(companyId: number, id: number) {
  const { data } = await tenantClient()
    .from('support_tickets')
    .select('id, title, customer_id, assigned_to, status')
    .eq('company_id', companyId)
    .eq('id', id)
    .maybeSingle()

  return data as unknown as {
    id: number
    title: string
    customer_id: number | null
    assigned_to: number | null
    status: string | null
  } | null
}

/** Assignee display name for audit lines, resolved from the users table. */
async function assigneeName(companyId: number, userId: number | null): Promise<string> {
  if (userId === null) return 'nobody'

  const { data } = await tenantClient()
    .from('users')
    .select('first_name, last_name, email')
    .eq('company_id', companyId)
    .eq('id', userId)
    .maybeSingle()

  const u = data as unknown as {
    first_name: string | null; last_name: string | null; email: string
  } | null

  if (!u) return 'user #' + userId
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email
}

function revalidateTicket(id?: number) {
  revalidatePath('/dashboard/tickets')
  revalidatePath('/dashboard')
  if (id) revalidatePath('/dashboard/tickets/' + id)
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createTicket(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const { company, profile } = await authorize('create_ticket')

  const values = submitted(formData)
  const fieldErrors: FieldErrors = {}

  const customerId = idOrNull(formData, 'customer_id')
  const title = str(formData, 'title')
  const description = str(formData, 'description')
  const priority = toTicketPriority(str(formData, 'priority'))
  const assignedTo = idOrNull(formData, 'assigned_to')

  if (customerId === null) fieldErrors.customer_id = 'Choose a customer.'
  if (!title) fieldErrors.title = 'A title is required.'

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, error: 'Please correct the highlighted fields.', values, fieldErrors }
  }

  // The aggregate check above has already returned when this is null. Restating
  // it narrows the type for the queries below.
  if (customerId === null) return { ok: false, error: 'Choose a customer.', values }

  const db = tenantClient()

  // The customer must belong to this company — customer_id arrives from a form,
  // and an unchecked one would file a ticket against another tenant's record.
  const { data: customer } = await db
    .from('customers')
    .select('id')
    .eq('company_id', company.id)
    .eq('id', customerId)
    .maybeSingle()

  if (!customer) {
    fieldErrors.customer_id = 'That customer no longer exists.'
    return { ok: false, error: 'Please correct the highlighted fields.', values, fieldErrors }
  }

  // Same check for the assignee: a user id from a form is user input too.
  if (assignedTo !== null) {
    const { data: user } = await db
      .from('users')
      .select('id')
      .eq('company_id', company.id)
      .eq('id', assignedTo)
      .maybeSingle()

    if (!user) {
      fieldErrors.assigned_to = 'That user is not in this company.'
      return { ok: false, error: 'Please correct the highlighted fields.', values, fieldErrors }
    }
  }

  const { data: inserted, error } = await db
    .from('support_tickets')
    .insert({
      company_id: company.id,
      customer_id: customerId,
      title,
      description: description || null,
      priority,
      status: 'open',
      assigned_to: assignedTo,
    })
    .select('id')
    .single()

  if (error) return { ok: false, error: 'Could not create ticket: ' + error.message, values }

  const newId = (inserted as { id: number } | null)?.id ?? null

  await logTicketEvent({
    companyId: company.id,
    userId: profile.id,
    customerId,
    type: 'ticket_created',
    details:
      'Ticket ' + JSON.stringify(title) + ' opened at ' + priority + ' priority by ' +
      actor(profile) + ' | assigned_to=' + (assignedTo ?? 'nobody'),
  })

  revalidateTicket()
  revalidatePath('/dashboard/customers/' + customerId)

  toast(newId ? '/dashboard/tickets/' + newId : '/dashboard/tickets', 'Ticket created.')
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

export async function updateTicket(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const { company } = await authorize('edit_ticket')

  const id = idOrNull(formData, 'id')
  if (id === null) return { ok: false, error: 'Missing ticket id.' }

  const values = submitted(formData)
  const fieldErrors: FieldErrors = {}

  const title = str(formData, 'title')
  const description = str(formData, 'description')
  const priority = toTicketPriority(str(formData, 'priority'))

  if (!title) fieldErrors.title = 'A title is required.'
  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, error: 'Please correct the highlighted fields.', values, fieldErrors }
  }

  const existing = await loadTicket(company.id, id)
  if (!existing) return { ok: false, error: 'That ticket no longer exists.' }

  const { error } = await tenantClient()
    .from('support_tickets')
    .update({ title, description: description || null, priority })
    .eq('company_id', company.id)
    .eq('id', id)

  if (error) return { ok: false, error: 'Could not save ticket: ' + error.message, values }

  // Deliberately not logged. Create, assign and resolve are the three events
  // this app audits; recording every wording or priority tweak alongside them
  // would bury the entries that matter.

  revalidateTicket(id)
  if (existing.customer_id) revalidatePath('/dashboard/customers/' + existing.customer_id)

  toast('/dashboard/tickets/' + id, 'Ticket updated.')
}

// ---------------------------------------------------------------------------
// Assign
// ---------------------------------------------------------------------------

export async function assignTicket(formData: FormData) {
  const { company, profile } = await authorize('assign_ticket')

  const id = idOrNull(formData, 'id')
  if (id === null) throw new Error('Missing ticket id.')

  const assignedTo = idOrNull(formData, 'assigned_to')

  const existing = await loadTicket(company.id, id)
  if (!existing) toast('/dashboard/tickets', 'That ticket no longer exists.', 'error')

  const db = tenantClient()

  if (assignedTo !== null) {
    const { data: user } = await db
      .from('users')
      .select('id')
      .eq('company_id', company.id)
      .eq('id', assignedTo)
      .maybeSingle()

    if (!user) toast('/dashboard/tickets/' + id, 'That user is not in this company.', 'error')
  }

  // Nothing to do, and an audit row reading "reassigned to the same person"
  // would be noise.
  if (existing.assigned_to === assignedTo) {
    toast('/dashboard/tickets/' + id, 'Assignment unchanged.')
  }

  const { error } = await db
    .from('support_tickets')
    .update({ assigned_to: assignedTo })
    .eq('company_id', company.id)
    .eq('id', id)

  if (error) toast('/dashboard/tickets/' + id, 'Could not reassign: ' + error.message, 'error')

  const [from, to] = await Promise.all([
    assigneeName(company.id, existing.assigned_to),
    assigneeName(company.id, assignedTo),
  ])

  await logTicketEvent({
    companyId: company.id,
    userId: profile.id,
    customerId: existing.customer_id,
    type: 'ticket_assigned',
    details:
      'Ticket ' + JSON.stringify(existing.title) + ' reassigned from ' + from + ' to ' + to +
      ' by ' + actor(profile),
  })

  revalidateTicket(id)
  if (existing.customer_id) revalidatePath('/dashboard/customers/' + existing.customer_id)

  toast('/dashboard/tickets/' + id, 'Ticket assigned to ' + to + '.')
}

// ---------------------------------------------------------------------------
// Resolve and reopen
// ---------------------------------------------------------------------------

export async function resolveTicket(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const { company, profile } = await authorize('resolve_ticket')

  const id = idOrNull(formData, 'id')
  if (id === null) return { ok: false, error: 'Missing ticket id.' }

  const notes = str(formData, 'resolution_notes')
  if (!notes) {
    return {
      ok: false,
      error: 'Please correct the highlighted fields.',
      values: { resolution_notes: notes },
      fieldErrors: { resolution_notes: 'Say what was done to resolve this.' },
    }
  }

  const existing = await loadTicket(company.id, id)
  if (!existing) return { ok: false, error: 'That ticket no longer exists.' }

  const { error } = await tenantClient()
    .from('support_tickets')
    .update({
      status: 'resolved',
      resolution_notes: notes,
      resolved_at: new Date().toISOString(),
    })
    .eq('company_id', company.id)
    .eq('id', id)

  if (error) return { ok: false, error: 'Could not resolve ticket: ' + error.message }

  await logTicketEvent({
    companyId: company.id,
    userId: profile.id,
    customerId: existing.customer_id,
    type: 'ticket_resolved',
    details:
      'Ticket ' + JSON.stringify(existing.title) + ' resolved by ' + actor(profile) +
      ' | ' + notes,
  })

  revalidateTicket(id)
  if (existing.customer_id) revalidatePath('/dashboard/customers/' + existing.customer_id)

  toast('/dashboard/tickets/' + id, 'Ticket resolved.')
}

/**
 * Puts a resolved ticket back into play.
 *
 * resolution_notes is deliberately left on the record: what was tried last time
 * is the most useful thing to know when a fault comes back. Only resolved_at is
 * cleared, because the ticket is no longer resolved.
 */
export async function reopenTicket(formData: FormData) {
  const { company, profile } = await authorize('reopen_ticket')

  const id = idOrNull(formData, 'id')
  if (id === null) throw new Error('Missing ticket id.')

  const existing = await loadTicket(company.id, id)
  if (!existing) toast('/dashboard/tickets', 'That ticket no longer exists.', 'error')

  const { error } = await tenantClient()
    .from('support_tickets')
    .update({ status: 'open', resolved_at: null })
    .eq('company_id', company.id)
    .eq('id', id)

  if (error) toast('/dashboard/tickets/' + id, 'Could not reopen: ' + error.message, 'error')

  await logTicketEvent({
    companyId: company.id,
    userId: profile.id,
    customerId: existing.customer_id,
    type: 'ticket_assigned',
    details: 'Ticket ' + JSON.stringify(existing.title) + ' reopened by ' + actor(profile),
  })

  revalidateTicket(id)
  if (existing.customer_id) revalidatePath('/dashboard/customers/' + existing.customer_id)

  toast('/dashboard/tickets/' + id, 'Ticket reopened.')
}
