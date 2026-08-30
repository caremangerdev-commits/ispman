import { EmptyState, Panel } from '@/components/dashboard/Panel'
import { fullName, truncateMac } from '@/lib/format'
import { StatusBadge } from '@/components/customers/StatusBadge'
import type { CustomerWithExpiry } from '@/lib/types'

export function ExpiringCustomers({ customers }: { customers: CustomerWithExpiry[] }) {
  return (
    <Panel
      title="Needs Attention"
      subtitle="Not currently online"
      href="/dashboard/customers?filter=expired"
      linkLabel="View All"
    >
      {customers.length === 0 ? (
        <EmptyState message="No customers need attention right now." />
      ) : (
        <ul className="divide-y divide-gray-800">
          {customers.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-5 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-gray-200">{fullName(c)}</p>
                <p className="truncate font-mono text-xs text-gray-500">
                  {truncateMac(c.mac_address)}
                </p>
              </div>

              <StatusBadge status={c.radiusStatus ?? 'unknown'} />

              <div className="flex shrink-0 gap-1.5">
                <button
                  type="button"
                  className="rounded-md bg-green-500/10 px-2 py-1 text-[11px] font-semibold text-green-400 transition hover:bg-green-500/20"
                >
                  Extend
                </button>
                <button
                  type="button"
                  className="rounded-md bg-red-500/10 px-2 py-1 text-[11px] font-semibold text-red-400 transition hover:bg-red-500/20"
                >
                  Disconnect
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}
