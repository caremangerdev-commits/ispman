import { STATUS_BADGE, STATUS_LABELS, type CustomerStatus } from '@/lib/status'

/**
 * Customer status, as derived from the network registry.
 *
 * There is no billing-status variant any more — whether a customer can get
 * online is the only status the app shows, so this renders exactly what
 * lib/status.ts defines and nothing else.
 */
export function StatusBadge({
  status,
  size = 'sm',
}: {
  status: CustomerStatus
  size?: 'sm' | 'md'
}) {
  return (
    <span
      className={
        'inline-block whitespace-nowrap rounded font-semibold uppercase tracking-wide ' +
        STATUS_BADGE[status] +
        (size === 'md' ? ' px-2.5 py-1 text-xs' : ' px-1.5 py-0.5 text-[10px]')
      }
    >
      {STATUS_LABELS[status]}
    </span>
  )
}

/** Days-remaining hint shown next to the expiry date. */
export function ExpiryHint({ days }: { days: number | null }) {
  if (days === null) return <span className="text-gray-600">—</span>
  if (days < 0) return <span className="text-red-400">{Math.abs(days)}d overdue</span>
  if (days === 0) return <span className="text-orange-400">today</span>
  return <span className="text-gray-500">{days}d left</span>
}
