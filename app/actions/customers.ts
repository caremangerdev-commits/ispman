'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { can, type Permission } from '@/lib/permissions'
import { getSchemaCapabilities } from '@/lib/schema'
import {
  ACTION_EVENT_TYPE, applyRadiusWrite, networkEventDetails, networkFailureDetails,
  provisionExpiry, reconnectExpiry, type RadiusAction,
} from '@/lib/radius/operations'
import { getSession } from '@/lib/session'
import { tenantClient } from '@/lib/supabase/tenant'
import { toBillingType } from '@/lib/billing'
import {
  toConnectionType, toCustomerCategory, toCustomerType, toExpiryMode,
} from '@/lib/types'

/**
 * Every mutation re-checks its own permission.
 *
 * Hiding a button only removes the obvious path — a server action is a public
 * POST endpoint, so authorization has to live here too, not just in the UI.
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

/**
 * React resets an uncontrolled form once a function action resolves, so a
 * rejected submission would otherwise wipe everything the user typed. Failed
 * results carry the submitted values back so the form can re-seed its
 * defaultValues and the user only has to fix the offending field.
 */
export type SubmittedValues = Record<string, string>

/** Per-field messages so the form can mark the offending inputs. */
export type FieldErrors = Record<string, string>

export type ActionResult =
  | { ok: true }
  | { ok: false; error: string; values?: SubmittedValues; fieldErrors?: FieldErrors }

const KEEP_FIELDS = [
  'first_name', 'last_name', 'phone', 'email', 'address', 'gps',
  'mac_address', 'monthly_rate', 'cut_off_date', 'bill_due_date',
  'customer_type', 'pppoe_username', 'pppoe_password', 'access_point',
  'billing_type', 'bill_date',
]

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

