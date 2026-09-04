'use client'

import Link from 'next/link'
import { Eye, EyeOff } from 'lucide-react'
import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'

import { createCustomer, type ActionResult } from '@/app/actions/customers'
import { MacAddressInput } from '@/components/ui/MacAddressInput'
import { formatCurrency } from '@/lib/format'
import {
  BILLING_TYPES, BILLING_TYPE_HELP, BILLING_TYPE_LABELS, toBillingType,
  type BillingType,
} from '@/lib/billing'
import {
  CONNECTION_TYPES, CONNECTION_TYPE_LABELS, CUSTOMER_CATEGORIES,
  CUSTOMER_CATEGORY_LABELS, CUSTOMER_TYPES, CUSTOMER_TYPE_LABELS, describePlan,
  toCustomerType,
  type AdditionalService, type CustomerType,
  type MiscCategory, type ServicePlan,
} from '@/lib/types'

const inputBase =
  'w-full rounded-lg border bg-gray-800 px-3 py-2 text-sm text-white placeholder:text-gray-500 outline-none transition focus:ring-2'
const inputOk = ' border-gray-700 focus:border-blue-500 focus:ring-blue-500/30'
const inputBad = ' border-red-700 focus:border-red-500 focus:ring-red-500/30'

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
      <h2 className="mb-4 text-sm font-semibold text-white">{title}</h2>
      {children}
    </section>
  )
}

function Field({
  label, htmlFor, error, hint, children, className, required,
}: {
  label: string
  htmlFor?: string
  error?: string
  hint?: string
  children: React.ReactNode
  className?: string
  required?: boolean
}) {
  return (
    <div className={'space-y-1.5 ' + (className ?? '')}>
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
      {pending ? 'Saving…' : 'Save Customer'}
    </button>
  )
}

