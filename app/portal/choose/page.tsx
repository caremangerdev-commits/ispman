import { notFound, redirect } from 'next/navigation'

import { pickCustomer } from '@/app/actions/portal'
import { matchCustomersByPhone } from '@/lib/data/portal'
import { getPortalCompany } from '@/lib/portal/context'
import { getPendingPick } from '@/lib/portal/session'

/** Reads the pending-pick cookie and the subdomain header; per-request. */
export const dynamic = 'force-dynamic'

/**
 * The picker shown when a verified number maps to more than one account. Reached
 * only with a pending-pick cookie (set after the code is verified), so the
 * accounts listed are genuinely on that verified number.
 */
export default async function ChoosePage() {
  const company = await getPortalCompany()
  if (!company) notFound()

  const pending = await getPendingPick(company.id)
  if (!pending) redirect('/')

  const matches = await matchCustomersByPhone(company.id, pending.phone)
  if (matches.length === 0) redirect('/')

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold">Which account?</h1>
        <p className="mt-1 text-base text-black/60">
          This number is on more than one account. Choose yours.
        </p>
      </div>
      <ul className="flex flex-col gap-3">
        {matches.map((m) => (
          <li key={m.id}>
            <form action={pickCustomer}>
              <input type="hidden" name="customer_id" value={m.id} />
              <button
                type="submit"
                className="w-full rounded-xl border border-black/15 px-4 py-4 text-left text-lg font-medium active:bg-black/5"
              >
                {m.name}
              </button>
            </form>
          </li>
        ))}
      </ul>
    </div>
  )
}
