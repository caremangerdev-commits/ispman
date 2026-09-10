'use client'

import { CalendarClock, Coins, Gauge, Tags, X } from 'lucide-react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTransition } from 'react'

/**
 * The four filters that are not the status tabs, the address dropdown or the
 * search box: misc category, service plan, expiry window and balance owing.
 *
 * State lives in searchParams, exactly as AddressFilter and CustomerSearch do,
 * so a filtered view is linkable and survives a refresh — and so the messaging
 * page can be handed the same URL and select the same people. The parameter
 * names are owned by lib/customer-filter.ts; this component only sets them.
 *
 * Every control composes with the others. Choosing a plan does not clear the
 * search, the tab or the place.
 */

const EXPIRY_WINDOWS = [
  { value: '0', label: 'Already expired' },
  { value: '3', label: 'Within 3 days' },
  { value: '7', label: 'Within 7 days' },
  { value: '14', label: 'Within 14 days' },
  { value: '30', label: 'Within 30 days' },
]

export type FilterOption = { id: number; name: string }

export function CustomerFilterBar({
  miscCategories,
  servicePlans,
  selected,
  currencySymbol,
}: {
  miscCategories: FilterOption[]
  servicePlans: FilterOption[]
  selected: {
    category: string
    plan: string
    expiring: string
    owing: string
  }
  currencySymbol: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [, startTransition] = useTransition()

  function set(key: string, value: string) {
    const next = new URLSearchParams(params.toString())
    if (value) next.set(key, value)
    else next.delete(key)
    // Any change to who is being listed invalidates the page number: page 4 of
    // one filter is not page 4 of another.
    next.delete('page')
    const qs = next.toString()
    startTransition(() => router.replace(pathname + (qs ? '?' + qs : '')))
  }

  function clearAll() {
    const next = new URLSearchParams(params.toString())
    for (const k of ['category', 'plan', 'expiring', 'owing']) next.delete(k)
    next.delete('page')
    const qs = next.toString()
    startTransition(() => router.replace(pathname + (qs ? '?' + qs : '')))
  }

  const active =
    Boolean(selected.category || selected.plan || selected.expiring || selected.owing)

  const pill = (on: boolean) =>
    'appearance-none rounded-lg border py-1.5 pl-8 pr-3 text-xs font-medium outline-none transition ' +
    'focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 ' +
    (on
      ? 'border-blue-600 bg-blue-600 text-white'
      : 'border-gray-800 bg-gray-900 text-gray-400 hover:bg-gray-800 hover:text-gray-200')

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* Rendered only when the catalogue has something to choose between —
          an empty dropdown suggests options are being hidden. */}
      {miscCategories.length > 0 ? (
        <div className="relative">
          <Tags
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500"
            aria-hidden
          />
          <label htmlFor="filter-category" className="sr-only">Filter by category</label>
          <select
            id="filter-category"
            value={selected.category}
            onChange={(e) => set('category', e.target.value)}
            className={'max-w-[11rem] truncate ' + pill(Boolean(selected.category))}
          >
            <option value="">All categories</option>
            {miscCategories.map((c) => (
              <option key={c.id} value={String(c.id)}>{c.name}</option>
            ))}
          </select>
        </div>
      ) : null}

      {servicePlans.length > 0 ? (
        <div className="relative">
          <Gauge
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500"
            aria-hidden
          />
          <label htmlFor="filter-plan" className="sr-only">Filter by service plan</label>
          <select
            id="filter-plan"
            value={selected.plan}
            onChange={(e) => set('plan', e.target.value)}
            className={'max-w-[11rem] truncate ' + pill(Boolean(selected.plan))}
          >
            <option value="">All plans</option>
            {servicePlans.map((p) => (
              <option key={p.id} value={String(p.id)}>{p.name}</option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="relative">
        <CalendarClock
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500"
          aria-hidden
        />
        <label htmlFor="filter-expiring" className="sr-only">Filter by expiry</label>
        <select
          id="filter-expiring"
          value={selected.expiring}
          onChange={(e) => set('expiring', e.target.value)}
          className={pill(Boolean(selected.expiring))}
        >
          <option value="">Any expiry</option>
          {EXPIRY_WINDOWS.map((w) => (
            <option key={w.value} value={w.value}>{w.label}</option>
          ))}
        </select>
      </div>

      {/* A number box rather than bands. "Owing more than 5,000" is a figure an
          owner already has in mind, and bands would only ever be someone else's
          guess at where the line falls. Committed on blur and on Enter so a
          half-typed "5" does not re-filter the page on every keystroke. */}
      <div className="relative">
        <Coins
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500"
          aria-hidden
        />
        <label htmlFor="filter-owing" className="sr-only">
          Filter by amount owing, in {currencySymbol}
        </label>
        <input
          id="filter-owing"
          type="number"
          min={0}
          step={100}
          inputMode="numeric"
          placeholder={'Owing ' + currencySymbol + '+'}
          defaultValue={selected.owing}
          onBlur={(e) => set('owing', e.target.value.trim())}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              set('owing', (e.target as HTMLInputElement).value.trim())
            }
          }}
          className={'w-[8.5rem] ' + pill(Boolean(selected.owing))}
        />
      </div>

      {active ? (
        <button
          type="button"
          onClick={clearAll}
          className="inline-flex items-center gap-1 rounded-lg border border-gray-800 bg-gray-900 px-2.5 py-1.5 text-xs font-medium text-gray-400 transition hover:bg-gray-800 hover:text-gray-200"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
          Clear
        </button>
      ) : null}
    </div>
  )
}
