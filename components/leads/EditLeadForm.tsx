'use client'

import { CircleCheck, Pencil, Trash2, TriangleAlert } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useActionState, useState, useTransition } from 'react'
import { useFormStatus } from 'react-dom'

import { deleteLead, updateLead, type LeadResult } from '@/app/actions/leads'
import { LocationCapture } from '@/components/leads/LocationCapture'
import { useMoney } from '@/components/money/Currency'
import type { Lead } from '@/lib/data/leads'
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
      className="rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? 'Saving…' : 'Save changes'}
    </button>
  )
}

/**
 * Correcting a prospect, and — for an admin — removing one.
 *
 * WHY EDITING IS OPEN TO EVERYONE WHO CAN SEE THE ROW (owner, 10 Nov 2026).
 * These records are typed one-handed at a gate by somebody being talked at, so
 * a wrong digit in a phone number is the normal case, not the exception. The
 * person who notices is whoever is looking at it, and until now none of them
 * could fix it: there was no edit at all, only "they signed up" and "not
 * interested". So the rule is simply that if the prospect is in your list, you
 * can correct it — a rep their own, the office everybody's.
 *
 * DELETING IS NOT. It is admin-only and two taps, because the row is somebody
 * else's day's work and there is no undo. "Not interested" is the reversible
 * way to close a prospect off and is what everyone else gets.
 *
 * The form opens collapsed. The prospect page is read first and edited rarely,
 * and a page of filled-in boxes reads like a form to complete.
 */
