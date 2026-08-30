'use client'

import { Search, X } from 'lucide-react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useState, useTransition } from 'react'

/**
 * Search box that keeps the query in the URL.
 *
 * State lives in searchParams rather than component state so the result set is
 * linkable and survives a refresh; the debounce keeps that from firing a
 * navigation on every keystroke.
 */
export function CustomerSearch({ initial }: { initial: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [value, setValue] = useState(initial)
  const [, startTransition] = useTransition()

  // Re-sync when the URL changes from outside (filter tabs, back button).
  // Adjusted during render rather than in an effect to avoid a cascading render.
  const [seenInitial, setSeenInitial] = useState(initial)
  if (initial !== seenInitial) {
    setSeenInitial(initial)
    setValue(initial)
  }

  useEffect(() => {
    if (value === initial) return

    const timer = setTimeout(() => {
      const next = new URLSearchParams(params.toString())
      if (value) next.set('q', value)
      else next.delete('q')
      next.delete('page') // a new query invalidates the current page number
      startTransition(() => router.replace(pathname + '?' + next.toString()))
    }, 300)

    return () => clearTimeout(timer)
  }, [value, initial, params, pathname, router])

  return (
    <div className="relative w-full max-w-sm">
      <Search
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500"
        aria-hidden
      />
      <label htmlFor="customer-search" className="sr-only">
        Search customers
      </label>
      <input
        id="customer-search"
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search name, phone or MAC..."
        className="w-full rounded-lg border border-gray-800 bg-gray-950 py-2 pl-9 pr-8 text-sm text-gray-200 placeholder:text-gray-600 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30"
      />
      {value ? (
        <button
          type="button"
          onClick={() => setValue('')}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-500 transition hover:text-gray-300"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  )
}
