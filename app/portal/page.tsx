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
  // cookie in a render (only actions may); just fall back to the sign-in, which
  // issues a fresh session.
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

function daysLabel(days: number | null): string {
  if (days === null) return ''
  if (days < 0) {
    const n = Math.abs(days)
    return 'Expired ' + n + (n === 1 ? ' day' : ' days') + ' ago'
  }
  if (days === 0) return 'Expires today'
  return days + (days === 1 ? ' day left' : ' days left')
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
  const owes = account.balance > 0.005
  const creditHeld = Math.max(account.credit, account.balance < 0 ? -account.balance : 0)
  const firstName = account.name.split(' ')[0] || 'there'
  const expired = account.daysUntilExpiry !== null && account.daysUntilExpiry < 0

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-start justify-between">
        <div>
          <p className="text-sm text-black/50">{company}</p>
          <h1 className="text-xl font-semibold">Hi, {firstName}</h1>
        </div>
        <form action={logout}>
          <button type="submit" className="py-1 text-sm text-black/50 underline">
            Log out
          </button>
        </form>
      </header>

      <section className="rounded-2xl border border-black/10 p-5">
        <p className="text-sm text-black/50">Service active until</p>
        {account.expiry ? (
          <>
            <p className="mt-1 text-2xl font-semibold">{formatDay(account.expiry)}</p>
            <p className={'mt-1 text-base ' + (expired ? 'text-red-600' : 'text-black/60')}>
              {daysLabel(account.daysUntilExpiry)}
            </p>
          </>
        ) : (
          <p className="mt-1 text-base text-black/60">Not available right now</p>
        )}
      </section>

      <section className="rounded-2xl border border-black/10 p-5">
        <p className="text-sm text-black/50">{owes ? 'You owe' : 'Balance'}</p>
        <p className="mt-1 text-3xl font-semibold tabular-nums">
          {owes ? formatCurrency(account.balance) : "You're paid up"}
        </p>
        {!owes && creditHeld > 0.005 ? (
          <p className="mt-1 text-base text-black/60">{formatCurrency(creditHeld)} in credit</p>
        ) : null}

        {canPay ? (
          <form action={startCheckout} className="mt-5 flex flex-col gap-3">
            <label htmlFor="amount" className="text-sm text-black/50">
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
              className="w-full rounded-xl border border-black/15 px-4 py-4 text-xl tabular-nums outline-none focus:border-black/40"
            />
            {error ? <p className="text-base text-red-600">{error}</p> : null}
            <button
              type="submit"
              className="w-full rounded-xl bg-black px-4 py-4 text-lg font-semibold text-white"
            >
              Pay now
            </button>
          </form>
        ) : (
          <p className="mt-4 text-sm text-black/50">
            Online payment isn’t set up yet. Pay {company} directly for now.
          </p>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium text-black/50">Recent payments</h2>
        {payments.length === 0 ? (
          <p className="text-base text-black/50">No payments yet.</p>
        ) : (
          <ul className="divide-y divide-black/10">
            {payments.slice(0, 20).map((p) => (
              <li key={p.id} className="flex items-center justify-between py-3">
                <span className="text-base">{formatDay(p.payment_date)}</span>
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
