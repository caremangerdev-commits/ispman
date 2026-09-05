'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import {
  Activity, Cable, Eye, EyeOff, MapPin, Package, Pencil, Radio, Trash2,
  Wallet, Wifi, X,
} from 'lucide-react'

import {
  deleteCustomer, disconnectCustomer, provisionCustomer, reconnectCustomer,
  updateCustomer, type ActionResult,
} from '@/app/actions/customers'
import Link from 'next/link'

import { ExtendAccessModal } from '@/components/customers/ExtendAccessModal'
import { StatusBadge } from '@/components/customers/StatusBadge'
import { GpsField } from '@/components/ui/GpsField'
import { GpsLink } from '@/components/ui/GpsLink'
import { MacAddressInput } from '@/components/ui/MacAddressInput'
import { daysUntilDateOnly, formatCurrency, formatDateOnly } from '@/lib/format'
import { can, type Role } from '@/lib/permissions'
// From format.ts, not client.ts: this is a client component and client.ts
// pulls in mysql2.
import { formatBytes, type RadiusStatus } from '@/lib/radius/format'
import { type BillingType } from '@/lib/billing'
import {
  CONNECTION_TYPES, CONNECTION_TYPE_LABELS, CUSTOMER_CATEGORIES,
  CUSTOMER_CATEGORY_LABELS, CUSTOMER_TYPES, CUSTOMER_TYPE_LABELS, describePlan,
  EXPIRY_MODES, EXPIRY_MODE_HELP, EXPIRY_MODE_LABELS,
  type AdditionalService, type ConnectionType, type CustomerCategory,
  type CustomerType, type ExpiryMode, type MiscCategory, type ServicePlan,
} from '@/lib/types'
import {
  canDisconnect, canExtendAccess, canProvision, canReconnect,
} from '@/lib/status'

export type DetailCustomer = {
  id: number
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  address: string | null
  gps: string | null
  mac_address: string | null
  monthly_rate: number | string | null
  balance: number | string | null
  cut_off_date: number | null
  last_bill_date: string | null
  /** migration 0011 */
  billingAvailable: boolean
  billingType: BillingType
  bill_date: number | null
  carried_balance: number
  last_billed_date: string | null
  date_added: string | null
  expiresAtIso: string | null
  daysUntilExpiry: number | null
  /** migration 0003 */
  customerType: CustomerType | null
  pppoeUsername: string | null
  accessPoint: string | null
  /** migration 0004 */
  expiryMode: ExpiryMode
  expiryModeEditable: boolean
  /** migration 0005 */
  catalogAvailable: boolean
  connectionType: ConnectionType | null
  customerCategory: CustomerCategory | null
  notes: string | null
  miscCategoryId: number | null
  miscCategoryName: string | null
  servicePlanId: number | null
  servicePlan: {
    id: number
    name: string
    speed_down_mbps: number
    speed_up_mbps: number
    monthly_price: number | string
  } | null
}

const inputCls =
  'w-full rounded-md border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-white outline-none transition focus:border-blue-500 focus:ring-1 focus:ring-blue-500/40'

// Every date on this card is a calendar date — a DATE column, or the expiry
// radcheck holds — so they all go through lib/format.ts#formatDateOnly. There
// is deliberately no local instant formatter left here to reach for: the one
// that was here rendered a bare YYYY-MM-DD as UTC midnight and printed the day
// before for every viewer west of UTC.

const TYPE_STYLES: Record<CustomerType, string> = {
  dhcp: 'bg-blue-500/15 text-blue-400',
  pppoe: 'bg-violet-500/15 text-violet-400',
  hotspot: 'bg-orange-500/15 text-orange-400',
}

function TypeBadge({ type }: { type: CustomerType }) {
  return (
    <span
      className={
        'rounded px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ' + TYPE_STYLES[type]
      }
    >
      {CUSTOMER_TYPE_LABELS[type]}
    </span>
  )
}

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
      <dl className="divide-y divide-gray-800/70">{children}</dl>
    </section>
  )
}

