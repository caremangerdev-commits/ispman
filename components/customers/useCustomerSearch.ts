'use client'

import { useRef, useState } from 'react'

import type { SearchHit } from '@/lib/data/customer-search'
import { isSearchQuery } from '@/lib/search'

const DEBOUNCE_MS = 300

/**
 * The typing half of a customer search box: debounced calls to /api/search,
 * shared by the header search and the New Ticket picker so the two find the
 * same people the same way.
 *
 * Driven from the change handler rather than an effect. Searching is a reaction
 * to the user typing, not synchronisation with an external system, so an
 * effect would just add a render pass — and calling setState inside one trips
 * react-hooks/set-state-in-effect.
 *
 * Nothing is asked of the server for a query it would refuse anyway
 * (lib/search.ts#isSearchQuery): the box under two characters shows nothing.
 */
export function useCustomerSearch() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchHit[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestRef = useRef(0)

  function onQueryChange(value: string) {
    setQuery(value)
    if (timerRef.current) clearTimeout(timerRef.current)

    const term = value.trim()
    if (!isSearchQuery(term)) {
      // Invalidates any request still in flight, so it cannot reopen the list.
      requestRef.current++
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

  /** Empties the box and closes the list, as after a pick. */
  function clear() {
    if (timerRef.current) clearTimeout(timerRef.current)
    requestRef.current++
    setQuery('')
    setResults([])
    setOpen(false)
    setLoading(false)
    setActive(-1)
  }

  /** Arrow keys move through the list; returns the hit Enter chose, if any. */
  function onKeyDown(e: React.KeyboardEvent): SearchHit | null {
    if (e.key === 'Escape') {
      setOpen(false)
      return null
    }
    if (!open || results.length === 0) return null

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (i + 1) % results.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (i <= 0 ? results.length - 1 : i - 1))
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault()
      return results[active] ?? null
    }
    return null
  }

  return {
    query,
    results,
    loading,
    open,
    setOpen,
    active,
    setActive,
    onQueryChange,
    onKeyDown,
    clear,
    /** The list is showing: something searchable is typed and an answer came back. */
    showList: open && isSearchQuery(query.trim()),
  }
}
