import { EmptyState, Panel } from '@/components/dashboard/Panel'
import { formatCurrency, formatRelativeDate, fullName } from '@/lib/format'
import type { PaymentRow } from '@/lib/types'

const TYPE_STYLES: Record<string, string> = {
  cash: 'bg-emerald-500/10 text-emerald-400',
  card: 'bg-blue-500/10 text-blue-400',
  online: 'bg-violet-500/10 text-violet-400',
}

export function RecentPayments({ payments }: { payments: PaymentRow[] }) {
  return (
    <Panel
      title="Recent Payments"
      subtitle={'Last ' + payments.length}
      href="/dashboard/payments"
      linkLabel="View All Payments"
    >
      {payments.length === 0 ? (
        <EmptyState message="No payments recorded yet." />
      ) : (
        <ul className="divide-y divide-gray-800">
          {payments.map((p) => (
            <li key={p.id} className="flex items-center gap-3 px-5 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-gray-200">
                  {fullName(p.customers)}
                </p>
                <p className="truncate text-xs text-gray-500">
                  {formatRelativeDate(p.payment_date)}
                  {p.agent ? ' · ' + p.agent : ''}
                </p>
              </div>

              <span
                className={
                  'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ' +
                  (TYPE_STYLES[p.payment_type ?? ''] ?? 'bg-gray-700/40 text-gray-400')
                }
              >
                {p.payment_type ?? 'other'}
              </span>

              <span className="shrink-0 text-sm font-semibold tabular-nums text-white">
                {formatCurrency(p.amount)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}