/** Label/value row; renders a plain input instead of text while editing. */
function Row({
  label, value, editing, name, defaultValue, type = 'text', mono,
}: {
  label: string
  value: React.ReactNode
  editing?: boolean
  name?: string
  defaultValue?: string | number
  type?: string
  mono?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2">
      <dt className="shrink-0 text-xs text-gray-500">{label}</dt>
      <dd className={'min-w-0 flex-1 text-right text-sm text-gray-200 ' + (mono ? 'font-mono text-xs' : '')}>
        {editing && name ? (
          <input
            name={name}
            type={type}
            defaultValue={defaultValue ?? ''}
            className={inputCls + ' text-right' + (mono ? ' font-mono' : '')}
          />
        ) : (
          value
        )}
      </dd>
    </div>
  )
}

/** Row whose edit control is supplied by the caller (select, toggle, …). */
function ControlRow({
  label, value, editing, control,
}: {
  label: string
  value: React.ReactNode
  editing: boolean
  control: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2">
      <dt className="shrink-0 text-xs text-gray-500">{label}</dt>
      <dd className="min-w-0 flex-1 text-right text-sm text-gray-200">
        {editing ? control : value}
      </dd>
    </div>
  )
}

function SaveButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-blue-500 disabled:opacity-60"
    >
      {pending ? 'Saving…' : 'Save Changes'}
    </button>
  )
}

