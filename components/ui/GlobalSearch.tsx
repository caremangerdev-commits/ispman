'use client'

import { Loader2, Search } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

import type { SearchHit } from '@/app/api/search/route'

import { STATUS_DOT } from '@/lib/status'
const DOTS: Record<string, string> = STATUS_DOT

const MIN_CHARS = 2
const DEBOUNCE_MS = 300

export function GlobalSearch() {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchHit[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const wrapRef = useRef<HTMLDivElement>(null)

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestRef = useRef(0)

  /**
   * Debounced search, driven from the change handler rather than an effect.
   *
   * Searching is a reaction to the user typing, not synchronisation with an
   * external system, so an effect would just add a render pass — and calling
   * setState inside one trips react-hooks/set-state-in-effect.
   */
  function onQueryChange(value: string) {
    setQuery(value)
    if (timerRef.current) clearTimeout(timerRef.current)

    const term = value.trim()
    if (term.length < MIN_CHARS) {
      setResults([])
      setOpen(false)
      setLoading(false)
      return
    }

    setLoading(true)
    timerRef.current = setTimeout(async () => {
      // Sequence number guards against an older, slower response landing
      // after a newer one and overwriting it.
      const seq = ++requestRef.current
      try {
        const res = await fetch('/api/search?q=' + encodeURIComponent(term))
        if (!res.ok) throw new Error('search failed')
        const json = (await res.json()) as { results: SearchHit[] }
        if (seq !== requestRef.current) return
        setResults(json.results ?? [])
        setActive(-1)
      } catch {
        if (seq !== requestRef.current) return
        setResults([])
      } finally {
        if (seq === requestRef.current) {
          setOpen(true)
          setLoading(false)
        }
      }
    }, DEBOUNCE_MS)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  function go(hit: SearchHit) {
    setOpen(false)
    setQuery('')
    router.push('/dashboard/customers/' + hit.id)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      setOpen(false)
      return
    }
    if (!open || results.length === 0) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (i + 1) % results.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (i <= 0 ? results.length - 1 : i - 1))
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault()
      go(results[active])
    }
  }

  const showDropdown = open && query.trim().length >= MIN_CHARS

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
          aria-expanded={showDropdown}
          aria-controls="global-search-results"
          aria-autocomplete="list"
          autoComplete="off"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => results.length > 0 && setOpen(true)}
          placeholder="Search customers..."
          className="w-full rounded-lg border border-gray-800 bg-gray-950 py-2 pl-9 pr-3 text-sm text-gray-200 placeholder:text-gray-600 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30"
        />
      </div>

      {showDropdown ? (
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
                    <span
                      className={'h-2 w-2 shrink-0 rounded-full ' + DOTS[r.status]}
                      aria-label={r.status}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-white">
                        {[r.first_name, r.last_name].filter(Boolean).join(' ') || 'Unnamed'}
                      </span>
                      <span className="block truncate text-xs text-gray-400">
                        {r.phone ?? 'No phone'}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-xs text-gray-400">
                      {r.mac_address ?? '—'}
                    </span>
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
