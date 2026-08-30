'use client'

import { CheckCircle2, Loader2, Search, TriangleAlert, X } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  useActionState, useEffect, useRef, useState, useSyncExternalStore,
} from 'react'
import { useFormStatus } from 'react-dom'

import { recordPayment, type PaymentResult } from '@/app/actions/payments'
import { ReceiptModal } from '@/components/payments/ReceiptModal'
import type { SearchHit } from '@/app/api/search/route'
import { StatusBadge } from '@/components/customers/StatusBadge'
import {
  amountDue as computeAmountDue, billingPeriodLabel, isPartialPayment,
  outstandingBalance, parseYmd, postpaidExpiry, proportionalDate, ymd,
  type AccessDecision,
} from '@/lib/billing'
import {
  PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentMethod,
} from '@/lib/data/checkoff'
import {
  CATEGORY_NAME_MAX, type PaymentCategory,
} from '@/lib/data/payment-categories'
import { prepaidExpiry } from '@/lib/expiry'
import { currencySymbol } from '@/lib/format'
import { canExtend, STATUS_DOT } from '@/lib/status'
import { toExpiryMode } from '@/lib/types'

const MONTH_OPTIONS = [1, 2, 3, 4, 5, 6]

/** What the Purpose dropdown submits for its "+ Add new category" row. */
const NEW_CATEGORY = '__new__'

/** The two kinds of payment the form can record. */
type PaymentKind = 'service' | 'other'

// --- today, without a hydration mismatch -----------------------------------
// The date is read from the clock rather than held in state: "today" on the
// server that renders this and "today" in the cashier's browser are not
// necessarily the same date. The server snapshot is empty, so the first client
// render matches it and the real date arrives on hydration.
const subscribeToClock = () => () => {}
const todayOnClient = () => ymd(new Date())
const todayOnServer = () => ''

/**
 * How long the amount field has to be quiet before the partial-payment prompt
 * decides. Long enough that typing "3500" does not flash the prompt at "3",
 * "35" and "350" on the way.
 */
const PARTIAL_DEBOUNCE_MS = 600

const inputBase =
  'w-full rounded-lg border bg-gray-800 px-3 py-2 text-sm text-white placeholder:text-gray-500 outline-none transition focus:ring-2'
const inputOk = ' border-gray-700 focus:border-blue-500 focus:ring-blue-500/30'
const inputBad = ' border-red-700 focus:border-red-500 focus:ring-red-500/30'

const DOTS = STATUS_DOT

const fmtDate = (d: Date) =>
  d.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })

/**
 * The preview of the expiry the server is about to write to radcheck.
 *
 * Runs lib/expiry.ts#prepaidExpiry — the very function app/actions/payments.ts
 * runs on submit — so the date on screen and the date written cannot disagree.
 * The server remains the source of truth; nothing computed here is trusted.
 *
 * Anchored on network_expiry — the date held in the registry — NOT on
 * expires_at, which is derived from last_bill_date. Using the billing date
 * here previewed (and wrote) an expiry earlier than the customer already had.
 *
 * PREPAID ONLY. Postpaid runs to its bill date plus the grace period instead,
 * which is lib/billing.ts#postpaidExpiry.
 */
function previewExpiry(hit: SearchHit, months: number, paymentDate: Date): Date {
  return prepaidExpiry({
    mode: toExpiryMode(hit.expiry_mode),
    currentExpiry: hit.network_expiry ? new Date(hit.network_expiry) : null,
    monthsPaid: months,
    paymentDate,
    cutOffDay: hit.cut_off_date,
  })
}

/**
 * What the Amount field should start at.
 *
 * Postpaid bills for a period already used, so there is one figure to collect
 * and it is pre-filled. Prepaid buys months forward, so it stays driven by the
 * months dropdown exactly as before.
 */
function seedAmount(hit: SearchHit | null, postpaid: boolean, months: number): string {
  if (!hit) return ''
  if (postpaid) return String(computeAmountDue(hit.total_monthly, hit.carried_balance))
  return String(hit.total_monthly * months)
}

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-lg bg-green-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-green-500 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? 'Recording…' : 'Record Payment'}
    </button>
  )
}