const numOrNull = (fd: FormData, key: string) => {
  const v = str(fd, key)
  if (!v) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Basic MAC shape check — the RADIUS username depends on this being sane. */
const MAC_RE = /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/

function todayYmd() {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createCustomer(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const { company, profile } = await authorize('add_customer')
  const caps = await getSchemaCapabilities()

  const values = submitted(formData)
  const fieldErrors: FieldErrors = {}
  const fail = (error: string): ActionResult => ({ ok: false, error, values, fieldErrors })

  const first_name = str(formData, 'first_name')
  const last_name = str(formData, 'last_name')
  const phone = str(formData, 'phone')
  const email = str(formData, 'email')
  const mac_address = str(formData, 'mac_address').toUpperCase()
  const monthly_rate = numOrNull(formData, 'monthly_rate')
  const cut_off_date = numOrNull(formData, 'cut_off_date')
  const bill_due_date = numOrNull(formData, 'bill_due_date')
  const billing_type = toBillingType(str(formData, 'billing_type'))
  const bill_date = numOrNull(formData, 'bill_date')
  const customerType = toCustomerType(str(formData, 'customer_type') || 'dhcp')
  const pppoe_username = str(formData, 'pppoe_username')
  const pppoe_password = str(formData, 'pppoe_password')

  // PPPoE authenticates by username, the other two by MAC. But mac_address is
  // NOT NULL until migration 0003 drops that constraint, so before it runs a
  // MAC is still mandatory for every type — otherwise the insert would fail
  // with a raw database error instead of a field message.
  const macRequired = customerType !== 'pppoe' || !caps.connectionTypes

  if (!first_name) fieldErrors.first_name = 'First name is required.'
  if (!last_name) fieldErrors.last_name = 'Last name is required.'
  if (!phone) fieldErrors.phone = 'Phone number is required.'
  if (!str(formData, 'address')) fieldErrors.address = 'Address is required.'
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fieldErrors.email = 'Enter a valid email address.'
  }

  if (macRequired && !mac_address) {
    fieldErrors.mac_address = 'MAC address is required for ' + customerType.toUpperCase() + '.'
  } else if (mac_address && !MAC_RE.test(mac_address)) {
    fieldErrors.mac_address = 'MAC address must be in format XX:XX:XX:XX:XX:XX.'
  }

  if (customerType !== 'dhcp' && !pppoe_username) {
    fieldErrors.pppoe_username = 'Username is required for ' + customerType.toUpperCase() + '.'
  }

  if (monthly_rate === null || monthly_rate < 0) {
    fieldErrors.monthly_rate = 'Enter a monthly rate of 0 or more.'
  }
  for (const [key, val] of [['cut_off_date', cut_off_date], ['bill_due_date', bill_due_date]] as const) {
    if (val !== null && (val < 1 || val > 28)) {
      fieldErrors[key] = 'Must be a day between 1 and 28.'
    }
  }

  // Wider than the 1-28 the other two allow, because a bill date is a real day
  // of the month rather than a safe-for-every-month day. postpaidExpiry clamps
  // 29-31 down to the length of the month it lands in.
  if (caps.billing && billing_type === 'postpaid') {
    if (bill_date === null) {
      fieldErrors.bill_date = 'A postpaid customer needs a bill date.'
    } else if (bill_date < 1 || bill_date > 31) {
      fieldErrors.bill_date = 'Must be a day between 1 and 31.'
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return fail('Please correct the highlighted fields.')
  }

  const db = tenantClient()

  // A MAC is the RADIUS username for DHCP/hotspot, so it must be unique.
  if (mac_address) {
    const { data: clash } = await db
      .from('customers')
      .select('id')
      .eq('company_id', company.id)
      .eq('mac_address', mac_address)
      .maybeSingle()

    if (clash) {
      fieldErrors.mac_address = 'Another customer already uses this MAC address.'
      return fail('That MAC address is already taken.')
    }
  }

  const last_bill_date = todayYmd()

  const row: Record<string, unknown> = {
    company_id: company.id,
    first_name,
    last_name,
    email: email || null,
    phone,
    address: str(formData, 'address') || null,
    gps: str(formData, 'gps') || null,
    mac_address: mac_address || null,
    monthly_rate,
    balance: 0,
    cut_off_date,
    bill_due_date,
    last_bill_date,
    date_added: todayYmd(),
  }

  // Only send the 0003 columns when they exist, otherwise PostgREST rejects
  // the whole insert. See lib/schema.ts.
  if (caps.connectionTypes) {
    row.customer_type = customerType
    row.pppoe_username = pppoe_username || null
    row.pppoe_password = pppoe_password || null
    row.access_point = str(formData, 'access_point') || null
  }
  // A prepaid customer gets no bill date: there is no bill run to generate.
  if (caps.billing) {
    row.billing_type = billing_type
    row.bill_date = billing_type === 'postpaid' ? bill_date : null
    row.carried_balance = 0
    row.account_credit = 0
  }
  if (caps.catalog) {
    row.connection_type = toConnectionType(str(formData, 'connection_type'))
    row.customer_category = toCustomerCategory(str(formData, 'customer_category'))
    row.notes = str(formData, 'notes') || null
    row.misc_category_id = numOrNull(formData, 'misc_category_id')
    row.service_plan_id = numOrNull(formData, 'service_plan_id')
  }

  // New customers inherit the company-wide default; it can be overridden per
  // customer afterwards on the detail page.
  if (caps.expiryMode) {
    const { data: settings } = await db
      .from('settings')
      .select('default_expiry_mode')
      .eq('company_id', company.id)
      .maybeSingle()

    row.expiry_mode = toExpiryMode(
      (settings as { default_expiry_mode?: string | null } | null)?.default_expiry_mode
    )
  }

  const { data, error } = await db.from('customers').insert(row).select('id').maybeSingle()

  if (error) return fail('Could not create customer: ' + error.message)

  const newId = (data as { id: number } | null)?.id ?? null
  const fullName = first_name + ' ' + last_name

  // Attach any add-ons ticked on the form. A failure here is reported but the
  // customer is already created, so it must not roll the whole thing back.
  if (caps.catalog && newId) {
    const addonError = await syncAddons(company.id, newId, formData)
    if (addonError) return addonError
  }

  await db.from('log').insert({
    company_id: company.id,
    user_id: profile.id,
    customer_id: newId,
    type: 'customer_added',
    details:
      fullName + ' was added as a ' + customerType.toUpperCase() + ' customer by ' +
      (profile.first_name ?? 'an operator'),
  })

  // Deliberately does NOT write to RADIUS. A new customer starts pending and is
  // provisioned by activateCustomer, so adding a record can never put rows into
  // the live radcheck table by itself.

  revalidatePath('/dashboard/customers')
  revalidatePath('/dashboard')

  const toast = '?toast=' + encodeURIComponent('Customer added successfully')
  redirect(newId ? '/dashboard/customers/' + newId + toast : '/dashboard/customers' + toast)
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updateCustomer(
  _prev: ActionResult | null,
  formData: FormData
): Promise<ActionResult> {
  const session = await authorize('edit_customer')
  const { company, profile } = session
  const caps = await getSchemaCapabilities()

  const id = numOrNull(formData, 'id')
  if (id === null) return { ok: false, error: 'Missing customer id.' }

  const mac_address = str(formData, 'mac_address').toUpperCase()
  if (mac_address && !MAC_RE.test(mac_address)) {
    return { ok: false, error: 'MAC address must look like AA:BB:CC:DD:EE:FF.' }
  }

  const patch: Record<string, unknown> = {
    first_name: str(formData, 'first_name'),
    last_name: str(formData, 'last_name'),
    email: str(formData, 'email') || null,
    phone: str(formData, 'phone'),
    address: str(formData, 'address') || null,
    gps: str(formData, 'gps') || null,
    mac_address: mac_address || null,
    monthly_rate: numOrNull(formData, 'monthly_rate'),
    cut_off_date: numOrNull(formData, 'cut_off_date'),
    bill_due_date: numOrNull(formData, 'bill_due_date'),
  }

  if (caps.connectionTypes) {
    const customerType = toCustomerType(str(formData, 'customer_type') || 'dhcp')
    // Same rule as create: MAC is only optional for PPPoE once 0003 has
    // dropped the NOT NULL constraint.
    if (customerType !== 'pppoe' && !mac_address) {
      return { ok: false, error: 'MAC address is required for ' + customerType.toUpperCase() + '.' }
    }
    patch.customer_type = customerType
    patch.pppoe_username = str(formData, 'pppoe_username') || null
    // Blank means "leave unchanged" so an edit does not silently wipe the
    // stored password just because the field rendered empty.
    const pw = str(formData, 'pppoe_password')
    if (pw) patch.pppoe_password = pw
    patch.access_point = str(formData, 'access_point') || null
  }

  if (caps.catalog) {
    patch.connection_type = toConnectionType(str(formData, 'connection_type'))
    patch.customer_category = toCustomerCategory(str(formData, 'customer_category'))
    patch.notes = str(formData, 'notes') || null
    patch.misc_category_id = numOrNull(formData, 'misc_category_id')
    patch.service_plan_id = numOrNull(formData, 'service_plan_id')
  }

  // Expiry mode changes who gets free days on a late renewal, so it needs the
  // service-lifecycle right rather than plain edit access.
  if (caps.expiryMode && can(profile.role, 'extend_disconnect_customer')) {
    const mode = str(formData, 'expiry_mode')
    if (mode) patch.expiry_mode = toExpiryMode(mode)
  }

  const db = tenantClient()
  const { error } = await db
    .from('customers')
    .update(patch)
    .eq('company_id', company.id)
    .eq('id', id)

  if (error) return { ok: false, error: 'Could not save changes: ' + error.message }

  if (caps.catalog) {
    const result = await syncAddons(company.id, id, formData)
    if (result) return result
  }

  revalidatePath('/dashboard/customers/' + id)
  revalidatePath('/dashboard/customers')
  return { ok: true }
}

/**
 * Reconciles the customer_additional_services rows against the submitted
 * checkboxes: delete what was unticked, insert what is new.
 *
 * Returns an ActionResult only on failure so the caller can surface it.
 */
async function syncAddons(
  companyId: number,
  customerId: number,
  formData: FormData
): Promise<ActionResult | null> {
  const wanted = new Set(
    formData
      .getAll('addon_ids')
      .map((v) => Number(v))
      .filter((n) => Number.isInteger(n))
  )

  const db = tenantClient()
  const { data, error: readError } = await db
    .from('customer_additional_services')
    .select('id, additional_service_id')
    .eq('company_id', companyId)
    .eq('customer_id', customerId)

  if (readError) {
    return { ok: false, error: 'Saved, but add-ons could not be read: ' + readError.message }
  }

  const existing = (data ?? []) as unknown as { id: number; additional_service_id: number }[]
  const have = new Set(existing.map((r) => r.additional_service_id))

  const toRemove = existing.filter((r) => !wanted.has(r.additional_service_id)).map((r) => r.id)
  const toAdd = [...wanted].filter((id) => !have.has(id))

  if (toRemove.length) {
    const { error } = await db.from('customer_additional_services').delete().in('id', toRemove)
    if (error) return { ok: false, error: 'Saved, but removing add-ons failed: ' + error.message }
  }

  if (toAdd.length) {
    const { error } = await db.from('customer_additional_services').insert(
      toAdd.map((additional_service_id) => ({
        customer_id: customerId,
        company_id: companyId,
        additional_service_id,
      }))
    )
    if (error) {
      // 23503 here means the company_id foreign key still points at customers
      // rather than companies — see supabase/migrations/0006_fix_addon_fk.sql.
      const hint =
        error.code === '23503'
          ? ' Run supabase/migrations/0006_fix_addon_fk.sql — the junction table has a bad foreign key.'
          : ''
      return { ok: false, error: 'Saved, but adding add-ons failed: ' + error.message + hint }
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Network actions
//
// Four operations, one per button on the customer record, and the only things
// in this app that move a customer's radcheck Expiration outside of a payment:
//
//   provision   unprovisioned                      → both radcheck rows, 21-day rule
//   reconnect   expired | inactive | disconnected  → next cut-off day
//   extend      active | expired                   → an operator-chosen date
//   disconnect  active                             → now
//
// All four are CSR-or-above, and all four follow the same order: write to
// radcheck, then record the event. See runNetworkAction.
// ---------------------------------------------------------------------------

type NetworkTarget = {
  fullName: string
  /** PPPoE authenticates by username, DHCP and hotspot by MAC. */
  identity: string | null
  cutOffDate: number | null
}

/** The customer fields every network action needs, read once. */
async function loadNetworkTarget(
  companyId: number,
  id: number
): Promise<NetworkTarget> {
  const caps = await getSchemaCapabilities()
  const db = tenantClient()

  const cols = 'first_name, last_name, mac_address, cut_off_date' +
    (caps.connectionTypes ? ', customer_type, pppoe_username' : '')

  const { data } = await db
    .from('customers')
    .select(cols)
    .eq('company_id', companyId)
    .eq('id', id)
    .maybeSingle()

  const row = data as unknown as {
    first_name: string | null
    last_name: string | null
    mac_address: string | null
    cut_off_date: number | null
    customer_type?: string | null
    pppoe_username?: string | null
  } | null

  return {
    fullName:
      [row?.first_name, row?.last_name].filter(Boolean).join(' ') || 'Customer #' + id,
    identity: (row?.customer_type === 'pppoe' ? row?.pppoe_username : row?.mac_address) ?? null,
    cutOffDate: row?.cut_off_date ?? null,
  }
}

/**
 * Records a network event, AFTER the radcheck write has succeeded.
 *
 * THE ORDER IS THE POINT AND MUST NOT BE SWAPPED. Service state matters more
 * than history: if this insert fails, the customer is still on (or off) the
 * network exactly as the operator asked, and undoing that to keep the log tidy
 * would take away the thing they actually wanted. So a failure goes to the
 * console and no error reaches the operator.
 *
 * Uses the same `log` insert every other action in this file uses — there is no
 * separate events table and no migration behind any of this.
 */
async function logNetworkEvent(opts: {
  companyId: number
  userId: number
  customerId: number
  type: string
  details: string
}) {
  try {
    const { error } = await tenantClient().from('log').insert({
      company_id: opts.companyId,
      user_id: opts.userId,
      customer_id: opts.customerId,
      type: opts.type,
      details: opts.details,
    })
    if (error) {
      console.error(
        '[network] could not write a %s log row for customer %d: %s',
        opts.type, opts.customerId, error.message
      )
    }
  } catch (err) {
    console.error(
      '[network] could not write a %s log row for customer %d: %s',
      opts.type, opts.customerId, (err as Error).message
    )
  }
}

/**
 * Where to send the operator afterwards.
 *
 * The customer list posts these actions too, and bouncing it to a detail page
 * every time would lose the operator's place. `return_to` carries the page that
 * submitted; it must be an in-app dashboard path, because a form field is user
 * input and an unchecked one is an open redirect.
 */
function returnTo(formData: FormData, customerId: number): string {
  const raw = str(formData, 'return_to')
  const safe = /^\/dashboard(\/|$)/.test(raw) && !raw.startsWith('//')
  return safe ? raw : '/dashboard/customers/' + customerId
}

function toast(path: string, message: string, kind?: 'error'): never {
  // return_to carries the customer list's own search and filter, so the path
  // may already have a query string.
  redirect(
    path + (path.includes('?') ? '&' : '?') +
    (kind === 'error' ? 'toastKind=error&' : '') +
    'toast=' + encodeURIComponent(message)
  )
}

/**
 * The shared body of all four network actions.
 *
 * Everything that must not vary between them lives here: the permission check,
 * reading the identity, the radcheck-then-log ordering, and the fact that a
 * failed radcheck write is logged under `radius_*_failed` rather than a
 * `network_*` type — a disconnect that never reached the NAS must not make the
 * customer read as disconnected.
 *
 * `expiryFor` returns the date to write, or a string to abort with. Disconnect
 * ignores it and always writes the current moment (lib/radius-db.ts).
 */
async function runNetworkAction(opts: {
  action: RadiusAction
  formData: FormData
  expiryFor: (target: NetworkTarget) => Date | string | null
  success: (target: NetworkTarget, newExpiry: string) => string
}) {
  const { action, formData } = opts
  const { company, profile } = await authorize(
    action === 'provision' ? 'provision_customer' : 'extend_disconnect_customer'
  )

  const id = numOrNull(formData, 'id')
  if (id === null) return

  const back = returnTo(formData, id)
  const target = await loadNetworkTarget(company.id, id)

  if (!target.identity) {
    toast(
      back,
      'Cannot ' + action + ' ' + target.fullName +
      ': no MAC address or username on record.',
      'error'
    )
  }

  const expiry = opts.expiryFor(target)
  if (typeof expiry === 'string') toast(back, expiry, 'error')

  // --- 1. radcheck ---------------------------------------------------------
  const result = await applyRadiusWrite(action, target.identity, expiry ?? undefined)

  if (!result.ok) {
    await logNetworkEvent({
      companyId: company.id,
      userId: profile.id,
      customerId: id,
      type: 'radius_' + action + '_failed',
      details: networkFailureDetails({
        action,
        identity: target.identity,
        oldExpiry: result.oldExpiry,
        actor: profile.email,
        error: result.error,
      }),
    })

    toast(back, result.error + ' Nothing was changed for ' + target.fullName + '.', 'error')
  }

  // --- 2. the event row ----------------------------------------------------
  await logNetworkEvent({
    companyId: company.id,
    userId: profile.id,
    customerId: id,
    type: ACTION_EVENT_TYPE[action],
    details: networkEventDetails({
      action,
      identity: target.identity,
      oldExpiry: result.oldExpiry,
      newExpiry: result.newExpiry,
      actor: profile.email,
      skipped: result.skipped,
    }),
  })

  // Billing dates are deliberately untouched. Status and expiry live in the
  // registry now, and last_bill_date is record-keeping that must never feed an
  // expiry calculation (lib/radius/operations.ts#paymentExpiry).

  revalidatePath('/dashboard/customers')
  revalidatePath('/dashboard/customers/' + id)
  revalidatePath('/dashboard')

  toast(
    back,
    result.skipped
      ? target.fullName + ': network is not configured, so nothing was written.'
      : opts.success(target, result.newExpiry)
  )
}

/**
 * Creates a customer's radcheck rows for the first time.
 *
 * Writes both rows — `Auth-Type := Accept` and `Expiration` — in one
 * transaction. The first expiry follows the 21-day rule: the next cut-off day
 * only counts if it is at least three weeks out, so nobody is switched on four
 * days before their cut-off and billed for a month of it.
 */
export async function provisionCustomer(formData: FormData) {
  return runNetworkAction({
    action: 'provision',
    formData,
    expiryFor: (t) => provisionExpiry(t.cutOffDate),
    success: (t, expiry) => t.fullName + ' provisioned, expires ' + expiry,
  })
}

/**
 * Puts a lapsed or disconnected customer back on the network.
 *
 * Moves their Expiration to the next occurrence of their cut-off day. No 21-day
 * allowance: they are returning to a cycle they are already on, and a month and
 * a bit would knock them off their cut-off day permanently.
 */
export async function reconnectCustomer(formData: FormData) {
  return runNetworkAction({
    action: 'reconnect',
    formData,
    expiryFor: (t) => reconnectExpiry(t.cutOffDate),
    success: (t, expiry) => t.fullName + ' reconnected, expires ' + expiry,
  })
}

/**
 * Extends access to a date the operator picked.
 *
 * The date is required — there is no "one month on" fallback any more, because
 * a dateless extend had no defined meaning once expiry moved into the registry.
 * A past date is refused here as well as in the modal: picking one would
 * disconnect the customer rather than extend them, and extendInRadius would
 * reject it anyway.
 */
export async function extendCustomer(formData: FormData) {
  return runNetworkAction({
    action: 'extend',
    formData,
    expiryFor: () => {
      const chosen = str(formData, 'new_expiry')
      if (!chosen) return 'No date was chosen, so access was not extended.'

      const picked = new Date(chosen + 'T00:00:00')
      if (!Number.isFinite(picked.getTime())) return 'That is not a valid date.'

      const todayStart = new Date()
      todayStart.setHours(0, 0, 0, 0)
      if (picked.getTime() < todayStart.getTime()) {
        return 'The new expiry date cannot be in the past.'
      }
      return picked
    },
    success: (t, expiry) => t.fullName + ': access extended to ' + expiry,
  })
}

/**
 * Takes a customer off the network by setting their Expiration to now.
 *
 * Goes through disconnectInRadius, NOT extendInRadius — this is the one
 * operation that legitimately writes an expiry earlier than the one on record,
 * and the backwards-write guard protecting every renewal stays intact rather
 * than growing a bypass flag.
 *
 * The radcheck rows are kept, so reconnecting is a single update.
 */
export async function disconnectCustomer(formData: FormData) {
  return runNetworkAction({
    action: 'disconnect',
    formData,
    expiryFor: () => null,
    success: (t) => t.fullName + ' disconnected from the network.',
  })
}

export async function deleteCustomer(formData: FormData) {
  const { company } = await authorize('manage_company_settings')
  const id = numOrNull(formData, 'id')
  if (id === null) return

  const db = tenantClient()
  // payments/tickets/log reference the customer, so clear dependents first.
  await db.from('log').delete().eq('company_id', company.id).eq('customer_id', id)
  await db.from('notifications_queue').delete().eq('company_id', company.id).eq('customer_id', id)
  await db.from('support_tickets').delete().eq('company_id', company.id).eq('customer_id', id)
  await db.from('payments').delete().eq('company_id', company.id).eq('customer_id', id)
  await db.from('customers').delete().eq('company_id', company.id).eq('id', id)

  revalidatePath('/dashboard/customers')
  revalidatePath('/dashboard')
  redirect('/dashboard/customers')
}
