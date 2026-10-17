import { notFound } from 'next/navigation'

import { logout, startCheckout } from '@/app/actions/portal'
import { LoginForm } from '@/components/portal/LoginForm'
import { getCustomerPayments, type CustomerPayment } from '@/lib/data/customers'
import { getEnabledGateway } from '@/lib/data/payment-gateways'
import { getPortalAccount, type PortalAccount } from '@/lib/data/portal'
import { formatCurrency } from '@/lib/format'
import { getPortalCompany } from '@/lib/portal/context'
import { getPortalSession } from '@/lib/portal/session'

/** Reads cookies and the subdomain header, so it is always per-request. */
export const dynamic = 'force-dynamic'

export default async function PortalHome(props: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const company = await getPortalCompany()
  if (!company) notFound()

  const session = await getPortalSession(company.id)
  if (!session) return <LoginForm companyName={company.name} />

  const account = await getPortalAccount(company.id, session.customerId)
  // The session points at an account that is no longer here. Don't clear the
  // cookie in a render (only actions may); just fall back to the sign-in.
  if (!account) return <LoginForm companyName={company.name} />

  const [payments, gateway, sp] = await Promise.all([
    getCustomerPayments(company.id, session.customerId),
    getEnabledGateway(company.id),
    props.searchParams,
  ])
  const error = typeof sp.e === 'string' ? sp.e : null

  return (
    <AccountView
      company={company.name}
      account={account}
      payments={payments}
      canPay={gateway !== null}
      error={error}
    />
  )
}

/** A fixed date string, "8 Nov 2026". No clock read — pure for a render. */
function formatDay(value: string): string {
  const d = new Date(value.length <= 10 ? value + 'T00:00:00' : value)
  if (!Number.isFinite(d.getTime())) return value
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(d)
}

function AccountView({
  company,
  account,
  payments,
  canPay,
  error,
}: {
  company: string
  account: PortalAccount
  payments: CustomerPayment[]
  canPay: boolean
  error: string | null
}) {
  const days = account.daysUntilExpiry
  const expired = days !== null && days < 0
  const soon = days !== null && days >= 0 && days <= 3
  const owes = account.balance > 0.005
  const creditHeld = Math.max(account.credit, account.balance < 0 ? -account.balance : 0)
  const firstName = account.name.split(' ')[0] || 'there'

  const heroTone = expired ? 'bg-red-50' : soon ? 'bg-amber-50' : 'bg-neutral-100'

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm text-neutral-500">{company}</p>
          <h1 className="truncate text-lg font-semibold">Hi, {firstName}</h1>
        </div>
        <form action={logout}>
          <button
            type="submit"
            className="shrink-0 rounded-lg px-3 py-2 text-sm text-neutral-500 active:bg-neutral-100"
          >
            Log out
          </button>
        </form>
      </header>

      {/* Time first: the prepaid question is "how long do I have left?" */}
      <section className={'rounded-2xl p-6 text-center ' + heroTone}>
        {days === null ? (
          <p className="text-xl font-semibold">Service status unavailable</p>
        ) : expired ? (
          <>
            <p className="text-5xl font-bold text-red-600">Expired</p>
            {Math.abs(days) >= 1 ? (
              <p className="mt-2 text-base text-red-700">
                {Math.abs(days)} {Math.abs(days) === 1 ? 'day' : 'days'} ago
              </p>
            ) : null}
          </>
        ) : (
          <>
            <p className="text-6xl font-bold tabular-nums leading-none">{days}</p>
            <p className="mt-2 text-lg font-medium">
              {days === 0 ? 'last day' : days === 1 ? 'day left' : 'days left'}
            </p>
          </>
        )}

        {account.expiry ? (
          <p className="mt-3 text-sm text-neutral-600">
            {expired ? 'Your internet went off on ' : 'Active until '}
            <span className="font-medium">{formatDay(account.expiry)}</span>.
          </p>
        ) : null}
        {days !== null ? (
          <p className="mt-1 text-sm text-neutral-500">
            {expired ? 'Pay below to come back online.' : 'When this runs out, your internet stops until you pay.'}
          </p>
        ) : null}
      </section>

      {/* The number to read out at a counter, and how this company takes payment. */}
      {account.accountNumber ? (
        <section className="rounded-2xl border border-neutral-200 p-5">
          <p className="text-sm text-neutral-500">Account number</p>
          <p className="mt-1 select-all break-all font-mono text-2xl font-semibold tracking-wide">
            {account.accountNumber}
          </p>
          <p className="mt-1 text-sm text-neutral-500">Quote this whenever you pay.</p>
          {account.paymentNote ? (
            <p className="mt-3 whitespace-pre-line border-t border-neutral-100 pt-3 text-sm text-neutral-700">
              {account.paymentNote}
            </p>
          ) : null}
        </section>
      ) : account.paymentNote ? (
        <section className="rounded-2xl border border-neutral-200 p-5">
          <p className="whitespace-pre-line text-sm text-neutral-700">{account.paymentNote}</p>
        </section>
      ) : null}

      <section className="rounded-2xl border border-neutral-200 p-5">
        <p className="text-sm text-neutral-500">{owes ? 'You owe' : 'Balance'}</p>
        <p className="mt-1 text-3xl font-semibold tabular-nums">
          {owes ? formatCurrency(account.balance) : "You're paid up"}
        </p>
        {!owes && creditHeld > 0.005 ? (
          <p className="mt-1 text-sm text-neutral-500">{formatCurrency(creditHeld)} in credit</p>
        ) : null}

        {canPay ? (
          <form action={startCheckout} className="mt-5 flex flex-col gap-3">
            <label htmlFor="amount" className="text-sm text-neutral-500">
              Amount to pay (J$)
            </label>
            <input
              id="amount"
              name="amount"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              defaultValue={owes ? account.balance.toFixed(2) : ''}
              placeholder="0.00"
              className="w-full rounded-xl border border-neutral-300 px-4 py-4 text-xl tabular-nums outline-none focus:border-neutral-900"
            />
            {error ? <p className="text-base text-red-600">{error}</p> : null}
            <button
              type="submit"
              className="w-full rounded-xl bg-neutral-900 px-4 py-4 text-lg font-semibold text-white active:bg-neutral-700"
            >
              Pay now
            </button>
          </form>
        ) : (
          <p className="mt-4 text-sm text-neutral-500">
            Online payment isn’t set up yet.{' '}
            {account.paymentNote ? 'See above for how to pay.' : 'Pay ' + company + ' directly.'}
          </p>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium text-neutral-500">Recent payments</h2>
        {payments.length === 0 ? (
          <p className="text-base text-neutral-500">No payments yet.</p>
        ) : (
          <ul className="divide-y divide-neutral-100 rounded-2xl border border-neutral-200">
            {payments.slice(0, 20).map((p) => (
              <li key={p.id} className="flex items-center justify-between px-4 py-3">
                <span className="text-base text-neutral-700">{formatDay(p.payment_date)}</span>
                <span className="text-base font-medium tabular-nums">
                  {formatCurrency(Number(p.amount))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
