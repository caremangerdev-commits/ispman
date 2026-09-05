/**
 * Customer status, derived from the network registry plus the event log.
 *
 * There is no `customers.status` column any more: whether someone can get
 * online is a fact about radcheck, and duplicating it in Postgres is what
 * produced the drift where 14 customers read "active" while one could
 * authenticate. This module is the single vocabulary for that derived state.
 *
 * Four of the six states come from radcheck alone. 'disconnected' is the
 * exception: radcheck cannot tell a lapsed customer from one an operator cut
 * off, because both are expressed as an expiry in the past. The difference is
 * held in the `log` table — see resolveStatus below.
 *
 * Client-safe on purpose — badges and filter tabs are client components, and
 * importing from lib/radius-db.ts would drag mysql2 into the browser bundle.
 */

export type CustomerStatus =
  | 'unprovisioned'
  | 'active'
  | 'expired'
  | 'inactive'
  | 'disconnected'
  /**
   * ADDITION BEYOND THE SPECIFIED STATES, and it is load-bearing.
   *
   * With status derived solely from radcheck, a NAS we cannot reach would
   * otherwise make every customer read 'unprovisioned' — hiding their controls
   * and reporting a company-wide outage that is not happening. 'unknown' means
   * "we could not ask", which is a different fact from "there is no record",
   * and the UI says so rather than guessing.
   */
  | 'unknown'

export const CUSTOMER_STATUSES: CustomerStatus[] = [
  'active', 'expired', 'inactive', 'disconnected', 'unprovisioned',
]

export const STATUS_LABELS: Record<CustomerStatus, string> = {
  unprovisioned: 'Not Activated',
  active: 'Active',
  expired: 'Expired',
  inactive: 'Inactive',
  disconnected: 'Disconnected',
  unknown: 'Unknown',
}

/** Badge classes. Colours are fixed by the status spec. */
export const STATUS_BADGE: Record<CustomerStatus, string> = {
  unprovisioned: 'bg-gray-600/30 text-gray-400',
  active: 'bg-green-500/15 text-green-400',
  expired: 'bg-red-500/15 text-red-400',
  inactive: 'bg-orange-500/15 text-orange-400',
  disconnected: 'bg-slate-500/20 text-slate-300',
  unknown: 'bg-gray-700/40 text-gray-500',
}

/** Solid colours for the dashboard donut. */
export const STATUS_COLOR: Record<CustomerStatus, string> = {
  unprovisioned: '#6b7280',
  active: '#22c55e',
  expired: '#ef4444',
  inactive: '#f97316',
  disconnected: '#64748b',
  unknown: '#4b5563',
}

/** Small status dot, used by the search dropdowns. */
export const STATUS_DOT: Record<CustomerStatus, string> = {
  unprovisioned: 'bg-gray-500',
  active: 'bg-green-500',
  expired: 'bg-red-500',
  inactive: 'bg-orange-500',
  disconnected: 'bg-slate-500',
  unknown: 'bg-gray-600',
}

/**
 * The network events this app writes to the `log` table.
 *
 * The vocabulary is closed: every row written by the four network buttons uses
 * one of these types, and resolveStatus keys off them. Failed writes are logged
 * under `radius_*_failed` instead, deliberately outside this prefix — a
 * disconnect that never reached the NAS must not make the customer read as
 * disconnected.
 */
export const NETWORK_EVENT_TYPES = [
  'network_provision',
  'network_reconnect',
  'network_extend',
  'network_disconnect',
  'network_expiry_corrected',
] as const

export type NetworkEventType = (typeof NETWORK_EVENT_TYPES)[number]

export const NETWORK_EVENT_LABELS: Record<NetworkEventType, string> = {
  network_provision: 'Provisioned',
  network_reconnect: 'Reconnected',
  network_extend: 'Extended',
  network_disconnect: 'Disconnected',
  network_expiry_corrected: 'Expiry corrected',
}

/**
 * Separates a deliberate disconnection from an ordinary lapse.
 *
 * radcheck holds one fact — an expiry in the past — for two very different
 * situations: a customer who simply stopped paying, and one an operator took
 * off the network on purpose. `lastNetworkEvent` is the type of the most recent
 * `network_*` log row for the customer, and being a disconnect is what tells
 * the two apart.
 *
 * Checked BEFORE expired/inactive, per the status spec: a disconnected customer
 * is disconnected however long ago it happened, and never ages into 'inactive'.
 * A live expiry always wins — a reconnect or an extension moves the customer
 * back to 'active' without needing the log row to be superseded.
 */
export function resolveStatus(
  base: CustomerStatus,
  lastNetworkEvent: string | null | undefined
): CustomerStatus {
  if (base !== 'expired' && base !== 'inactive') return base
  return lastNetworkEvent === 'network_disconnect' ? 'disconnected' : base
}

/**
 * Statuses whose access can be extended — they have a registry entry to move.
 *
 * Broader than the Extend button (see canExtendAccess): a payment taken for a
 * disconnected or long-inactive customer still pushes their expiry forward,
 * because the radcheck rows are there to move.
 */
export function canExtend(status: CustomerStatus): boolean {
  return (
    status === 'active' ||
    status === 'expired' ||
    status === 'inactive' ||
    status === 'disconnected'
  )
}

// ---------------------------------------------------------------------------
// Which of the four network actions applies to a given status.
//
// Shared by the UI and the server actions so a button and the action behind it
// can never disagree about when it is offered. Permission is a separate check
// and always re-run on the server.
// ---------------------------------------------------------------------------

/** First-time provisioning: the registry has never heard of this customer. */
export function canProvision(status: CustomerStatus): boolean {
  return status === 'unprovisioned'
}

/** Putting a lapsed or cut-off customer back on, at their next cut-off day. */
export function canReconnect(status: CustomerStatus): boolean {
  return status === 'expired' || status === 'inactive' || status === 'disconnected'
}

/**
 * Moving an expiry out to an operator-chosen date.
 *
 * Not offered for 'inactive' or 'disconnected': those need Reconnect, which
 * puts them back on the cut-off cycle rather than an arbitrary date.
 */
export function canExtendAccess(status: CustomerStatus): boolean {
  return status === 'active' || status === 'expired'
}

/** Taking someone off the network. Only meaningful while they are on it. */
export function canDisconnect(status: CustomerStatus): boolean {
  return status === 'active'
}

export function toCustomerStatus(value: string | null | undefined): CustomerStatus {
  return (CUSTOMER_STATUSES as string[]).includes(value ?? '')
    ? (value as CustomerStatus)
    : 'unknown'
}