export function NewCustomerForm({
  servicePlans,
  additionalServices,
  miscCategories,
  typesAvailable,
  catalogAvailable,
  defaultMonthlyRate,
  billingAvailable,
  defaultBillingType,
  defaultBillDate,
}: {
  servicePlans: ServicePlan[]
  additionalServices: AdditionalService[]
  miscCategories: MiscCategory[]
  typesAvailable: boolean
  catalogAvailable: boolean
  /** 0 means no company default — the field starts empty. */
  defaultMonthlyRate: number
  /** False until migration 0011 is applied; the control renders disabled. */
  billingAvailable: boolean
  /** From settings.default_billing_type. */
  defaultBillingType: BillingType
  /** From settings.bill_date — the company's default bill day. Null when the
   *  setting has never been saved; the field then starts on day 1. */
  defaultBillDate: number | null
}) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(createCustomer, null)

  const prior = state && !state.ok ? (state.values ?? {}) : {}
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {}
  const v = (name: string) => prior[name] ?? ''

  const [authType, setAuthType] = useState<CustomerType>(toCustomerType(prior.customer_type))
  const [mac, setMac] = useState(v('mac_address'))
  const [showPassword, setShowPassword] = useState(false)
  const [planId, setPlanId] = useState(v('service_plan_id'))
  // A failed submit re-seeds from what was typed; otherwise fall back to the
  // company default, and leave the field empty when there is none.
  const [rate, setRate] = useState(
    v('monthly_rate') || (defaultMonthlyRate > 0 ? String(defaultMonthlyRate) : '')
  )
  const [addons, setAddons] = useState<number[]>([])
  // A failed submit re-seeds from what was posted, so switching to postpaid and
  // tripping a validation error elsewhere does not silently revert the choice.
  const [billingType, setBillingType] = useState<BillingType>(
    prior.billing_type ? toBillingType(prior.billing_type) : defaultBillingType
  )

  const showPppoeFields = authType === 'pppoe' || authType === 'hotspot'
  // Matches the server rule: MAC only becomes optional for PPPoE once
  // migration 0003 has dropped the NOT NULL constraint.
  const macRequired = authType !== 'pppoe' || !typesAvailable
  const cls = (name: string) => inputBase + (errors[name] ? inputBad : inputOk)

  /** Picking a plan pre-fills the rate; it stays editable afterwards. */
  function choosePlan(value: string) {
    setPlanId(value)
    const plan = servicePlans.find((p) => String(p.id) === value)
    if (plan) setRate(String(Number(plan.monthly_price)))
  }

  const addonTotal = additionalServices
    .filter((a) => addons.includes(a.id))
    .reduce((sum, a) => sum + Number(a.monthly_price ?? 0), 0)

  return (
    <form action={formAction} className="space-y-4">
      {/* The dropdown drives which fields show; mirror it into the payload. */}
      <input type="hidden" name="customer_type" value={authType} />

      {state && !state.ok ? (
        <p role="alert" className="rounded-lg border border-red-900/60 bg-red-950/50 px-3 py-2 text-sm text-red-300">
          {state.error}
        </p>
      ) : null}

      <Card title="Personal Information">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First Name" htmlFor="first_name" error={errors.first_name} required>
            <input id="first_name" name="first_name" defaultValue={v('first_name')} className={cls('first_name')} />
          </Field>
          <Field label="Last Name" htmlFor="last_name" error={errors.last_name} required>
            <input id="last_name" name="last_name" defaultValue={v('last_name')} className={cls('last_name')} />
          </Field>
          <Field label="Phone" htmlFor="phone" error={errors.phone} required>
            <input id="phone" name="phone" defaultValue={v('phone')} placeholder="+1-876-555-0000" className={cls('phone')} />
          </Field>
          <Field label="Email" htmlFor="email" error={errors.email}>
            <input id="email" name="email" type="email" defaultValue={v('email')} className={cls('email')} />
          </Field>
          <Field label="Address" htmlFor="address" error={errors.address} className="sm:col-span-2" required>
            <input id="address" name="address" defaultValue={v('address')} className={cls('address')} />
          </Field>
          <Field label="GPS Coordinates" htmlFor="gps" error={errors.gps}>
            <input id="gps" name="gps" defaultValue={v('gps')} placeholder="lat,lng e.g. 18.0179,-76.8099" className={cls('gps')} />
          </Field>

          {catalogAvailable ? (
            <>
              <Field label="Connection Type" htmlFor="connection_type">
                <select id="connection_type" name="connection_type" defaultValue={v('connection_type') || 'wireless'} className={cls('connection_type')}>
                  {CONNECTION_TYPES.map((t) => (
                    <option key={t} value={t}>{CONNECTION_TYPE_LABELS[t]}</option>
                  ))}
                </select>
              </Field>

              <Field label="Customer Category" htmlFor="customer_category">
                <select id="customer_category" name="customer_category" defaultValue={v('customer_category') || 'residential'} className={cls('customer_category')}>
                  {CUSTOMER_CATEGORIES.map((t) => (
                    <option key={t} value={t}>{CUSTOMER_CATEGORY_LABELS[t]}</option>
                  ))}
                </select>
              </Field>

              <Field label="Misc Category" htmlFor="misc_category_id">
                <select id="misc_category_id" name="misc_category_id" defaultValue={v('misc_category_id')} className={cls('misc_category_id')}>
                  <option value="">None</option>
                  {miscCategories.map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
              </Field>

              <Field label="Notes" htmlFor="notes" className="sm:col-span-2">
                <textarea
                  id="notes"
                  name="notes"
                  rows={3}
                  defaultValue={v('notes')}
                  placeholder="Add notes about this customer..."
                  className={cls('notes') + ' resize-y'}
                />
              </Field>
            </>
          ) : null}
        </div>
      </Card>

      <Card title="Connection Details">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Authentication Type"
            htmlFor="auth_type"
            hint={typesAvailable ? undefined : 'Not saved until migration 0003 is applied.'}
          >
            <select
              id="auth_type"
              value={authType}
              onChange={(e) => setAuthType(e.target.value as CustomerType)}
              className={cls('customer_type')}
            >
              {CUSTOMER_TYPES.map((t) => (
                <option key={t} value={t}>{CUSTOMER_TYPE_LABELS[t]}</option>
              ))}
            </select>
          </Field>

          <Field label="Access Point" htmlFor="access_point">
            <input id="access_point" name="access_point" defaultValue={v('access_point')} placeholder="e.g. Tower 1, AP-North" className={cls('access_point')} />
          </Field>

          <Field
            label={'MAC Address' + (macRequired ? '' : ' (optional for PPPoE)')}
            htmlFor="mac_address"
            error={errors.mac_address}
            className="sm:col-span-2"
            required={macRequired}
          >
            <MacAddressInput
              id="mac_address"
              name="mac_address"
              value={mac}
              onChange={setMac}
              required={macRequired}
            />
          </Field>

          {showPppoeFields ? (
            <>
              <Field label="PPPoE Username" htmlFor="pppoe_username" error={errors.pppoe_username}>
                <input id="pppoe_username" name="pppoe_username" defaultValue={v('pppoe_username')} autoComplete="off" className={cls('pppoe_username')} />
              </Field>

              <Field label="PPPoE Password" htmlFor="pppoe_password">
                <div className="relative">
                  <input
                    id="pppoe_password"
                    name="pppoe_password"
                    type={showPassword ? 'text' : 'password'}
                    defaultValue={v('pppoe_password')}
                    autoComplete="new-password"
                    className={cls('pppoe_password') + ' pr-9'}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((x) => !x)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-gray-500 transition hover:text-gray-300"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
                  </button>
                </div>
              </Field>
            </>
          ) : null}
        </div>

        {/* Accurate as of the network wiring: adding a customer deliberately
            writes nothing to the network. Activation is a separate, explicit
            step so a half-filled record can never be put on the network. */}
        <p className="mt-4 rounded-lg border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-300/90">
          <strong className="font-semibold">This customer will not be online yet.</strong>{' '}
          Saving creates their record only. Open the customer and choose{' '}
          <strong className="font-semibold">Activate Now</strong> to give them internet access.
        </p>
      </Card>

      <Card title="Billing &amp; Service">
        <div className="grid gap-4 sm:grid-cols-2">
          {catalogAvailable ? (
            <Field label="Service Plan" htmlFor="service_plan_id" hint="Selecting a plan fills in the rate.">
              <select
                id="service_plan_id"
                name="service_plan_id"
                value={planId}
                onChange={(e) => choosePlan(e.target.value)}
                className={cls('service_plan_id')}
              >
                <option value="">No plan</option>
                {servicePlans.map((p) => (
                  <option key={p.id} value={p.id}>{describePlan(p)}</option>
                ))}
              </select>
            </Field>
          ) : null}

          <Field label="Monthly Rate" htmlFor="monthly_rate" error={errors.monthly_rate} required>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-500">J$</span>
              <input
                id="monthly_rate"
                name="monthly_rate"
                type="number"
                min="0"
                step="1"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                placeholder="3000"
                className={cls('monthly_rate') + ' pl-9'}
              />
            </div>
          </Field>

          {/* Billing type decides when the money is collected, so it sits
              above the dates it governs. Bill Date only exists for postpaid —
              a prepaid customer has no bill run to generate. */}
          <Field
            label="Billing Type"
            hint={billingAvailable ? BILLING_TYPE_HELP[billingType] : 'Needs migration 0011.'}
            className="sm:col-span-2"
          >
            <input type="hidden" name="billing_type" value={billingType} />
            <div className="flex gap-2" role="group" aria-label="Billing type">
              {BILLING_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setBillingType(t)}
                  aria-pressed={billingType === t}
                  disabled={!billingAvailable}
                  className={
                    'flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ' +
                    (billingType === t
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200')
                  }
                >
                  {BILLING_TYPE_LABELS[t]}
                </button>
              ))}
            </div>
          </Field>

          {billingAvailable && billingType === 'postpaid' ? (
            <Field
              label="Bill Date"
              htmlFor="bill_date"
              error={errors.bill_date}
              hint="Day of month billing is generated (1-28)"
            >
              <input
                id="bill_date"
                name="bill_date"
                type="number"
                min="1"
                max="28"
                defaultValue={v('bill_date') || (defaultBillDate ?? 1)}
                className={cls('bill_date')}
              />
            </Field>
          ) : null}

          <Field label="Cut Off Date" htmlFor="cut_off_date" error={errors.cut_off_date} hint="Day of month (1-28)">
            <input id="cut_off_date" name="cut_off_date" type="number" min="1" max="28" defaultValue={v('cut_off_date') || 5} className={cls('cut_off_date')} />
          </Field>

        </div>
      </Card>

      {catalogAvailable ? (
        <Card title="Additional Services">
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

          <div className="mt-3 flex items-center justify-between border-t border-gray-800 pt-3">
            <span className="text-xs text-gray-500">Total additional services</span>
            <span className="text-sm font-semibold tabular-nums text-white">
              {formatCurrency(addonTotal)}/mo
            </span>
          </div>
        </Card>
      ) : null}

      <div className="flex items-center gap-2">
        <SaveButton />
        <Link
          href="/dashboard/customers"
          className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-medium text-gray-300 transition hover:bg-gray-700"
        >
          Cancel
        </Link>
      </div>
    </form>
  )
}
