'use client'

import { Ban, Plus, Receipt } from 'lucide-react'
import { useState } from 'react'
import { createPortal, useFormStatus } from 'react-dom'

import { addCharge, voidCharge } from '@/app/actions/charges'
import { Modal } from '@/components/settings/Modal'
import type { CustomerCharge } from '@/lib/data/charges'
import { CATEGORY_NAME_MAX, type PaymentCategory } from '@/lib/data/payment-categories'
import { formatCurrency, formatDateOnly } from '@/lib/format'

/** What the category select submits for its "+ Add new category" row. */
const NEW_CATEGORY = '__new__'

const inputCls =
  'w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30'

function Submit({ label, busy, tone }: { label: string; busy: string; tone: 'blue' | 'red' }) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className={
        'rounded-lg px-4 py-2 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-60 ' +
        (tone === 'red' ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-500')
      }
    >
      {pending ? busy : label}
    </button>
  )
}

const STATUS_STYLE: Record<CustomerCharge['status'], string> = {
  open: 'bg-orange-500/10 text-orange-400',
  paid: 'bg-emerald-500/10 text-emerald-400',
  voided: 'bg-gray-700/40 text-gray-400',
}

/**
 * One-off charges on a customer: installation, hardware, reconnection.
 *
 * KEPT APART FROM THE SERVICE BALANCE, on screen as in the data. Nothing here
 * changes what the customer owes for service or when their access ends; it is
 * money owed that the till can take payment against. Managers and above add
 * and void charges; anyone at the till can take money against one.
 */
