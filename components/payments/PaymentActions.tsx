'use client'

import { Pencil, Trash2, TriangleAlert } from 'lucide-react'
import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'

import { deletePayment, updatePayment, type PaymentResult } from '@/app/actions/payments'
import { Modal } from '@/components/settings/Modal'
import { formatCurrency } from '@/lib/format'

const PAYMENT_TYPES = ['cash', 'card', 'online'] as const
const MONTH_OPTIONS = [1, 2, 3, 4, 5, 6]

const inputBase =
  'w-full rounded-lg border bg-gray-800 px-3 py-2 text-sm text-white placeholder:text-gray-500 outline-none transition focus:ring-2'
const inputOk = ' border-gray-700 focus:border-blue-500 focus:ring-blue-500/30'
const inputBad = ' border-red-700 focus:border-red-500 focus:ring-red-500/30'

export type EditablePayment = {
  id: number
  amount: number
  months_paid: number | null
  payment_type: string | null
  payment_date: string
  agent: string | null
  notes: string | null
  customerName: string
}

/**
 * Edit and delete controls for one payment.
 *
 * Both rights are resolved on the server and passed in as booleans — the server
 * actions re-check them, so hiding a button here is presentation only.
 */
export function PaymentActions({
  payment,
  canEdit,
  canDelete,
}: {
  payment: EditablePayment
  canEdit: boolean
  canDelete: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)

  if (!canEdit && !canDelete) return null

  return (
    <div className="flex flex-wrap items-center gap-2">
      {canEdit ? (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-gray-800 px-3 py-2 text-sm font-semibold text-gray-200 transition hover:bg-gray-700"
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden />
          Edit
        </button>
      ) : null}

      {canDelete ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm font-semibold text-red-300 transition hover:bg-red-950/70"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
          Delete
        </button>
      ) : null}

      {editing ? (
        <Modal title={'Edit payment #' + payment.id} onClose={() => setEditing(false)}>
          <EditForm payment={payment} onCancel={() => setEditing(false)} />
        </Modal>
      ) : null}

      {confirming ? (
        <Modal title="Delete this payment?" onClose={() => setConfirming(false)}>
          <ConfirmDelete payment={payment} onCancel={() => setConfirming(false)} />
        </Modal>
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
      {pending ? 'Saving…' : 'Save changes'}
    </button>
  )
}

function EditForm({ payment, onCancel }: { payment: EditablePayment; onCancel: () => void }) {
  const [state, formAction] = useActionState<PaymentResult | null, FormData>(updatePayment, null)
  const errors = (state && !state.ok && state.fieldErrors) || {}

  const [months, setMonths] = useState(payment.months_paid ?? 1)
  const [payType, setPayType] = useState(payment.payment_type ?? 'cash')

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="payment_id" value={payment.id} />
      <input type="hidden" name="months_paid" value={months} />
      <input type="hidden" name="payment_type" value={payType} />

      {state && !state.ok ? (
        <p
          role="alert"
          className="rounded-lg border border-red-900/60 bg-red-950/50 px-3 py-2 text-sm text-red-300"
        >
          {state.error}
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="edit-amount" className="block text-xs font-medium text-gray-400">
            Amount
          </label>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-500">
              J$
            </span>
            <input
              id="edit-amount"
              name="amount"
              type="number"
              min="1"
              step="1"
              required
              defaultValue={payment.amount}
              className={inputBase + (errors.amount ? inputBad : inputOk) + ' pl-9'}
            />
          </div>
          {errors.amount ? (
            <p role="alert" className="text-xs text-red-400">{errors.amount}</p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <span className="block text-xs font-medium text-gray-400">Months Paid</span>
          <div className="flex gap-1.5" role="group" aria-label="Months paid">
            {MONTH_OPTIONS.map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={m === months}
                onClick={() => setMonths(m)}
                className={
                  'h-9 flex-1 rounded-lg text-sm font-semibold transition ' +
                  (m === months
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700')
                }
              >
                {m}
              </button>
            ))}
          </div>
          {errors.months_paid ? (
            <p role="alert" className="text-xs text-red-400">{errors.months_paid}</p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <span className="block text-xs font-medium text-gray-400">Payment Type</span>
          <div className="flex gap-2" role="group" aria-label="Payment type">
            {PAYMENT_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={t === payType}
                onClick={() => setPayType(t)}
                className={
                  'h-9 flex-1 rounded-lg text-sm font-semibold capitalize transition ' +
                  (t === payType
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700')
                }
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="edit-date" className="block text-xs font-medium text-gray-400">
            Payment Date
          </label>
          <input
            id="edit-date"
            name="payment_date"
            type="date"
            required
            defaultValue={payment.payment_date.slice(0, 10)}
            className={inputBase + (errors.payment_date ? inputBad : inputOk)}
          />
          {errors.payment_date ? (
            <p role="alert" className="text-xs text-red-400">{errors.payment_date}</p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <label htmlFor="edit-agent" className="block text-xs font-medium text-gray-400">
            Agent
          </label>
          <input
            id="edit-agent"
            name="agent"
            type="text"
            required
            defaultValue={payment.agent ?? ''}
            className={inputBase + (errors.agent ? inputBad : inputOk)}
          />
          {errors.agent ? (
            <p role="alert" className="text-xs text-red-400">{errors.agent}</p>
          ) : null}
        </div>

        <div className="space-y-1.5 sm:col-span-2">
          <label htmlFor="edit-notes" className="block text-xs font-medium text-gray-400">
            Notes
          </label>
          <textarea
            id="edit-notes"
            name="notes"
            rows={2}
            defaultValue={payment.notes ?? ''}
            className={inputBase + inputOk}
          />
        </div>
      </div>

      <p className="rounded-lg border border-gray-800 bg-gray-950/60 px-3 py-2 text-xs text-gray-500">
        Correcting the amount adjusts {payment.customerName}&rsquo;s balance by the difference.
        The billing cycle and expiry date are not recalculated — change those on the customer
        record if this correction needs to move them.
      </p>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-semibold text-gray-300 transition hover:bg-gray-700"
        >
          Cancel
        </button>
        <SaveButton />
      </div>
    </form>
  )
}

function DeleteButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? 'Deleting…' : 'Delete payment'}
    </button>
  )
}

function ConfirmDelete({
  payment,
  onCancel,
}: {
  payment: EditablePayment
  onCancel: () => void
}) {
  return (
    <form action={deletePayment} className="space-y-4">
      <input type="hidden" name="payment_id" value={payment.id} />

      <div className="flex gap-3 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-3">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-400" aria-hidden />
        <div className="space-y-1.5 text-sm text-red-200">
          <p>
            This permanently removes the {formatCurrency(payment.amount)} payment recorded for{' '}
            <span className="font-semibold">{payment.customerName}</span>. It cannot be undone.
          </p>
          <p className="text-xs text-red-300/80">
            {formatCurrency(payment.amount)} will be added back to their balance. Their expiry
            date will not be rewound.
          </p>
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-semibold text-gray-300 transition hover:bg-gray-700"
        >
          Cancel
        </button>
        <DeleteButton />
      </div>
    </form>
  )
}
