'use client'

import Link from 'next/link'
import { CircleCheck } from 'lucide-react'
import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'

import { createLead, type LeadResult } from '@/app/actions/leads'
import { LocationCapture } from '@/components/leads/LocationCapture'
import { useMoney } from '@/components/money/Currency'
import { describePlan, type PlanOption } from '@/lib/types'

const inputBase =
  'w-full rounded-lg border bg-gray-800 px-3 py-2.5 text-base text-white placeholder:text-gray-500 outline-none transition focus:ring-2'
const inputOk = ' border-gray-700 focus:border-blue-500 focus:ring-blue-500/30'
const inputBad = ' border-red-700 focus:border-red-500 focus:ring-red-500/30'

function Field({
  label, htmlFor, error, hint, children, required, className,
}: {
  label: string
  htmlFor?: string
  error?: string
  hint?: string
  children: React.ReactNode
  required?: boolean
  className?: string
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
      // The biggest thing on the screen. A rep taps this once, standing up,
      // while the customer watches.
      className="w-full rounded-xl bg-blue-600 px-4 py-3.5 text-base font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? 'Saving…' : 'Save prospect'}
    </button>
  )
}

/**
 * Signing somebody up at their gate.
 *
 * BUILT FOR A PHONE, not shrunk to fit one. One column, base-size text so iOS
 * does not zoom on focus, numeric keypads where the value is a number, and the
 * save button full width at the bottom.
 *
 * ONLY FOUR THINGS ARE REQUIRED — name, phone, address — because a rep is
 * standing in front of somebody who is talking to them. Price, plan, location
 * and notes can all be filled in later from the office. A prospect saved with
 * a name and a number is worth having; a form that argues is not.
 *
 * AFTER A SAVE IT CLEARS ITSELF AND SAYS SO, with the option to go straight
 * into the next one, because the next door is ten feet away.
 */
export function NewLeadForm({
  servicePlans,
  defaultMonthlyRate,
}: {
  servicePlans: PlanOption[]
  /** The company default, offered as the starting monthly rate. */
  defaultMonthlyRate: number
}) {
  const [state, formAction] = useActionState<LeadResult | null, FormData>(createLead, null)
  const { symbol } = useMoney()
  const errors = (state && !state.ok && state.fieldErrors) || {}

  // Bumped after each save so React discards the whole subtree and every
  // field — including the location capture — starts empty for the next door.
  const [round, setRound] = useState(0)
  const [rate, setRate] = useState(
    defaultMonthlyRate > 0 ? String(defaultMonthlyRate) : ''
  )

  const saved = state && state.ok ? state : null

  return (
    <div className="mx-auto w-full max-w-xl space-y-4">
      {saved ? (
        <div className="rounded-xl border border-green-900 bg-green-950/40 p-4">
          <p className="flex items-start gap-2 text-sm font-semibold text-green-300">
            <CircleCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            {saved.message}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setRound((n) => n + 1)}
              className="rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500"
            >
              Add the next one
            </button>
            <Link
              href="/dashboard/leads"
              className="rounded-lg bg-gray-800 px-4 py-2.5 text-sm font-semibold text-gray-200 transition hover:bg-gray-700"
            >
              See my prospects
            </Link>
          </div>
        </div>
      ) : null}

      {state && !state.ok && state.error ? (
        <p role="alert" className="rounded-lg border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          {state.error}
        </p>
      ) : null}

      <form key={round} action={formAction} className="space-y-4">
        <section className="space-y-4 rounded-xl border border-gray-800 bg-gray-900 p-4 sm:p-5">
          <h2 className="text-sm font-semibold text-white">Who they are</h2>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="First Name" htmlFor="first_name" error={errors.first_name} required>
              <input
                id="first_name"
                name="first_name"
                autoComplete="off"
                autoCapitalize="words"
                className={inputBase + (errors.first_name ? inputBad : inputOk)}
              />
            </Field>

            <Field label="Last Name" htmlFor="last_name" error={errors.last_name} required>
              <input
                id="last_name"
                name="last_name"
                autoComplete="off"
                autoCapitalize="words"
                className={inputBase + (errors.last_name ? inputBad : inputOk)}
              />
            </Field>

            <Field label="Phone" htmlFor="phone" error={errors.phone} required>
              <input
                id="phone"
                name="phone"
                // type=tel opens the phone keypad, which is the only keyboard
                // this field ever needs.
                type="tel"
                inputMode="tel"
                autoComplete="off"
                placeholder="876 000 0000"
                className={inputBase + (errors.phone ? inputBad : inputOk)}
              />
            </Field>

            <Field
              label="Address"
              htmlFor="address"
              error={errors.address}
              required
              className="sm:col-span-2"
            >
              <textarea
                id="address"
                name="address"
                rows={2}
                autoCapitalize="sentences"
                placeholder="How you would describe it to a driver"
                className={inputBase + (errors.address ? inputBad : inputOk)}
              />
            </Field>
          </div>
        </section>

        <section className="space-y-3 rounded-xl border border-gray-800 bg-gray-900 p-4 sm:p-5">
          <div>
            <h2 className="text-sm font-semibold text-white">Where they are</h2>
            <p className="mt-0.5 text-[11px] text-gray-500">
              Tap this while you are standing at the house.
            </p>
          </div>
          <LocationCapture />
        </section>

        <section className="space-y-4 rounded-xl border border-gray-800 bg-gray-900 p-4 sm:p-5">
          <h2 className="text-sm font-semibold text-white">What they were quoted</h2>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={'Installation (' + symbol + ')'}
              htmlFor="install_fee"
              error={errors.install_fee}
              hint="What you agreed for the installation."
            >
              <input
                id="install_fee"
                name="install_fee"
                type="number"
                inputMode="decimal"
                min="0"
                step="1"
                placeholder="0"
                className={inputBase + (errors.install_fee ? inputBad : inputOk)}
              />
            </Field>

            <Field
              label={'Monthly (' + symbol + ')'}
              htmlFor="monthly_rate"
              error={errors.monthly_rate}
              hint="Leave as is unless you agreed something else."
            >
              <input
                id="monthly_rate"
                name="monthly_rate"
                type="number"
                inputMode="decimal"
                min="0"
                step="1"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                className={inputBase + (errors.monthly_rate ? inputBad : inputOk)}
              />
            </Field>

            {servicePlans.length > 0 ? (
              <Field label="Package" htmlFor="service_plan_id" className="sm:col-span-2">
                <select
                  id="service_plan_id"
                  name="service_plan_id"
                  defaultValue=""
                  className={inputBase + inputOk}
                >
                  <option value="">Not decided</option>
                  {servicePlans.map((p) => (
                    <option key={p.id} value={p.id}>{describePlan(p)}</option>
                  ))}
                </select>
              </Field>
            ) : null}

            <Field
              label="Notes"
              htmlFor="notes"
              className="sm:col-span-2"
              hint="Anything the installer or the office should know."
            >
              <textarea
                id="notes"
                name="notes"
                rows={3}
                autoCapitalize="sentences"
                placeholder="Best time to come, dogs, where the pole is…"
                className={inputBase + inputOk}
              />
            </Field>
          </div>
        </section>

        <SaveButton />

        <p className="pb-2 text-center text-[11px] text-gray-600">
          This saves a prospect, not a customer. Nobody is billed and no service
          is switched on until the office turns it into an account.
        </p>
      </form>
    </div>
  )
}
