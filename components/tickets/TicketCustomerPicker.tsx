'use client'

import { Loader2, Search } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'

import { CustomerHitCard } from '@/components/customers/CustomerHitCard'
import { useCustomerSearch } from '@/components/customers/useCustomerSearch'
import type { CustomerHit } from '@/lib/data/customer-search'

/**
 * Who the ticket is for, found the way the header search finds anyone.
 *
 * THIS REPLACED A DROPDOWN OF EVERY CUSTOMER IN THE COMPANY. The New Ticket
 * page loaded the whole book into a <select> for whoever opened it — a
 * technician, who has no customer list, could scroll through all of it. It now
 * asks /api/search like the header box does: the same limits (two characters,
 * twenty matches, lib/search.ts#isSearchQuery), the same result card, and the
 * same way through to the customer's record, where a technician can correct the
 * MAC they came to report a fault on.
 *
 * Clicking a result picks it for the ticket; "Open" beside it goes to the
 * record instead. The record's own New Ticket button comes back here with the
 * customer already picked (`initial`).
 */
export function TicketCustomerPicker({
  initial,
  inputId,
  inputClassName,
}: {
  /** The customer a record sent us with (?customer=), or null. */
  initial: CustomerHit | null
  /** For the field's <label>. */
  inputId: string
  inputClassName: string
}) {
  const [selected, setSelected] = useState<CustomerHit | null>(initial)
  const search = useCustomerSearch()
  const { query, results, loading, open, setOpen, active, setActive } = search
  const wrapRef = useRef<HTMLDivElement>(null)
  // After "Change", the box that replaces the card takes the cursor.
  const [focusSearch, setFocusSearch] = useState(false)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, setOpen])

  function pick(hit: CustomerHit) {
    search.clear()
    setSelected(hit)
    setFocusSearch(false)
  }

  function change() {
    setSelected(null)
    setFocusSearch(true)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const picked = search.onKeyDown(e)
    if (picked) {
      pick(picked)
      return
    }
    // Enter in this box never submits the ticket half-filled: with the list
    // open it takes the top match, otherwise it does nothing.
    if (e.key === 'Enter') {
      e.preventDefault()
      if (search.showList && results.length > 0) pick(results[0])
    }
  }

  return (
    <div className="space-y-1.5">
      <input type="hidden" name="customer_id" value={selected ? String(selected.id) : ''} />

      {selected ? (
        // The actions drop under the card when there is no room beside it, so
        // on a phone the name is never squeezed out by the buttons.
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5">
          <div className="flex min-w-[12rem] flex-1 items-center gap-3">
            <CustomerHitCard hit={selected} />
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Link
              href={'/dashboard/customers/' + selected.id}
              className="rounded-md px-2 py-1 text-xs font-semibold text-blue-400 transition hover:bg-gray-700 hover:text-blue-300"
            >
              Open record
            </Link>
            <button
              type="button"
              onClick={change}
              className="rounded-md px-2 py-1 text-xs font-semibold text-gray-300 transition hover:bg-gray-700"
            >
              Change
            </button>
          </div>
        </div>
      ) : (
        <div ref={wrapRef} className="relative">
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
            id={inputId}
            autoFocus={focusSearch}
            type="search"
            role="combobox"
            aria-expanded={search.showList}
            aria-controls={inputId + '-results'}
            aria-autocomplete="list"
            autoComplete="off"
            value={query}
            onChange={(e) => search.onQueryChange(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => results.length > 0 && setOpen(true)}
            placeholder="Search name, phone, address, MAC or #id..."
            className={inputClassName + ' pl-9'}
          />

          {search.showList ? (
            <div
              id={inputId + '-results'}
              role="listbox"
              className="absolute left-0 right-0 top-11 z-20 overflow-hidden rounded-lg bg-gray-800 shadow-xl ring-1 ring-black/40"
            >
              {results.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-gray-400">
                  {loading ? 'Searching…' : 'No results found for "' + query.trim() + '"'}
                </p>
              ) : (
                <ul className="max-h-96 overflow-y-auto">
                  {results.map((r, i) => (
                    <li
                      key={r.id}
                      className={'flex items-center transition ' + (i === active ? 'bg-gray-700' : 'hover:bg-gray-700')}
                      onMouseEnter={() => setActive(i)}
                    >
                      <button
                        type="button"
                        role="option"
                        aria-selected={i === active}
                        onClick={() => pick(r)}
                        className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-4 pr-2 text-left"
                      >
                        <CustomerHitCard hit={r} />
                      </button>
                      <Link
                        href={'/dashboard/customers/' + r.id}
                        className="shrink-0 px-3 py-2.5 text-xs font-semibold text-blue-400 transition hover:text-blue-300"
                        aria-label={'Open the record for ' + ([r.first_name, r.last_name].filter(Boolean).join(' ') || 'this customer')}
                      >
                        Open
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
