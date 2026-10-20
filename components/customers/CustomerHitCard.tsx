import type { SearchHit } from '@/lib/data/customer-search'
import { STATUS_DOT } from '@/lib/status'

const DOTS: Record<string, string> = STATUS_DOT

/**
 * One customer search result, drawn the same everywhere a customer is found:
 * the header search, the role dashboards and the New Ticket picker. Status dot,
 * name, phone and address, MAC — what tells two Ena Browns apart.
 *
 * Only the inside of the row. The caller wraps it in whatever the click does —
 * open the record, or pick the customer for a ticket — so this stays
 * markup-only and can sit inside a button or a link alike.
 */
export function CustomerHitCard({
  hit,
  aside,
}: {
  hit: Pick<SearchHit, 'status' | 'first_name' | 'last_name' | 'phone' | 'address' | 'mac_address'>
  /** Shown after the MAC, e.g. the balance on a cashier's dashboard. */
  aside?: React.ReactNode
}) {
  return (
    <>
      <span className={'h-2 w-2 shrink-0 rounded-full ' + DOTS[hit.status]} aria-label={hit.status} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-white">
          {[hit.first_name, hit.last_name].filter(Boolean).join(' ') || 'Unnamed'}
        </span>
        {/* Address sits beside the phone because the search matches on it: a
            hit that came back for a district name has to show the district, or
            it reads as a result from nowhere. */}
        <span className="block truncate text-xs text-gray-400">
          {[hit.phone, hit.address].filter(Boolean).join(' · ') || 'No phone or address'}
        </span>
        {/* On a phone the MAC moves under the name instead of taking a fixed
            column beside it, which would leave the name a few letters wide. */}
        <span className="block truncate font-mono text-xs text-gray-400 sm:hidden">
          {hit.mac_address ?? 'No MAC'}
        </span>
      </span>
      <span className="hidden shrink-0 font-mono text-xs text-gray-400 sm:inline">{hit.mac_address ?? '—'}</span>
      {aside}
    </>
  )
}
