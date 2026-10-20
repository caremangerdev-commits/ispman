'use client'

import { Loader2, Search } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useRef } from 'react'

import { CustomerHitCard } from '@/components/customers/CustomerHitCard'
import { useCustomerSearch } from '@/components/customers/useCustomerSearch'
import type { SearchHit } from '@/lib/data/customer-search'

export function GlobalSearch() {
  const router = useRouter()
  const search = useCustomerSearch()
  const { query, results, loading, open, setOpen, active, setActive } = search
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, setOpen])

  function go(hit: SearchHit) {
    search.clear()
    router.push('/dashboard/customers/' + hit.id)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const picked = search.onKeyDown(e)
    if (picked) go(picked)
  }

  return (
    <div ref={wrapRef} className="relative mx-auto w-full max-w-md">
      <label htmlFor="global-search" className="sr-only">Search customers</label>
      <div className="relative">
        {loading ? (
          <Loader2
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-blue-400"
            aria-hidden
          />
        ) : (
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500"
            aria-hidden
          />
        )}
        <input
          id="global-search"
          type="search"
          role="combobox"
          aria-expanded={search.showList}
          aria-controls="global-search-results"
          aria-autocomplete="list"
          autoComplete="off"
          value={query}
          onChange={(e) => search.onQueryChange(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => results.length > 0 && setOpen(true)}
          placeholder="Search name, phone, address, MAC or #id..."
          className="w-full rounded-lg border border-gray-800 bg-gray-950 py-2 pl-9 pr-3 text-sm text-gray-200 placeholder:text-gray-600 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30"
        />
      </div>

      {search.showList ? (
        <div
          id="global-search-results"
          role="listbox"
          className="absolute left-0 right-0 top-11 z-50 overflow-hidden rounded-lg bg-gray-800 shadow-xl ring-1 ring-black/40"
        >
          {results.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-gray-400">
              {loading ? 'Searching…' : 'No results found for "' + query.trim() + '"'}
            </p>
          ) : (
            <ul className="max-h-96 overflow-y-auto">
              {results.map((r, i) => (
                <li key={r.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => go(r)}
                    className={
                      'flex w-full items-center gap-3 px-4 py-2.5 text-left transition ' +
                      (i === active ? 'bg-gray-700' : 'hover:bg-gray-700')
                    }
                  >
                    <CustomerHitCard hit={r} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  )
}