export function RecordPaymentForm({
  initialCustomer,
  currency,
  gracePeriodDays,
  billingAvailable,
  paymentCategories,
  otherPaymentsAvailable,
  onCustomerChange,
}: {
  initialCustomer: SearchHit | null
  currency: string
  /** Company-wide grace period, added to a postpaid customer's bill date. */
  gracePeriodDays: number
  /** False until migration 0011 is applied; every customer then reads prepaid. */
  billingAvailable: boolean
  /** The Purpose list for "other" payments. Empty until 0013 is applied. */
  paymentCategories: PaymentCategory[]
  /** False until migration 0013 is applied; the type toggle is then not shown
   *  at all and the form behaves exactly as it did before. */
  otherPaymentsAvailable: boolean
  /** Fires whenever the picked customer changes, so the page can switch
   *  between the browsing and focused layouts. */
  onCustomerChange?: (hit: SearchHit | null) => void
}) {
  const router = useRouter()
  const [state, formAction] = useActionState<PaymentResult | null, FormData>(recordPayment, null)

  const [selected, setSelected] = useState<SearchHit | null>(initialCustomer)
  const [term, setTerm] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [open, setOpen] = useState(false)
  const [searching, setSearching] = useState(false)

  const isPostpaid = (hit: SearchHit | null) =>
    Boolean(billingAvailable && hit && hit.billing_type === 'postpaid')

  const [months, setMonths] = useState(1)
  const [amount, setAmount] = useState(
    seedAmount(initialCustomer, isPostpaid(initialCustomer), 1)
  )
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [notes, setNotes] = useState('')

  // --- payment kind ---
  // Service is the default and is what the form has always done. Everything
  // billing-related is keyed off this being 'service'.
  const [kind, setKind] = useState<PaymentKind>('service')
  const isOther = otherPaymentsAvailable && kind === 'other'

  const [categoryId, setCategoryId] = useState('')
  const [newCategory, setNewCategory] = useState('')

  // --- payment date ---
  // Only the cashier's override is state; the default is today, derived. A
  // blank value submits fine — the server defaults it to today as well.
  const todayYmd = useSyncExternalStore(subscribeToClock, todayOnClient, todayOnServer)
  const [pickedPaidOn, setPickedPaidOn] = useState<string | null>(null)
  const paidOn = pickedPaidOn ?? todayYmd
  const setPaidOn = setPickedPaidOn

  // --- receipt ---
  // Derived from the action result rather than pushed into state by an effect.
  // Recording a payment opens the receipt; closing it records the dismissal,
  // and the View Receipt button reopens the same id.
  const [dismissedReceipt, setDismissedReceipt] = useState<number | null>(null)
  const [reopenedReceipt, setReopenedReceipt] = useState<number | null>(null)
  const recordedId = (state?.ok && state.paymentId) || null
  const receiptFor =
    reopenedReceipt ?? (recordedId && recordedId !== dismissedReceipt ? recordedId : null)

  const closeReceipt = () => {
    if (receiptFor) setDismissedReceipt(receiptFor)
    setReopenedReceipt(null)
  }

  // --- partial payment ---
  // The prompt is driven by the DEBOUNCED amount, never the live one, so it
  // appears once the cashier stops typing rather than flickering per keystroke.
  const [debouncedAmount, setDebouncedAmount] = useState(amount)
  const [accessChoice, setAccessChoice] = useState<AccessDecision>('full_period')
  const [pickedDate, setPickedDate] = useState('')
  // Until the cashier touches the picker it tracks the proportional date, so
  // changing the amount re-suggests. Once touched, their date stands.
  const [dateTouched, setDateTouched] = useState(false)

  const wrapRef = useRef<HTMLDivElement>(null)
  const symbol = currencySymbol(currency)
  const errors = (state && !state.ok && state.fieldErrors) || {}
  const succeeded = Boolean(state?.ok)

  const money = (n: number) => symbol + fmtNum(n)

  // "Record Another Payment" clears the panel without a round trip. Tracked by
  // identity so a later success shows its own panel again.
  const [dismissed, setDismissed] = useState<PaymentResult | null>(null)
  const showSuccess = Boolean(state?.ok) && state !== dismissed

  // The collections panel beside this form is a server component, so a
  // successful payment has to re-render the route to bring it up to date.
  useEffect(() => {
    if (succeeded) router.refresh()
  }, [succeeded, router])


  useEffect(() => {
    const id = setTimeout(() => setDebouncedAmount(amount), PARTIAL_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [amount])

  // --- customer search ---
  // Nothing is cleared synchronously here: a short term simply derives an
  // empty result list below, which keeps this effect free of setState calls.
  useEffect(() => {
    const q = term.trim()
    if (q.length < 2) return

    const id = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await fetch('/api/search?q=' + encodeURIComponent(q))
        const body = await res.json()
        setHits(body.results ?? [])
        setOpen(true)
      } catch {
        setHits([])
      } finally {
        setSearching(false)
      }
    }, 300)

    return () => clearTimeout(id)
  }, [term])

  // A term under two characters shows nothing, regardless of what the last
  // completed search returned.
  const visibleHits = term.trim().length >= 2 ? hits : []

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  /** Resets everything that describes how a short payment is being handled. */
  function resetPartial() {
    setAccessChoice('full_period')
    setPickedDate('')
    setDateTouched(false)
  }

  /** Clears the fields that belong to an "other" payment. */
  function resetOther() {
    setCategoryId('')
    setNewCategory('')
  }

  function pick(hit: SearchHit) {
    const next = seedAmount(hit, isPostpaid(hit), months)
    setSelected(hit)
    setAmount(next)
    // Seeded rather than debounced-into, so a preloaded short amount does not
    // sit for 600ms showing a prompt built from the previous customer.
    setDebouncedAmount(next)
    resetPartial()
    setTerm('')
    setHits([])
    setOpen(false)
    onCustomerChange?.(hit)
  }

  /** Clears the customer and every field that belongs to their payment. */
  function clearCustomer() {
    setSelected(null)
    setTerm('')
    setAmount('')
    setDebouncedAmount('')
    setMonths(1)
    setMethod('cash')
    setNotes('')
    resetPartial()
    resetOther()
    onCustomerChange?.(null)
  }

  function chooseMonths(m: number) {
    setMonths(m)
    if (selected) setAmount(String(selected.total_monthly * m))
  }

  // --- success state ---
  if (state?.ok && showSuccess) {
    return (
      <>
      {receiptFor ? (
        <ReceiptModal
          paymentId={receiptFor}
          subtitle={
            money(state.amount ?? 0) + ' from ' + (state.customerName ?? 'customer')
          }
          onClose={closeReceipt}
        />
      ) : null}
      <div className="rounded-xl border border-green-900/50 bg-green-950/20 p-8 text-center">
        <CheckCircle2 className="mx-auto h-16 w-16 text-green-400" aria-hidden />
        <p className="mt-4 text-lg font-semibold text-white">
          Payment of {symbol}
          {new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(state.amount ?? 0)}
          {' '}recorded for {state.customerName}
        </p>

        {/* The payment always saved. Whether access moved is a separate fact,
            and is never implied. */}
        {state.networkExtended && state.newExpiryIso ? (
          <p className="mt-1 text-sm text-green-400">
            Access extended to {fmtDate(new Date(state.newExpiryIso))}
          </p>
        ) : null}

        {/* A short payment leaves money owing, so the cashier is told the
            figure they need to repeat back to the customer. */}
        {state.carriedBalance ? (
          <p className="mt-1 text-sm text-orange-400">
            Outstanding balance of {money(state.carriedBalance)} carried to their next bill
          </p>
        ) : null}

        {state.warning ? (
          <div className="mx-auto mt-4 max-w-md rounded-lg border border-amber-800/60 bg-amber-950/40 px-4 py-3 text-left">
            <p className="flex gap-2 text-sm text-amber-300">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{state.warning}</span>
            </p>
          </div>
        ) : null}

        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            type="button"
            onClick={() => {
              setDismissed(state)
              clearCustomer()
            }}
            className="rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500"
          >
            Record Another Payment
          </button>
          {state.customerId ? (
            <Link
              href={'/dashboard/customers/' + state.customerId}
              className="rounded-lg bg-gray-800 px-4 py-2.5 text-sm font-semibold text-gray-200 transition hover:bg-gray-700"
            >
              View Customer
            </Link>
          ) : null}
          {/* The modal is dismissable, so the receipt has to stay reachable
              from the panel behind it. */}
          {state.paymentId ? (
            <button
              type="button"
              onClick={() => setReopenedReceipt(state.paymentId ?? null)}
              className="rounded-lg bg-gray-800 px-4 py-2.5 text-sm font-semibold text-gray-200 transition hover:bg-gray-700"
            >
              View Receipt
            </button>
          ) : null}
        </div>
      </div>
      </>
    )
  }

  // -------------------------------------------------------------------------
  // Derived billing figures.
  //
  // Every one of these mirrors a calculation app/actions/payments.ts repeats
  // server side against the database. Nothing computed here is trusted on
  // submit — only the cashier's two decisions (how much, and which date) are.
  // -------------------------------------------------------------------------
  const today = new Date()
  const postpaid = isPostpaid(selected)

  // The customer's full monthly charge — their rate plus every active add-on.
  // Billing the bare monthly_rate would drop add-ons from the amount due.
  const monthlyCharge = selected ? selected.total_monthly : 0
  const carried = selected ? selected.carried_balance : 0
  const due = computeAmountDue(monthlyCharge, carried)

  const paid = Number(debouncedAmount)
  const partial =
    selected !== null &&
    Number.isFinite(paid) &&
    isPartialPayment(monthlyCharge, carried, paid)

  const currentExpiry = selected?.network_expiry ? new Date(selected.network_expiry) : null

  // Full payment, and the "Full Period" branch of a short one, land on the
  // same date — the period the customer would have got had they paid in full.
  const fullPeriodExpiry = selected
    ? postpaid
      ? postpaidExpiry(selected.bill_date, gracePeriodDays, today)
      : previewExpiry(selected, months, today)
    : null

  const proportional = selected
    ? proportionalDate({
        billingType: postpaid ? 'postpaid' : 'prepaid',
        amountPaid: paid,
        monthlyCharge,
        currentExpiry,
        from: today,
      })
    : null

  const proportionalYmd = proportional ? ymd(proportional) : ''
  const accessDate = dateTouched && pickedDate ? pickedDate : proportionalYmd

  // Always the month's charge less what was handed over, whatever date the
  // cashier picks. The date decides access; it never changes what is owed.
  const outstanding = selected ? outstandingBalance(monthlyCharge, paid) : 0

  const dateChosen = partial && accessChoice === 'date_selected'
  // ISO dates compare correctly as strings, so no parsing is needed here.
  const beyondProportional = Boolean(
    dateChosen && accessDate && proportionalYmd && accessDate > proportionalYmd
  )

  const newExpiry = dateChosen ? parseYmd(accessDate) : fullPeriodExpiry

  return (
    <form action={formAction} className="space-y-4">
      {state && !state.ok ? (
        <p role="alert" className="rounded-lg border border-red-900/60 bg-red-950/50 px-3 py-2 text-sm text-red-300">
          {state.error}
        </p>
      ) : null}

      {/* ---------------- Payment type ----------------
          Only rendered once migration 0013 is applied. Without it the form is
          exactly what it was before: a service payment, with no toggle. */}
      {otherPaymentsAvailable ? (
        <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
          <fieldset>
            <legend className="mb-3 text-sm font-semibold text-white">Payment Type</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              <KindOption
                id="kind-service"
                checked={!isOther}
                onSelect={() => setKind('service')}
                title="Service"
                hint="Monthly internet service"
              />
              <KindOption
                id="kind-other"
                checked={isOther}
                onSelect={() => {
                  setKind('other')
                  // The amount was seeded from the customer's monthly charge,
                  // which has nothing to do with a one-off fee. Clearing it
                  // stops the cashier accepting a service figure by reflex.
                  setAmount('')
                  setDebouncedAmount('')
                  resetPartial()
                }}
                title="Other"
                hint="Installation, hardware, fees"
              />
            </div>
          </fieldset>
        </section>
      ) : null}

      {/* ---------------- Customer ---------------- */}
      <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <h2 className="mb-3 text-sm font-semibold text-white">Customer</h2>

        {/* Hidden once a customer is picked: the card below then reads as a
            summary of the payment being taken, and Clear is how you change
            who it is for. */}
        <div className={selected ? 'hidden' : ''}>
          <label
            htmlFor="payment-search"
            className="mb-1.5 block text-xs font-medium text-gray-400"
          >
            Customer Lookup
          </label>
        </div>

        <div ref={wrapRef} className={'relative' + (selected ? ' hidden' : '')}>
          {searching ? (
            <Loader2 className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 animate-spin text-blue-400" aria-hidden />
          ) : (
            <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-500" aria-hidden />
          )}
          <input
            id="payment-search"
            type="search"
            autoComplete="off"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onFocus={() => visibleHits.length > 0 && setOpen(true)}
            placeholder="Search by name, phone or MAC..."
            className="w-full rounded-lg border border-gray-700 bg-gray-800 py-3 pl-12 pr-3 text-base text-white placeholder:text-gray-500 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30"
          />

          {open && visibleHits.length > 0 ? (
            <div className="absolute left-0 right-0 top-14 z-50 overflow-hidden rounded-lg bg-gray-800 shadow-xl ring-1 ring-black/40">
              <ul className="max-h-80 overflow-y-auto">
                {visibleHits.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => pick(r)}
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition hover:bg-gray-700"
                    >
                      <span className={'h-2 w-2 shrink-0 rounded-full ' + DOTS[r.status]} aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-white">
                          {[r.first_name, r.last_name].filter(Boolean).join(' ')}
                        </span>
                        <span className="block truncate text-xs text-gray-400">
                          {r.phone ?? 'No phone'}
                        </span>
                      </span>
                      <StatusBadge status={r.status} />
                      <span className="shrink-0 text-xs text-gray-400">
                        {/* Registry expiry, matching the card and detail page.
                            expires_at is billing-derived and never shown. */}
                        {r.network_expiry ? fmtDate(new Date(r.network_expiry)) : '—'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        {selected ? (
          <div className="relative rounded-lg bg-gray-800 p-4">
            <input type="hidden" name="customer_id" value={selected.id} />

            <button
              type="button"
              onClick={clearCustomer}
              aria-label="Clear selected customer"
              className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-md bg-gray-700 px-2 py-1 text-[11px] font-semibold text-gray-300 transition hover:bg-gray-600"
            >
              <X className="h-3 w-3" aria-hidden />
              Clear
            </button>

            {/* Name leads the card so the cashier can confirm who they are
                serving at a glance; the expiry they are about to change sits
                directly under it. Both come from the registry, never from the
                billing dates. */}
            <p className="pr-16 text-2xl font-bold tracking-tight text-white">
              {[selected.first_name, selected.last_name].filter(Boolean).join(' ')}
            </p>

            {/* An "other" payment moves no expiry, so the date the customer
                currently holds is not part of the transaction and showing it
                would invite the cashier to think it will change. */}
            {isOther ? null : (
              <p className="mt-1 pr-16 text-xs text-gray-400">
                Current Expiry:{' '}
                <span className="font-medium text-gray-200">
                  {selected.network_expiry ? fmtDate(new Date(selected.network_expiry)) : '—'}
                </span>
              </p>
            )}

            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-400">
              <span>{selected.phone ?? 'No phone'}</span>
              <span className="text-gray-700">|</span>
              <StatusBadge status={selected.status} />
              {postpaid ? (
                <>
                  <span className="text-gray-700">|</span>
                  <span className="rounded bg-purple-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-purple-300">
                    Postpaid
                  </span>
                </>
              ) : null}
            </div>

            {/* Everything below this point on the card is billing: the plan
                and add-ons that make up the monthly charge, and the amount due
                built from them. None of it describes an "other" payment, which
                settles a one-off fee and nothing on the account. */}
            {isOther ? null : (
              <>
                <div className="my-3 border-t border-gray-700" />

                <dl className="space-y-1.5 text-sm">
                  <Line
                    label="Service Plan"
                    value={selected.service_plan ? selected.service_plan.name : 'No plan'}
                  />
                  {/* Add-ons are itemised because they are part of the amount due;
                      dropping them would leave the total unexplainable. */}
                  {selected.addons.map((a) => (
                    <Line key={a.id} label={a.name} value={money(a.price) + '/mo'} muted />
                  ))}
                </dl>

                <div className="my-3 border-t border-gray-700" />

                <dl className="space-y-1.5 text-sm">
                  <Line label="Amount Due" value={money(due)} emphasis />
                  {/* Shown whenever anything is carried, so the customer is never
                      asked for a figure larger than their plan without being told
                      where the difference came from. */}
                  {carried > 0 ? (
                    <p className="text-right text-xs text-gray-500">
                      {money(monthlyCharge)} monthly + {money(carried)} balance
                    </p>
                  ) : null}
                  <Line
                    label="Current Balance"
                    value={money(carried)}
                    tone={carried > 0 ? 'text-orange-400' : undefined}
                  />
                </dl>
              </>
            )}

            {/* Warned before the payment is taken, not after: the cashier can
                tell the customer what will and will not happen up front. The
                server re-checks and repeats this on the receipt. */}
            {!isOther && !canExtend(selected.status) ? (
              <div className="mt-3 rounded-lg border border-amber-800/60 bg-amber-950/40 px-3 py-2.5">
                <p className="flex gap-2 text-xs leading-snug text-amber-300">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span>
                    {selected.status === 'unknown'
                      ? 'The network could not be reached, so access may not be extended by this payment.'
                      : 'This customer is not activated on the network. Payment will be recorded but internet access will not be extended until the customer is provisioned.'}
                  </span>
                </p>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="mt-3 text-xs text-gray-600">Search and select a customer to continue.</p>
        )}
      </section>

      {/* ---------------- Payment ---------------- */}
      {selected ? (
        <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
          <h2 className="mb-4 text-sm font-semibold text-white">Payment Details</h2>

          {/* ---------------- Other payment ----------------
              Purpose, amount, method, date, notes. No months, no expiry
              preview, no partial-payment prompt and no amount due: an "other"
              payment does not settle a bill, so none of those questions
              apply to it. */}
          {isOther ? (
            <div className="space-y-4">
              <input type="hidden" name="payment_kind" value="other" />

              <div className="space-y-1.5">
                <label
                  htmlFor="payment_category_id"
                  className="block text-xs font-medium text-gray-400"
                >
                  Purpose
                </label>
                <select
                  id="payment_category_id"
                  name="payment_category_id"
                  required
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                  className={inputBase + (errors.payment_category_id ? inputBad : inputOk)}
                >
                  <option value="">Select a purpose…</option>
                  {paymentCategories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                  {/* Always last, so the list of real purposes reads as a list
                      and the way to extend it sits at the end of it. */}
                  <option value={NEW_CATEGORY}>+ Add new category</option>
                </select>
                {errors.payment_category_id ? (
                  <p role="alert" className="text-xs text-red-400">
                    {errors.payment_category_id}
                  </p>
                ) : null}

                {/* Revealed inline rather than in a dialog: the cashier is
                    mid-transaction with a customer waiting, and a category is
                    one short field. It is saved with the payment. */}
                {categoryId === NEW_CATEGORY ? (
                  <div className="space-y-1.5 pt-1.5">
                    <label
                      htmlFor="new_payment_category"
                      className="block text-xs font-medium text-gray-400"
                    >
                      New category name
                    </label>
                    <input
                      id="new_payment_category"
                      name="new_payment_category"
                      type="text"
                      required
                      autoFocus
                      maxLength={CATEGORY_NAME_MAX}
                      value={newCategory}
                      onChange={(e) => setNewCategory(e.target.value)}
                      placeholder="e.g. Installation"
                      className={
                        inputBase + (errors.new_payment_category ? inputBad : inputOk)
                      }
                    />
                    <p className="text-right text-xs text-gray-500 tabular-nums">
                      {newCategory.length}/{CATEGORY_NAME_MAX}
                    </p>
                    {errors.new_payment_category ? (
                      <p role="alert" className="text-xs text-red-400">
                        {errors.new_payment_category}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>

              {/* The same loud amount control the service form uses — it is the
                  figure the cashier and the customer both check. */}
              <div className="space-y-1.5">
                <label
                  htmlFor="amount"
                  className="block text-xs font-semibold uppercase tracking-wider text-gray-400"
                >
                  Amount
                </label>
                <div className="relative">
                  <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-xl font-semibold text-gray-500">
                    {symbol}
                  </span>
                  <input
                    id="amount"
                    name="amount"
                    type="number"
                    min="1"
                    step="1"
                    required
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className={
                      'w-full rounded-xl border-2 bg-gray-950 py-3 pl-14 pr-4 text-2xl font-bold tabular-nums text-white outline-none transition focus:ring-4 ' +
                      (errors.amount
                        ? 'border-red-700 focus:border-red-500 focus:ring-red-500/20'
                        : 'border-gray-700 focus:border-blue-500 focus:ring-blue-500/20')
                    }
                  />
                </div>
                {errors.amount ? (
                  <p role="alert" className="text-xs text-red-400">{errors.amount}</p>
                ) : null}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label
                    htmlFor="payment_method"
                    className="block text-xs font-medium text-gray-400"
                  >
                    Method
                  </label>
                  <select
                    id="payment_method"
                    name="payment_method"
                    value={method}
                    onChange={(e) => setMethod(e.target.value as PaymentMethod)}
                    className={inputBase + inputOk}
                  >
                    {PAYMENT_METHODS.map((m) => (
                      <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="paid_on" className="block text-xs font-medium text-gray-400">
                    Date
                  </label>
                  <input
                    id="paid_on"
                    name="paid_on"
                    type="date"
                    value={paidOn}
                    max={todayYmd || undefined}
                    onChange={(e) => setPaidOn(e.target.value)}
                    className={
                      inputBase + (errors.paid_on ? inputBad : inputOk) + ' [color-scheme:dark]'
                    }
                  />
                  {errors.paid_on ? (
                    <p role="alert" className="text-xs text-red-400">{errors.paid_on}</p>
                  ) : null}
                </div>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="notes" className="block text-xs font-medium text-gray-400">
                  Notes {method === 'other' ? '(required)' : '(optional)'}
                </label>
                <textarea
                  id="notes"
                  name="notes"
                  rows={2}
                  required={method === 'other'}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder={
                    method === 'other'
                      ? 'Describe the payment method…'
                      : 'Anything worth recording about this payment…'
                  }
                  className={inputBase + (errors.notes ? inputBad : inputOk)}
                />
                {errors.notes ? (
                  <p role="alert" className="text-xs text-red-400">{errors.notes}</p>
                ) : null}
              </div>
            </div>
          ) : (
          <>
          <div className="grid gap-4 sm:grid-cols-2">
            {/* Prepaid buys months forward, so the dropdown drives the amount.
                Postpaid bills for one period already used — there is nothing
                to choose, so the control is not rendered at all and the server
                falls back to a single month. */}
            {postpaid ? null : (
              <div className="space-y-1.5">
                <label htmlFor="months_paid" className="block text-xs font-medium text-gray-400">
                  Months to pay
                </label>
                <select
                  id="months_paid"
                  name="months_paid"
                  value={months}
                  onChange={(e) => chooseMonths(Number(e.target.value))}
                  className={inputBase + (errors.months_paid ? inputBad : inputOk)}
                >
                  {MONTH_OPTIONS.map((m) => (
                    <option key={m} value={m}>
                      {m} {m === 1 ? 'month' : 'months'}
                    </option>
                  ))}
                </select>
                {errors.months_paid ? (
                  <p role="alert" className="text-xs text-red-400">{errors.months_paid}</p>
                ) : null}
              </div>
            )}

            <div className={'space-y-1.5' + (postpaid ? ' sm:col-span-2' : '')}>
              <label htmlFor="payment_method" className="block text-xs font-medium text-gray-400">
                Payment Method
              </label>
              <select
                id="payment_method"
                name="payment_method"
                value={method}
                onChange={(e) => setMethod(e.target.value as PaymentMethod)}
                className={inputBase + inputOk}
              >
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>
                ))}
              </select>

              {/* "Other" says nothing on its own, so the note becomes the
                  record of what actually happened — and is required. Shown
                  here rather than as a permanent field so the form stays
                  short for the 99% of payments that are cash or card. */}
              {method === 'other' ? (
                <div className="space-y-1.5 pt-1.5">
                  <label htmlFor="notes" className="block text-xs font-medium text-gray-400">
                    Notes (required)
                  </label>
                  <textarea
                    id="notes"
                    name="notes"
                    rows={2}
                    required
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Describe the payment method…"
                    className={inputBase + (errors.notes ? inputBad : inputOk)}
                  />
                  {errors.notes ? (
                    <p role="alert" className="text-xs text-red-400">{errors.notes}</p>
                  ) : null}
                </div>
              ) : null}
            </div>

            {/* The date the money was taken, which is not always the day it
                is entered. Defaults to today and cannot be set forward. There
                is still no agent field: a payment is attributed to whoever is
                signed in and that is not restatable at the till. */}
            <div className={'space-y-1.5' + (postpaid ? ' sm:col-span-2' : '')}>
              <label htmlFor="paid_on" className="block text-xs font-medium text-gray-400">
                Date
              </label>
              <input
                id="paid_on"
                name="paid_on"
                type="date"
                value={paidOn}
                max={todayYmd || undefined}
                onChange={(e) => setPaidOn(e.target.value)}
                className={inputBase + (errors.paid_on ? inputBad : inputOk) + ' [color-scheme:dark]'}
              />
              {errors.paid_on ? (
                <p role="alert" className="text-xs text-red-400">{errors.paid_on}</p>
              ) : null}
            </div>

            {/* The amount is the figure the cashier and the customer both
                check, so it is deliberately the loudest control on the form. */}
            <div className="space-y-1.5 sm:col-span-2">
              <label
                htmlFor="amount"
                className="block text-xs font-semibold uppercase tracking-wider text-gray-400"
              >
                Amount
              </label>
              <div className="relative">
                <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-xl font-semibold text-gray-500">
                  {symbol}
                </span>
                <input
                  id="amount"
                  name="amount"
                  type="number"
                  min="1"
                  step="1"
                  required
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  aria-describedby={partial ? 'partial-payment' : undefined}
                  className={
                    'w-full rounded-xl border-2 bg-gray-950 py-3 pl-14 pr-4 text-2xl font-bold tabular-nums text-white outline-none transition focus:ring-4 ' +
                    (errors.amount
                      ? 'border-red-700 focus:border-red-500 focus:ring-red-500/20'
                      : 'border-gray-700 focus:border-blue-500 focus:ring-blue-500/20')
                  }
                />
              </div>
              {errors.amount ? (
                <p role="alert" className="text-xs text-red-400">{errors.amount}</p>
              ) : null}
            </div>
          </div>

          {/* ---------------- Partial payment ----------------
              No button opens this. Anything short of the amount due is a
              partial payment whether or not the cashier says so, and the
              decision about access has to be made before the money is taken —
              so the prompt appears on its own as soon as typing stops. */}
          {partial ? (
            <div
              id="partial-payment"
              className="mt-4 rounded-lg border border-amber-800/60 bg-amber-950/30 p-4"
            >
              <input type="hidden" name="access_decision" value={accessChoice} />
              {dateChosen ? (
                <input type="hidden" name="access_date" value={accessDate} />
              ) : null}

              <p className="flex items-center gap-2 text-sm font-semibold text-amber-300">
                <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden />
                Partial payment
              </p>
              <p className="mt-0.5 text-xs text-amber-300/80">
                {money(paid)} of {money(due)} due
              </p>

              <fieldset className="mt-3">
                <legend className="text-xs font-medium text-gray-300">
                  How would you like to handle access?
                </legend>

                <div className="mt-2 space-y-2">
                  <AccessOption
                    id="access-full"
                    value="full_period"
                    checked={accessChoice === 'full_period'}
                    onSelect={() => setAccessChoice('full_period')}
                    title="Full Period"
                  >
                    <p className="text-xs text-gray-400">
                      Expiry:{' '}
                      <span className="font-medium text-gray-200">
                        {fullPeriodExpiry ? fmtDate(fullPeriodExpiry) : '—'}
                      </span>
                    </p>
                    <p className="text-xs text-gray-400">
                      Outstanding:{' '}
                      <span className="font-medium text-orange-400">{money(outstanding)}</span>
                    </p>
                  </AccessOption>

                  <AccessOption
                    id="access-date"
                    value="date_selected"
                    checked={accessChoice === 'date_selected'}
                    onSelect={() => setAccessChoice('date_selected')}
                    title="Select Date"
                  >
                    <input
                      type="date"
                      aria-label="Access granted until"
                      value={accessDate}
                      onChange={(e) => {
                        setPickedDate(e.target.value)
                        setDateTouched(true)
                        setAccessChoice('date_selected')
                      }}
                      // Deliberately unbounded: the cashier may need to honour
                      // an arrangement the arithmetic does not know about. The
                      // amber note below flags an over-generous date rather
                      // than preventing it.
                      className={inputBase + inputOk + ' [color-scheme:dark]'}
                    />
                    <p className="text-xs text-gray-400">
                      Suggested:{' '}
                      <span className="font-medium text-gray-200">
                        {proportional ? fmtDate(proportional) : '—'}
                      </span>
                    </p>
                    <p className="text-xs text-gray-400">
                      Outstanding:{' '}
                      <span className="font-medium text-orange-400">{money(outstanding)}</span>
                    </p>
                  </AccessOption>
                </div>
              </fieldset>
            </div>
          ) : null}

          {/* ---------------- New expiry preview ---------------- */}
          {newExpiry ? (
            <div className="mt-4 rounded-lg border border-green-900/50 bg-green-950/20 px-3 py-2.5">
              <p className="text-sm font-semibold text-green-400">
                {dateChosen ? 'Access granted until: ' : 'New expiry will be: '}
                {fmtDate(newExpiry)}
              </p>

              {partial ? (
                <p className="mt-0.5 text-xs text-gray-400">
                  Outstanding balance: {money(outstanding)}
                  {accessChoice === 'full_period' ? ' carried to next bill' : ''}
                </p>
              ) : postpaid ? (
                <p className="mt-0.5 text-xs text-gray-400">
                  Bill period: {billingPeriodLabel(today)}
                </p>
              ) : (
                <p className="mt-0.5 text-xs text-gray-400">
                  {toExpiryMode(selected.expiry_mode) === 'from_expiry'
                    ? 'From Cut Off Date'
                    : 'From Payment Date'}
                </p>
              )}

              {/* Not an error — the cashier may have good reason — but it is
                  access the payment did not cover, so it is never silent. */}
              {beyondProportional ? (
                <p className="mt-2 flex gap-1.5 text-xs text-amber-400">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span>Date exceeds proportional period</span>
                </p>
              ) : null}
            </div>
          ) : null}

          </>
          )}

          <div className="mt-4">
            <SubmitButton />
          </div>
        </section>
      ) : null}
    </form>
  )
}

function fmtNum(n: number) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n)
}

/**
 * One of the two payment-type radios.
 *
 * The whole tile is the label, unlike AccessOption below: there is no control
 * nested inside it to steal focus, so making the entire card clickable is
 * safe and gives the cashier a target they can hit without looking.
 */
function KindOption({
  id, checked, onSelect, title, hint,
}: {
  id: string
  checked: boolean
  onSelect: () => void
  title: string
  hint: string
}) {
  return (
    <label
      htmlFor={id}
      className={
        'flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 transition ' +
        (checked
          ? 'border-blue-600 bg-blue-950/30'
          : 'border-gray-700 bg-gray-900/40 hover:border-gray-600')
      }
    >
      <input
        id={id}
        type="radio"
        name="payment_kind_choice"
        checked={checked}
        onChange={onSelect}
        className="mt-0.5 h-4 w-4 shrink-0 accent-blue-600"
      />
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-white">{title}</span>
        <span className="block text-xs text-gray-400">{hint}</span>
      </span>
    </label>
  )
}

/**
 * One radio in the partial-payment prompt.
 *
 * The label covers the heading row only, not the detail beneath it. The "Select
 * Date" option holds a date picker, and a label bound to the radio would hand
 * focus back to the radio the moment the cashier clicked into the picker.
 * Selecting the option is still a click anywhere on its title row.
 */
function AccessOption({
  id, value, checked, onSelect, title, children,
}: {
  id: string
  value: AccessDecision
  checked: boolean
  onSelect: () => void
  title: string
  children: React.ReactNode
}) {
  return (
    <div
      className={
        'rounded-lg border px-3 py-2.5 transition ' +
        (checked
          ? 'border-blue-600 bg-blue-950/30'
          : 'border-gray-700 bg-gray-900/40 hover:border-gray-600')
      }
    >
      <label htmlFor={id} className="flex cursor-pointer items-center gap-2">
        <input
          id={id}
          type="radio"
          name="access_choice"
          value={value}
          checked={checked}
          onChange={onSelect}
          className="h-4 w-4 shrink-0 accent-blue-600"
        />
        <span className="text-sm font-semibold text-white">{title}</span>
      </label>
      <div className="mt-1.5 space-y-1 pl-6">{children}</div>
    </div>
  )
}

function Line({
  label, value, strong, emphasis, muted, tone,
}: {
  label: string
  value: string
  strong?: boolean
  /** The headline figure on the card — larger and bolder than the rest. */
  emphasis?: boolean
  muted?: boolean
  tone?: string
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt
        className={
          'min-w-0 truncate ' +
          (emphasis ? 'font-semibold text-gray-200'
            : muted ? 'text-gray-400' : 'text-gray-300')
        }
      >
        {label}
      </dt>
      <dd
        className={
          'shrink-0 tabular-nums ' +
          (tone ?? (emphasis ? 'text-lg font-bold text-white'
            : strong ? 'font-semibold text-white'
              : muted ? 'text-gray-400' : 'text-gray-200'))
        }
      >
        {value}
      </dd>
    </div>
  )
}
