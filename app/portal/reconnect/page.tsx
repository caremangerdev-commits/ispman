import { notFound } from 'next/navigation'

import { reconnectCheckout } from '@/app/actions/portal'
import { getEnabledGateway } from '@/lib/data/payment-gateways'
import { findCustomerIdByMac, getPortalAccount } from '@/lib/data/portal'
import { formatCurrency } from '@/lib/format'
import { getPortalCompany } from '@/lib/portal/context'

/**
 * The reconnection page a cut-off customer reaches WITHOUT signing in — the
 * MikroTik walled garden redirects their restricted traffic here with their MAC
 * (?mac=...). We resolve the account from the MAC and let them pay; the gateway
 * webhook records it and reconnects them. No login, because a suspended customer
 * often cannot reach the full portal.
 */
export const dynamic = 'force-dynamic'

export default async function ReconnectPage(props: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const company = await getPortalCompany()
  if (!company) notFound()

  const sp = await props.searchParams
  const mac = typeof sp.mac === 'string' ? sp.mac : ''
  const error = typeof sp.e === 'string' ? sp.e : null

  const customerId = mac ? await findCustomerIdByMac(company.id, mac) : null
  const [account, gateway] = await Promise.all([
    customerId ? getPortalAccount(company.id, customerId) : Promise.resolve(null),
    getEnabledGateway(company.id),
  ])

  const owes = account ? account.balance > 0.005 : false

  return (
    <div className="flex flex-col gap-5">
      <header>
        <p className="text-sm text-neutral-500">{company.name}</p>
        <h1 className="text-2xl font-semibold">Reconnect your service</h1>
      </header>

      {!account ? (
        <section className="rounded-2xl border border-neutral-200 p-5">
          <p className="text-base text-neutral-700">
            Your internet is restricted. We couldn’t identify your account from this device
            automatically.
          </p>
          <p className="mt-2 text-sm text-neutral-500">
            Please contact {company.name} to pay and reconnect.
          </p>
        </section>
      ) : (
        <>
          <section className="rounded-2xl bg-amber-50 p-5">
            <p className="text-sm text-neutral-600">Account</p>
            <p className="text-lg font-semibold">{account.name}</p>
            {account.accountNumber ? (
              <p className="font-mono text-base">{account.accountNumber}</p>
            ) : null}
            <p className="mt-3 text-sm text-neutral-600">{owes ? 'Amount owing' : 'Balance'}</p>
            <p className="text-3xl font-semibold tabular-nums">
              {owes ? formatCurrency(account.balance) : "You're paid up"}
            </p>
          </section>

          {gateway ? (
            <form action={reconnectCheckout} className="flex flex-col gap-3 rounded-2xl border border-neutral-200 p-5">
              <input type="hidden" name="mac" value={mac} />
              <label htmlFor="amount" className="text-sm text-neutral-500">Amount to pay (J$)</label>
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
              <button type="submit" className="w-full rounded-xl bg-neutral-900 px-4 py-4 text-lg font-semibold text-white active:bg-neutral-700">
                Pay &amp; reconnect
              </button>
              <p className="text-xs text-neutral-400">You’ll come back online within moments of paying.</p>
            </form>
          ) : (
            <section className="rounded-2xl border border-neutral-200 p-5">
              <p className="text-base text-neutral-700">Please contact {company.name} to pay and reconnect.</p>
            </section>
          )}
        </>
      )}
    </div>
  )
}
