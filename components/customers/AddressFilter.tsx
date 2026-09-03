'use client'

import { MapPin } from 'lucide-react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTransition } from 'react'

/**
 * Narrows the customer list to one address.
 *
 * For imported customers `address` holds the location name — ENDEAVOUR, MT
 * ZION, BROWN'S TOWN — so this is in practice a "which community" filter, which
 * is how a field technician thinks about a route.
 *
 * State lives in searchParams, exactly as CustomerSearch and the status tabs
 * do, so a filtered view is linkable and survives a refresh. This sits beside
 * the status tabs and composes with them: picking a place does not clear the
 * search box or the active tab.
 */
export function AddressFilter({
  addresses,
  selected,
}: {
  addresses: string[]
  selected: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [, startTransition] = useTransition()

  // Nothing to choose between. Rendering an empty dropdown would suggest the
  // company has addresses that are being hidden.
  if (addresses.length === 0) return null

  function choose(value: string) {
    const next = new URLSearchParams(params.toString())
    if (value) next.set('address', value)
    else next.delete('address')
    // A different address invalidates the current page number — page 4 of
    // ENDEAVOUR is rarely page 4 of MT ZION.
    next.delete('page')
    const qs = next.toString()
    startTransition(() => router.replace(pathname + (qs ? '?' + qs : '')))
  }

  return (
    <div className="relative">
      <MapPin
        className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500"
        aria-hidden
      />
      <label htmlFor="customer-address" className="sr-only">
        Filter by address
      </label>
      <select
        id="customer-address"
        value={selected}
        onChange={(e) => choose(e.target.value)}
        className={
          'max-w-[13rem] appearance-none truncate rounded-lg border py-1.5 pl-8 pr-3 text-xs font-medium outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 ' +
          (selected
            ? 'border-blue-600 bg-blue-600 text-white'
            : 'border-gray-800 bg-gray-900 text-gray-400 hover:bg-gray-800 hover:text-gray-200')
        }
      >
        <option value="">All addresses</option>
        {/* A URL can name an address nobody has any more — a hand-edited link,
            or the last customer there was moved. Without an option to match it
            the control would read "All addresses" while the list stayed
            filtered to nothing. */}
        {selected && !addresses.includes(selected) ? (
          <option value={selected}>{selected} (no customers)</option>
        ) : null}
        {addresses.map((a) => (
          <option key={a} value={a}>{a}</option>
        ))}
      </select>
    </div>
  )
}
