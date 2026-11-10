'use client'

import { Loader2, Search } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useId, useRef } from 'react'

import { CustomerHitCard } from '@/components/customers/CustomerHitCard'
import { useCustomerSearch } from '@/components/customers/useCustomerSearch'
import type { CustomerHit } from '@/lib/data/customer-search'
import {
  SEARCH_INPUT_CLASS,
  SEARCH_INPUT_CLASS_LG,
  SEARCH_INPUT_PROPS,
} from '@/lib/search-input'

export type GlobalSearchProps = {
  /** Focus on mount. Set by the mobile sheet, whose only purpose is this box. */
  autoFocus?: boolean
  /** `lg` is the touch size — taller, bigger text, no iOS zoom-on-focus. */
  size?: 'md' | 'lg'
  /** Called after a result is picked, so a sheet can close itself. */
  onNavigate?: () => void
}

export function GlobalSearch({
  autoFocus = false,
  size = 'md',
  onNavigate,
}: GlobalSearchProps = {}) {
  const router = useRouter()
  const search = useCustomerSearch()
  const { query, results, loading, open, setOpen, active, setActive } = search
  const wrapRef = useRef<HTMLDivElement>(null)
  const large = size === 'lg'

  // The desktop box stays mounted (just hidden) while the mobile sheet is
  // open, so two of these exist at once. Fixed ids would collide and a tap on
  // the sheet's label would focus the invisible one.
  const uid = useId()
  const inputId = 'global-search' + uid
  const listId = 'global-search-results' + uid

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, setOpen])

  function go(hit: CustomerHit) {
    search.clear()
    onNavigate?.()
    router.push('/dashboard/customers/' + hit.id)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const picked = search.onKeyDown(e)
    if (picked) go(picked)
  }

  return (
    <div ref={wrapRef} className="relative mx-auto w-full max-w-md">
      <label htmlFor={inputId} className="sr-only">Search customers</label>
      <div className="relative">
        {loading ? (
          <Loader2
            className={
              'pointer-events-none absolute top-1/2 -translate-y-1/2 animate-spin text-blue-600 ' +
              (large ? 'left-4 h-5 w-5' : 'left-3 h-4 w-4')
            }
            aria-hidden
          />
        ) : (
          <Search
            className={
              'pointer-events-none absolute top-1/2 -translate-y-1/2 text-gray-500 ' +
              (large ? 'left-4 h-5 w-5' : 'left-3 h-4 w-4')
            }
            aria-hidden
          />
        )}
        <input
          id={inputId}
          {...SEARCH_INPUT_PROPS}
          role="combobox"
          aria-expanded={search.showList}
          aria-controls={listId}
          aria-autocomplete="list"
          autoFocus={autoFocus}
          value={query}
          onChange={(e) => search.onQueryChange(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => results.length > 0 && setOpen(true)}
          placeholder="Search name, phone, address, MAC or #id..."
          className={large ? SEARCH_INPUT_CLASS_LG : SEARCH_INPUT_CLASS}
        />
      </div>

      {search.showList ? (
        <div
          id={listId}
          role="listbox"
          className={
            'absolute left-0 right-0 z-50 overflow-hidden rounded-lg bg-gray-800 shadow-xl ring-1 ring-black/40 ' +
            (large ? 'top-14' : 'top-11')
          }
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