export function OneOffCharges({
  customerId,
  customerName,
  charges,
  categories,
  canManage,
}: {
  customerId: number
  customerName: string
  charges: CustomerCharge[]
  categories: PaymentCategory[]
  canManage: boolean
}) {
  const [adding, setAdding] = useState(false)
  const [voiding, setVoiding] = useState<CustomerCharge | null>(null)

  const outstanding = charges.reduce((s, c) => s + c.outstanding, 0)

  return (
    <section className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-800 px-5 py-3">
        <div>
          <h2 className="text-sm font-semibold text-white">One-off Charges</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            {outstanding > 0
              ? formatCurrency(outstanding) + ' outstanding · separate from the service balance'
              : 'Nothing outstanding · separate from the service balance'}
          </p>
        </div>
        {canManage ? (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1 rounded-lg bg-gray-800 px-3 py-1.5 text-xs font-semibold text-gray-200 transition hover:bg-gray-700"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Add Charge
          </button>
        ) : null}
      </header>

      {charges.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-gray-600">No one-off charges.</p>
      ) : (
        <ul className="divide-y divide-gray-800">
          {charges.map((c) => (
            <li key={c.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-gray-200">
                  <Receipt className="h-3.5 w-3.5 text-gray-500" aria-hidden />
                  {c.category}
                  <span
                    className={
                      'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ' +
                      STATUS_STYLE[c.status]
                    }
                  >
                    {c.status}
                  </span>
                </p>
                <p className="mt-0.5 text-xs text-gray-500">
                  {formatDateOnly(c.chargedOn)}
                  {c.createdByName ? ' · added by ' + c.createdByName : ''}
                </p>
                {c.note ? <p className="mt-0.5 text-xs text-gray-400">{c.note}</p> : null}
                {c.status === 'voided' ? (
                  <p className="mt-0.5 text-xs text-gray-500">
                    Voided{c.voidedByName ? ' by ' + c.voidedByName : ''}
                    {c.writtenOff > 0 ? ', ' + formatCurrency(c.writtenOff) + ' written off' : ''}
                    {c.voidReason ? ': ' + c.voidReason : ''}
                  </p>
                ) : null}
              </div>

              <div className="flex items-start gap-3">
                <dl className="text-right text-xs">
                  <div className="flex justify-end gap-2">
                    <dt className="text-gray-500">Charged</dt>
                    <dd className="tabular-nums text-gray-300">{formatCurrency(c.amount)}</dd>
                  </div>
                  <div className="flex justify-end gap-2">
                    <dt className="text-gray-500">Paid</dt>
                    <dd className="tabular-nums text-gray-300">{formatCurrency(c.paid)}</dd>
                  </div>
                  <div className="flex justify-end gap-2">
                    <dt className="text-gray-500">Owing</dt>
                    <dd
                      className={
                        'tabular-nums font-semibold ' +
                        (c.outstanding > 0 ? 'text-orange-400' : 'text-gray-300')
                      }
                    >
                      {formatCurrency(c.outstanding)}
                    </dd>
                  </div>
                </dl>
                {canManage && c.status === 'open' ? (
                  <button
                    type="button"
                    onClick={() => setVoiding(c)}
                    aria-label={'Void ' + c.category + ' charge'}
                    className="inline-flex items-center gap-1 rounded-md bg-gray-800 px-2 py-1 text-[11px] font-semibold text-gray-400 transition hover:bg-gray-700 hover:text-red-300"
                  >
                    <Ban className="h-3 w-3" aria-hidden />
                    Void
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {adding
        ? createPortal(
            <AddChargeModal
              customerId={customerId}
              customerName={customerName}
              categories={categories}
              onClose={() => setAdding(false)}
            />,
            document.body
          )
        : null}

      {voiding
        ? createPortal(
            <VoidChargeModal
              customerId={customerId}
              charge={voiding}
              onClose={() => setVoiding(null)}
            />,
            document.body
          )
        : null}
    </section>
  )
}

function AddChargeModal({
  customerId, customerName, categories, onClose,
}: {
  customerId: number
  customerName: string
  categories: PaymentCategory[]
  onClose: () => void
}) {
  const [categoryId, setCategoryId] = useState('')
  const [newCategory, setNewCategory] = useState('')
  const [amount, setAmount] = useState('')
  // The browser's today, which is the manager's today. The server refuses a
  // date past its own today.
  const [chargedOn, setChargedOn] = useState(() => {
    const d = new Date()
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0')
  })

  const parsed = Number(amount)
  const ready =
    (categoryId !== '' && (categoryId !== NEW_CATEGORY || newCategory.trim() !== '')) &&
    amount !== '' && Number.isFinite(parsed) && parsed > 0 && chargedOn !== ''

  return (
    <Modal title="Add One-off Charge" onClose={onClose}>
      <form action={addCharge} className="space-y-4">
        <input type="hidden" name="customer_id" value={customerId} />

        <div className="flex items-baseline justify-between gap-3 rounded-lg border border-gray-800 bg-gray-950/60 px-3 py-2.5 text-sm">
          <span className="text-xs text-gray-500">Customer</span>
          <span className="font-medium text-gray-200">{customerName}</span>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="charge_category" className="block text-xs font-medium text-gray-400">
            What is it for?
          </label>
          <select
            id="charge_category"
            name="payment_category_id"
            required
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className={inputCls}
          >
            <option value="">Select a category…</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
            <option value={NEW_CATEGORY}>+ Add new category</option>
          </select>
          {categoryId === NEW_CATEGORY ? (
            <input
              name="new_payment_category"
              type="text"
              required
              autoFocus
              maxLength={CATEGORY_NAME_MAX}
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              placeholder="e.g. Installation"
              className={inputCls}
            />
          ) : null}
          <p className="text-xs text-gray-500">
            The same list the till uses for other payments.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="charge_amount" className="block text-xs font-medium text-gray-400">
              Amount
            </label>
            <input
              id="charge_amount"
              name="amount"
              type="number"
              min="0.01"
              step="0.01"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className={inputCls}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="charge_date" className="block text-xs font-medium text-gray-400">
              Date
            </label>
            <input
              id="charge_date"
              name="charged_on"
              type="date"
              required
              value={chargedOn}
              onChange={(e) => setChargedOn(e.target.value)}
              className={inputCls + ' [color-scheme:dark]'}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="charge_note" className="block text-xs font-medium text-gray-400">
            Note <span className="text-gray-600">(optional)</span>
          </label>
          <textarea
            id="charge_note"
            name="note"
            rows={2}
            maxLength={500}
            placeholder="e.g. Dish and router, installed 27 Sep"
            className={inputCls + ' resize-y'}
          />
        </div>

        <p className="rounded-lg border border-blue-900/50 bg-blue-950/30 px-3 py-2 text-xs text-blue-300/80">
          This is owed separately from service. It does not change the service
          balance, the expiry, or internet access. The till will show it so it
          can be paid.
        </p>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-semibold text-gray-300 transition hover:bg-gray-700"
          >
            Cancel
          </button>
          <span className={ready ? '' : 'pointer-events-none opacity-60'}>
            <Submit label="Add Charge" busy="Adding…" tone="blue" />
          </span>
        </div>
      </form>
    </Modal>
  )
}

function VoidChargeModal({
  customerId, charge, onClose,
}: {
  customerId: number
  charge: CustomerCharge
  onClose: () => void
}) {
  const [reason, setReason] = useState('')

  return (
    <Modal title={'Void ' + charge.category + ' Charge'} onClose={onClose}>
      <form action={voidCharge} className="space-y-4">
        <input type="hidden" name="customer_id" value={customerId} />
        <input type="hidden" name="charge_id" value={charge.id} />

        <dl className="space-y-1.5 rounded-lg border border-gray-800 bg-gray-950/60 px-3 py-2.5 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-xs text-gray-500">Charged</dt>
            <dd className="tabular-nums text-gray-300">{formatCurrency(charge.amount)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-xs text-gray-500">Paid (stands)</dt>
            <dd className="tabular-nums text-gray-300">{formatCurrency(charge.paid)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-xs text-gray-500">Written off</dt>
            <dd className="tabular-nums font-semibold text-red-300">
              {formatCurrency(charge.outstanding)}
            </dd>
          </div>
        </dl>

        <div className="space-y-1.5">
          <label htmlFor="void_reason" className="block text-xs font-medium text-gray-400">
            Reason <span className="text-gray-600">(required)</span>
          </label>
          <textarea
            id="void_reason"
            name="reason"
            required
            rows={3}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Installation fee waived by the owner."
            className={inputCls + ' resize-y'}
          />
          <p className="text-xs text-gray-500">
            Recorded in the log with your name. No further payment can be taken
            against this charge.
          </p>
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-semibold text-gray-300 transition hover:bg-gray-700"
          >
            Cancel
          </button>
          <span className={reason.trim() ? '' : 'pointer-events-none opacity-60'}>
            <Submit label="Void Charge" busy="Voiding…" tone="red" />
          </span>
        </div>
      </form>
    </Modal>
  )
}