export function EditLeadForm({
  lead,
  servicePlans,
  canDelete,
}: {
  lead: Lead
  servicePlans: PlanOption[]
  /** delete_lead. Admin only — see lib/permissions.ts. */
  canDelete: boolean
}) {
  const router = useRouter()
  const { symbol } = useMoney()
  const [open, setOpen] = useState(false)
  const [state, formAction] = useActionState<LeadResult | null, FormData>(updateLead, null)
  const errors = (state && !state.ok && state.fieldErrors) || {}

  // Delete runs outside the form's own action, so it needs its own pending
  // state and its own result. Two taps: the button arms, then confirms.
  const [armed, setArmed] = useState(false)
  const [deleting, startDelete] = useTransition()
  const [deleteError, setDeleteError] = useState<string | null>(null)

  function remove() {
    setDeleteError(null)
    const fd = new FormData()
    fd.set('lead_id', String(lead.id))
    startDelete(async () => {
      const r = await deleteLead(fd)
      if (r.ok) {
        // The record this page is about no longer exists, so do not re-render
        // it — go back to the list, which is where the person now is.
        router.replace('/dashboard/leads')
        return
      }
      setArmed(false)
      setDeleteError(r.error ?? 'Could not delete the prospect.')
    })
  }

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-gray-800 px-4 py-2.5 text-sm font-semibold text-gray-200 transition hover:bg-gray-700"
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden />
          Edit details
        </button>

        {state && state.ok ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-green-400">
            <CircleCheck className="h-3.5 w-3.5" aria-hidden />
            {state.message}
          </span>
        ) : null}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {state && !state.ok && state.error ? (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {state.error}
        </p>
      ) : null}

      <form action={formAction} className="space-y-5 rounded-xl border border-gray-800 bg-gray-900 p-4 sm:p-5">
        <input type="hidden" name="lead_id" value={lead.id} />

        <div>
          <h3 className="text-sm font-semibold text-white">Edit this prospect</h3>
          <p className="mt-0.5 text-[11px] text-gray-500">
            Corrections only. Whether they signed up or said no is set by the
            buttons above, not here.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First Name" htmlFor="first_name" error={errors.first_name} required>
            <input
              id="first_name"
              name="first_name"
              defaultValue={lead.firstName}
              autoComplete="off"
              autoCapitalize="words"
              className={inputBase + (errors.first_name ? inputBad : inputOk)}
            />
          </Field>

          <Field label="Last Name" htmlFor="last_name" error={errors.last_name} required>
            <input
              id="last_name"
              name="last_name"
              defaultValue={lead.lastName}
              autoComplete="off"
              autoCapitalize="words"
              className={inputBase + (errors.last_name ? inputBad : inputOk)}
            />
          </Field>

          <Field label="Phone" htmlFor="phone" error={errors.phone} required>
            <input
              id="phone"
              name="phone"
              type="tel"
              inputMode="tel"
              defaultValue={lead.phone}
              autoComplete="off"
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
              defaultValue={lead.address}
              autoCapitalize="sentences"
              className={inputBase + (errors.address ? inputBad : inputOk)}
            />
          </Field>

          <Field
            label={'Installation (' + symbol + ')'}
            htmlFor="install_fee"
            error={errors.install_fee}
          >
            <input
              id="install_fee"
              name="install_fee"
              type="number"
              inputMode="decimal"
              min="0"
              step="1"
              defaultValue={lead.installFee > 0 ? String(lead.installFee) : ''}
              placeholder="0"
              className={inputBase + (errors.install_fee ? inputBad : inputOk)}
            />
          </Field>

          <Field
            label={'Monthly (' + symbol + ')'}
            htmlFor="monthly_rate"
            error={errors.monthly_rate}
          >
            <input
              id="monthly_rate"
              name="monthly_rate"
              type="number"
              inputMode="decimal"
              min="0"
              step="1"
              defaultValue={lead.monthlyRate !== null ? String(lead.monthlyRate) : ''}
              className={inputBase + (errors.monthly_rate ? inputBad : inputOk)}
            />
          </Field>

          {servicePlans.length > 0 ? (
            <Field label="Package" htmlFor="service_plan_id" className="sm:col-span-2">
              <select
                id="service_plan_id"
                name="service_plan_id"
                defaultValue={lead.servicePlanId !== null ? String(lead.servicePlanId) : ''}
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
              defaultValue={lead.notes ?? ''}
              autoCapitalize="sentences"
              className={inputBase + inputOk}
            />
          </Field>
        </div>

        <div className="space-y-2 border-t border-gray-800 pt-4">
          <p className="text-xs font-medium text-gray-400">Location</p>
          {/* LEAVING THIS ALONE KEEPS THE EXISTING FIX. The capture sends empty
              values until somebody actually takes a reading, and the server
              reads empty as "no change" — so correcting a name from the office
              cannot throw away the coordinate the rep walked to the house for.
              Only tapping it, standing at the house, replaces the fix. */}
          <p className="text-[11px] text-gray-500">
            {lead.latitude !== null && lead.longitude !== null
              ? 'A location is already saved. It stays as it is unless you take a new reading here, standing at the house.'
              : 'No location saved. Take a reading here while you are at the house.'}
          </p>
          <LocationCapture />
        </div>

        <div className="flex flex-wrap gap-2">
          <SaveButton />
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-lg bg-gray-800 px-4 py-2.5 text-sm font-semibold text-gray-300 transition hover:bg-gray-700"
          >
            Cancel
          </button>
        </div>
      </form>

      {canDelete ? (
        <div className="space-y-2 rounded-xl border border-red-950 bg-red-950/20 p-4">
          <p className="text-xs font-semibold text-red-300">Delete this prospect</p>
          <p className="text-[11px] text-red-400/70">
            Gone for good, including who signed them up and what they were
            quoted. &ldquo;Not interested&rdquo; keeps the record instead.
          </p>

          {deleteError ? (
            <p role="alert" className="flex items-start gap-2 text-xs text-red-300">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              {deleteError}
            </p>
          ) : null}

          {armed ? (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={remove}
                disabled={deleting}
                className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-red-500 disabled:opacity-60"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                {deleting ? 'Deleting…' : 'Yes, delete ' + lead.name}
              </button>
              <button
                type="button"
                onClick={() => setArmed(false)}
                disabled={deleting}
                className="rounded-lg bg-gray-800 px-4 py-2.5 text-sm font-semibold text-gray-300 transition hover:bg-gray-700"
              >
                Keep it
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setArmed(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-900 px-4 py-2.5 text-sm font-semibold text-red-300 transition hover:bg-red-950/50"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
              Delete
            </button>
          )}
        </div>
      ) : null}
    </div>
  )
}