export function CustomerDetail({
  customer,
  radius,
  role,
  servicePlans,
  additionalServices,
  miscCategories,
  selectedAddonIds,
}: {
  customer: DetailCustomer
  radius: RadiusStatus
  role: Role
  servicePlans: ServicePlan[]
  additionalServices: AdditionalService[]
  miscCategories: MiscCategory[]
  selectedAddonIds: number[]
}) {
  const c = customer

  // Mirrors the server-side checks in app/actions/customers.ts. Hiding a
  // control is presentation only; the action re-verifies before mutating.
  const mayEdit = can(role, 'edit_customer')

  // Every control below is driven by the network registry, which is the only
  // source of customer status now. 'unknown' means the registry could not be
  // reached: controls stay hidden rather than acting on a guess.
  const status = radius.status

  // Days remaining against the REGISTRY expiry. c.daysUntilExpiry is derived
  // from last_bill_date and is no longer shown anywhere.
  //
  // Counted from the calendar date, NOT from radius.expiresAt. That Date is an
  // instant built in the SERVER's zone out of radcheck's wall-clock text, so
  // reading its parts here — in the browser — shifted it by the gap between the
  // two zones. A UTC server and a Jamaica browser is exactly that gap, which is
  // why this and the list disagreed on every midnight expiry.
  const networkDaysLeft = daysUntilDateOnly(radius.expiryDate)

  // WHAT THE CUSTOMER OWES, FOR BOTH BILLING TYPES — and it is carried_balance,
  // not `balance`.
  //
  // `balance` has no writer that ever CHARGES it. The bill run adds the monthly
  // rate to carried_balance (app/actions/bulk.ts#billBatch) and explicitly does
  // not touch balance; the payment path only ever DECREMENTS balance by what
  // was paid. A column that is decremented and never incremented decays to 0
  // and stays there, so this field read 0 for every customer who actually owed
  // — 237 of them on one company, carrying 740,500 between them.
  //
  // Falls back to `balance` only before migration 0011, where carried_balance
  // does not exist and balance is the only figure there is.
  const owed = c.billingAvailable ? c.carried_balance : Number(c.balance ?? 0)

  // The four network actions. Each is CSR-or-above and applies to a distinct
  // set of statuses, so at most two are ever offered at once. The server action
  // re-checks the permission — hiding a button is presentation only.
  const mayNetwork = can(role, 'extend_disconnect_customer')
  const showProvision = can(role, 'provision_customer') && canProvision(status)
  const showReconnect = mayNetwork && canReconnect(status)
  const showExtend = mayNetwork && canExtendAccess(status)
  const showDisconnect = mayNetwork && canDisconnect(status)

  const mayDelete = can(role, 'manage_company_settings')
  const maySeeTech = can(role, 'view_customer_tech_info')

  const [editing, setEditing] = useState(false)
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false)
  const [formKey, setFormKey] = useState(0)

  const [authType, setAuthType] = useState<CustomerType>(c.customerType ?? 'dhcp')
  const [mac, setMac] = useState(c.mac_address ?? '')
  const [showPassword, setShowPassword] = useState(false)
  const [expiryMode, setExpiryMode] = useState<ExpiryMode>(c.expiryMode)
  const [planId, setPlanId] = useState(c.servicePlanId ? String(c.servicePlanId) : '')
  const [rate, setRate] = useState(String(Number(c.monthly_rate ?? 0)))
  const [addons, setAddons] = useState<number[]>(selectedAddonIds)

  const [state, formAction] = useActionState<ActionResult | null, FormData>(updateCustomer, null)

  // Leave edit mode once a save succeeds. Adjusted during render rather than in
  // an effect to avoid a cascading re-render.
  const [seenState, setSeenState] = useState(state)
  if (state !== seenState) {
    setSeenState(state)
    if (state?.ok) setEditing(false)
  }

  const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Unnamed customer'

  const cancel = () => {
    setAuthType(c.customerType ?? 'dhcp')
    setMac(c.mac_address ?? '')
    setExpiryMode(c.expiryMode)
    setPlanId(c.servicePlanId ? String(c.servicePlanId) : '')
    setRate(String(Number(c.monthly_rate ?? 0)))
    setAddons(selectedAddonIds)
    setFormKey((k) => k + 1)
    setEditing(false)
  }

  /** Picking a plan pre-fills the rate; it stays editable afterwards. */
  function choosePlan(value: string) {
    setPlanId(value)
    const plan = servicePlans.find((p) => String(p.id) === value)
    if (plan) setRate(String(Number(plan.monthly_price)))
  }

  // PPPoE authenticates by username, so its MAC is optional rather than hidden.
  const showPppoeFields = authType === 'pppoe' || authType === 'hotspot'

  const activeAddons = additionalServices.filter((a) => addons.includes(a.id))
  const addonTotal = activeAddons.reduce((sum, a) => sum + Number(a.monthly_price ?? 0), 0)

  return (
    <form key={formKey} action={formAction} className="space-y-4">
      <input type="hidden" name="id" value={c.id} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-xl font-semibold tracking-tight text-white">{name}</h1>
          <StatusBadge status={status} size="md" />
          {/* Exactly one connection-type badge, and only in view mode — while
              editing, the type is changed from the Authentication card. */}
          {!editing && c.customerType ? <TypeBadge type={c.customerType} /> : null}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {editing ? (
            <>
              <SaveButton />
              <button
                type="button"
                onClick={cancel}
                className="inline-flex items-center gap-1 rounded-lg bg-gray-800 px-3 py-1.5 text-xs font-semibold text-gray-300 transition hover:bg-gray-700"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
                Cancel
              </button>
            </>
          ) : (
            <>
              {/* Provision writes both radcheck rows for the first time,
                  expiring on the 21-day rule. Only for someone the registry
                  has never heard of. */}
              {showProvision ? (
                <button
                  type="submit"
                  formAction={provisionCustomer}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-amber-500"
                >
                  <Wifi className="h-3.5 w-3.5" aria-hidden />
                  Provision
                </button>
              ) : null}

              {/* Reconnect puts a lapsed or cut-off customer back on at their
                  next cut-off day, so they land back on their billing cycle. */}
              {showReconnect ? (
                <button
                  type="submit"
                  formAction={reconnectCustomer}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-green-500"
                >
                  <Wifi className="h-3.5 w-3.5" aria-hidden />
                  Reconnect
                </button>
              ) : null}

              {mayEdit ? (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="inline-flex items-center gap-1 rounded-lg bg-gray-800 px-3 py-1.5 text-xs font-semibold text-gray-300 transition hover:bg-gray-700"
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden />
                  Edit
                </button>
              ) : null}

              {/* Extend takes an explicit date, so it opens a picker rather
                  than submitting straight away. */}
              {showExtend ? (
                <ExtendAccessModal
                  customerId={c.id}
                  customerName={name}
                  radiusExpiry={radius.expiry}
                  radiusExpiryDate={radius.expiryDate}
                />
              ) : null}

              {/* Confirmed first: this is the one action that takes service
                  away, and the customer may not notice immediately. */}
              {showDisconnect ? (
                <button
                  type="button"
                  onClick={() => setConfirmingDisconnect(true)}
                  className="rounded-lg bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-400 transition hover:bg-red-500/20"
                >
                  Disconnect
                </button>
              ) : null}

              {mayDelete ? (
                <button
                  type="submit"
                  formAction={deleteCustomer}
                  onClick={(e) => {
                    if (
                      !confirm(
                        'Delete ' + name + '? This also removes their payments, tickets and log entries. This cannot be undone.'
                      )
                    ) {
                      e.preventDefault()
                    }
                  }}
                  className="inline-flex items-center gap-1 rounded-lg bg-gray-800 px-3 py-1.5 text-xs font-semibold text-gray-400 transition hover:bg-red-500/20 hover:text-red-400"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  Delete
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>

      {state && !state.ok ? (
        <p role="alert" className="rounded-lg border border-red-900/60 bg-red-950/50 px-3 py-2 text-sm text-red-300">
          {state.error}
        </p>
      ) : null}

      {confirmingDisconnect ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="disconnect-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
        >
          <div className="w-full max-w-md rounded-xl border border-gray-800 bg-gray-900 p-5 shadow-2xl">
            <h2 id="disconnect-title" className="text-base font-semibold text-white">
              End network access for {name}?
            </h2>
            {/* The NAS checks Expiration when a session authenticates, not
                continuously, so an open session can outlive the write. Said
                plainly here rather than discovered later as a bug report. */}
            <p className="mt-2 text-sm leading-relaxed text-gray-400">
              They may remain online until their session renews.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmingDisconnect(false)}
                className="rounded-lg bg-gray-800 px-3.5 py-2 text-sm font-medium text-gray-300 transition hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                formAction={disconnectCustomer}
                className="rounded-lg bg-red-600 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-red-500"
              >
                Disconnect
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className={'grid gap-4 ' + (maySeeTech ? 'lg:grid-cols-3' : 'lg:grid-cols-2')}>
        {/* ---------------- Customer Information ---------------- */}
        <Card title="Customer Information" icon={MapPin}>
          <Row label="First Name" value={c.first_name ?? '—'} editing={editing} name="first_name" defaultValue={c.first_name ?? ''} />
          <Row label="Last Name" value={c.last_name ?? '—'} editing={editing} name="last_name" defaultValue={c.last_name ?? ''} />
          <Row label="Phone" value={c.phone ?? '—'} editing={editing} name="phone" defaultValue={c.phone ?? ''} />
          <Row label="Email" value={c.email ?? '—'} editing={editing} name="email" type="email" defaultValue={c.email ?? ''} />
          <Row label="Address" value={c.address ?? '—'} editing={editing} name="address" defaultValue={c.address ?? ''} />
          {/* Not a plain Row: the edit control carries the capture button, and
              the read-only value is a link onto a map rather than bare text. */}
          <ControlRow
            label="GPS"
            editing={editing}
            value={<GpsLink value={c.gps} />}
            control={<GpsField id="customer-gps" name="gps" existing={c.gps} />}
          />
          {/* date_added is a DATE column, so it is a calendar date. It was
              going through dateFmt and rendering a day early west of UTC. */}
          <Row label="Date Added" value={formatDateOnly(c.date_added)} />

          {c.catalogAvailable ? (
            <>
              <ControlRow
                label="Connection Type"
                editing={editing}
                value={
                  <span className="inline-flex items-center gap-1.5">
                    {c.connectionType === 'wired' ? (
                      <Cable className="h-3.5 w-3.5 text-gray-500" aria-hidden />
                    ) : (
                      <Wifi className="h-3.5 w-3.5 text-gray-500" aria-hidden />
                    )}
                    {c.connectionType ? CONNECTION_TYPE_LABELS[c.connectionType] : '—'}
                  </span>
                }
                control={
                  <select name="connection_type" defaultValue={c.connectionType ?? 'wireless'} className={inputCls}>
                    {CONNECTION_TYPES.map((t) => (
                      <option key={t} value={t}>{CONNECTION_TYPE_LABELS[t]}</option>
                    ))}
                  </select>
                }
              />

              <ControlRow
                label="Customer Category"
                editing={editing}
                value={
                  c.customerCategory ? (
                    <span
                      className={
                        'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ' +
                        (c.customerCategory === 'business'
                          ? 'bg-indigo-500/15 text-indigo-400'
                          : 'bg-gray-600/30 text-gray-300')
                      }
                    >
                      {CUSTOMER_CATEGORY_LABELS[c.customerCategory]}
                    </span>
                  ) : '—'
                }
                control={
                  <select name="customer_category" defaultValue={c.customerCategory ?? 'residential'} className={inputCls}>
                    {CUSTOMER_CATEGORIES.map((t) => (
                      <option key={t} value={t}>{CUSTOMER_CATEGORY_LABELS[t]}</option>
                    ))}
                  </select>
                }
              />

              <ControlRow
                label="Misc Category"
                editing={editing}
                value={c.miscCategoryName ?? '—'}
                control={
                  <select
                    name="misc_category_id"
                    defaultValue={c.miscCategoryId ? String(c.miscCategoryId) : ''}
                    className={inputCls}
                  >
                    <option value="">None</option>
                    {miscCategories.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                }
              />

              <div className="px-4 py-2">
                <span className="mb-1 block text-xs text-gray-500">Notes</span>
                {editing ? (
                  <textarea
                    name="notes"
                    rows={3}
                    defaultValue={c.notes ?? ''}
                    placeholder="Add notes about this customer..."
                    className={inputCls + ' resize-y'}
                  />
                ) : (
                  <p className="whitespace-pre-wrap text-sm text-gray-300">{c.notes || '—'}</p>
                )}
              </div>
            </>
          ) : null}
        </Card>

        {/* ---------------- Billing ---------------- */}
        <Card title="Billing Information" icon={Wallet}>
          {/* Straight into the payment flow with this customer preloaded. */}
          {can(role, 'record_payment') && !editing ? (
            <div className="px-4 pb-1 pt-3">
              <Link
                href={'/dashboard/payments/new?customer=' + c.id}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-green-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-green-500"
              >
                <Wallet className="h-4 w-4" aria-hidden />
                Record Payment
              </Link>
            </div>
          ) : null}

          {c.catalogAvailable ? (
            <ControlRow
              label="Service Plan"
              editing={editing}
              value={c.servicePlan ? describePlan(c.servicePlan) : '—'}
              control={
                <select
                  name="service_plan_id"
                  value={planId}
                  onChange={(e) => choosePlan(e.target.value)}
                  className={inputCls}
                >
                  <option value="">No plan</option>
                  {servicePlans.map((p) => (
                    <option key={p.id} value={p.id}>{describePlan(p)}</option>
                  ))}
                </select>
              }
            />
          ) : null}

          <ControlRow
            label="Monthly Rate"
            editing={editing}
            value={formatCurrency(c.monthly_rate)}
            control={
              <input
                name="monthly_rate"
                type="number"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                className={inputCls + ' text-right'}
              />
            }
          />

          <Row
            label="Balance"
            value={
              <span className={owed > 0 ? 'text-orange-400' : 'text-gray-200'}>
                {formatCurrency(owed)}
              </span>
            }
          />
          {/* No "Billing Type" row. There is one billing model, so the field
              named a choice that no longer exists — see lib/billing.ts. */}
          {c.billingAvailable ? (
            <>
              {/* Editable, capped 1-28 like the cut-off day. This is the field
                  serviceExpiry runs on, so it is the one an operator needs to
                  be able to correct. Shown for every customer now. */}
              <Row
                label="Bill Date"
                value={c.bill_date ? 'Day ' + c.bill_date + ' of each month' : '—'}
                editing={editing}
                name="bill_date"
                type="number"
                defaultValue={c.bill_date ?? ''}
              />
              {/* No "Carried Balance" row here any more: the Balance field
                  above now shows carried_balance for every billing type, and
                  two rows carrying the same number under two labels is how the
                  two columns got confused in the first place. */}
              {/* DATE column — same reason as Date Added. */}
              <Row label="Last Billed" value={formatDateOnly(c.last_billed_date)} />
            </>
          ) : null}

          <Row label="Cut Off Date" value={c.cut_off_date ? 'Day ' + c.cut_off_date : '—'} editing={editing} name="cut_off_date" type="number" defaultValue={c.cut_off_date ?? ''} />
          {/* From the registry, not last_bill_date. The billing date is kept
              in Postgres for record keeping but never drives a displayed or
              calculated expiry. */}
          <Row
            label="Expiry Date"
            value={
              radius.expiryDate ? (
                <span className="flex items-center justify-end gap-1.5">
                  {formatDateOnly(radius.expiryDate)}
                  <span className={networkDaysLeft !== null && networkDaysLeft < 0 ? 'text-red-400' : 'text-gray-500'}>
                    ({networkDaysLeft !== null && networkDaysLeft < 0
                      ? Math.abs(networkDaysLeft) + 'd overdue'
                      : networkDaysLeft + 'd left'})
                  </span>
                </span>
              ) : (
                <span className="text-gray-500">—</span>
              )
            }
          />

          <div className="px-4 py-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-gray-500">Expiry Mode</span>
              {editing && c.expiryModeEditable && mayNetwork ? (
                <span className="flex gap-1.5" role="group" aria-label="Expiry mode">
                  <input type="hidden" name="expiry_mode" value={expiryMode} />
                  {EXPIRY_MODES.map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setExpiryMode(m)}
                      aria-pressed={expiryMode === m}
                      className={
                        'rounded-md px-2 py-1 text-[11px] font-semibold transition ' +
                        (expiryMode === m
                          ? 'bg-blue-600 text-white'
                          : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200')
                      }
                    >
                      {EXPIRY_MODE_LABELS[m]}
                    </button>
                  ))}
                </span>
              ) : (
                <span className="text-sm text-gray-200">{EXPIRY_MODE_LABELS[c.expiryMode]}</span>
              )}
            </div>
            <p className="mt-1 text-[11px] leading-snug text-gray-600">
              {EXPIRY_MODE_HELP[editing ? expiryMode : c.expiryMode]}
            </p>
          </div>
        </Card>

        {/* ---------------- RADIUS / Authentication ---------------- */}
        {maySeeTech ? (
          <Card title="Network Status" icon={Radio}>
            <ControlRow
              label="Authentication Type"
              editing={editing}
              value={c.customerType ? CUSTOMER_TYPE_LABELS[c.customerType] : '—'}
              control={
                <select
                  name="customer_type"
                  value={authType}
                  onChange={(e) => setAuthType(e.target.value as CustomerType)}
                  className={inputCls}
                >
                  {CUSTOMER_TYPES.map((t) => (
                    <option key={t} value={t}>{CUSTOMER_TYPE_LABELS[t]}</option>
                  ))}
                </select>
              }
            />

            <Row
              label="Access Point / AP"
              value={c.accessPoint ?? '—'}
              editing={editing}
              name="access_point"
              defaultValue={c.accessPoint ?? ''}
            />

            <div className="flex items-center justify-between gap-3 px-4 py-2">
              <dt className="shrink-0 text-xs text-gray-500">
                MAC Address{editing && authType === 'pppoe' ? ' (optional)' : ''}
              </dt>
              <dd className="min-w-0 flex-1 text-right">
                {editing ? (
                  <MacAddressInput name="mac_address" value={mac} onChange={setMac} />
                ) : (
                  <MacAddressInput mode="display" value={c.mac_address ?? ''} className="justify-end" />
                )}
              </dd>
            </div>

            {editing && showPppoeFields ? (
              <>
                <div className="flex items-center justify-between gap-3 px-4 py-2">
                  <dt className="shrink-0 text-xs text-gray-500">PPPoE Username</dt>
                  <dd className="min-w-0 flex-1 text-right">
                    <input
                      name="pppoe_username"
                      defaultValue={c.pppoeUsername ?? ''}
                      autoComplete="off"
                      className={inputCls + ' text-right font-mono'}
                    />
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3 px-4 py-2">
                  <dt className="shrink-0 text-xs text-gray-500">PPPoE Password</dt>
                  <dd className="min-w-0 flex-1">
                    <div className="relative">
                      <input
                        name="pppoe_password"
                        type={showPassword ? 'text' : 'password'}
                        placeholder="Leave blank to keep"
                        autoComplete="new-password"
                        className={inputCls + ' pr-8 text-right'}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((v) => !v)}
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-500 transition hover:text-gray-300"
                      >
                        {showPassword ? <EyeOff className="h-3.5 w-3.5" aria-hidden /> : <Eye className="h-3.5 w-3.5" aria-hidden />}
                      </button>
                    </div>
                  </dd>
                </div>
              </>
            ) : null}

            {!editing && c.pppoeUsername ? (
              <Row label="PPPoE Username" value={c.pppoeUsername} mono />
            ) : null}

            <Row
              label="Last Seen Online"
              value={
                radius.lastSeen ? (
                  <span className={radius.online ? 'text-green-400' : undefined}>
                    {new Date(radius.lastSeen).toLocaleString()}
                    {radius.online ? ' (online now)' : ''}
                  </span>
                ) : (
                  <span className="text-gray-500">Never</span>
                )
              }
            />
            <Row
              label="Data Used (month)"
              value={
                radius.bytesThisMonth !== null ? (
                  <>
                    {formatBytes(radius.bytesThisMonth)}
                    {radius.sessionsThisMonth ? (
                      <span className="ml-1.5 text-[11px] text-gray-600">
                        {radius.sessionsThisMonth} session
                        {radius.sessionsThisMonth === 1 ? '' : 's'}
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="text-gray-500">—</span>
                )
              }
            />

            {!radius.available ? (
              <div className="px-4 py-3">
                <p className="flex items-start gap-1.5 text-[11px] leading-snug text-amber-400/80">
                  <Activity className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                  <span>
                    Could not reach the network. The figures above are unknown, not
                    zero.
                  </span>
                </p>
              </div>
            ) : status === 'unprovisioned' ? (
              <div className="px-4 py-3">
                <p className="flex items-start gap-1.5 text-[11px] leading-snug text-amber-400/80">
                  <Activity className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                  <span>
                    This customer is not in the network registry, so they cannot get
                    online.{' '}
                    {showProvision
                      ? 'Use Provision to write their registry entry.'
                      : 'A CSR or manager can provision this account.'}
                  </span>
                </p>
              </div>
            ) : null}
          </Card>
        ) : null}
      </div>

      {/* ---------------- Additional Services ---------------- */}
      {c.catalogAvailable ? (
        <section className="rounded-xl border border-gray-800 bg-gray-900">
          <header className="flex items-center justify-between gap-3 border-b border-gray-800 px-4 py-2.5">
            <span className="flex items-center gap-2">
              <Package className="h-4 w-4 text-gray-500" aria-hidden />
              <h2 className="text-sm font-semibold text-white">Additional Services</h2>
            </span>
            <span className="text-xs text-gray-500">
              {activeAddons.length} active
            </span>
          </header>

          <div className="p-4">
            {editing ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {additionalServices.length === 0 ? (
                  <p className="text-sm text-gray-600">No additional services configured.</p>
                ) : null}
                {additionalServices.map((a) => (
                  <label
                    key={a.id}
                    className="flex cursor-pointer items-center gap-3 rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-2 transition hover:border-gray-700"
                  >
                    <input
                      type="checkbox"
                      name="addon_ids"
                      value={a.id}
                      checked={addons.includes(a.id)}
                      onChange={(e) =>
                        setAddons((prev) =>
                          e.target.checked ? [...prev, a.id] : prev.filter((x) => x !== a.id)
                        )
                      }
                      className="h-4 w-4 shrink-0 accent-blue-600"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-gray-200">{a.name}</span>
                      {a.description ? (
                        <span className="block truncate text-xs text-gray-600">{a.description}</span>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-sm tabular-nums text-gray-300">
                      {formatCurrency(a.monthly_price)}
                    </span>
                  </label>
                ))}
              </div>
            ) : activeAddons.length === 0 ? (
              <p className="text-sm text-gray-600">No additional services on this account.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {activeAddons.map((a) => (
                  <span
                    key={a.id}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-green-500/15 px-2.5 py-1 text-xs font-medium text-green-400"
                  >
                    {a.name}
                    <span className="text-green-500/70">{formatCurrency(a.monthly_price)}</span>
                  </span>
                ))}
              </div>
            )}

            <div className="mt-3 flex items-center justify-between border-t border-gray-800 pt-3">
              <span className="text-xs text-gray-500">Total additional services</span>
              <span className="text-sm font-semibold tabular-nums text-white">
                {formatCurrency(addonTotal)}/mo
              </span>
            </div>
          </div>
        </section>
      ) : null}
    </form>
  )
}
