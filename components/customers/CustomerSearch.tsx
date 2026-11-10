'use client'

import { Search, X } from 'lucide-react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useState, useTransition } from 'react'

import { SEARCH_INPUT_CLASS, SEARCH_INPUT_PROPS } from '@/lib/search-input'

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

  /**
   * The query THIS BOX last pushed into the URL.
   *
   * THIS IS WHAT STOPPED PEOPLE TYPING ON A PHONE (owner, 10 Nov 2026). The
   * re-sync below exists for a filter tab or the back button changing the
   * query from outside. But it could not tell an outside change from this
   * box's own navigation arriving back, and that navigation lands 300ms after
   * a keystroke — in the middle of the next word.
   *
   * So: type "mich", the debounce pushes ?q=mich, and by the time the new
   * `initial` of "mich" comes back the person has typed "michelle". The old
   * code saw initial !== seen and called setValue("mich"), throwing away
   * "elle". Every 300ms of typing, a few characters disappeared.
   *
   * It read as random because it depends on exactly where the debounce lands,
   * and it was far worse on a phone: the soft keyboard commits a whole word at
   * a time rather than a character, and once the field's value is replaced
   * underneath it, it re-capitalises as though a new sentence had started.
   * That is the "random capitalisation and deletion" together, one cause.
   *
   * Remembering what we pushed makes the test exact: an `initial` equal to it
   * is our own echo and is ignored; anything else is somebody really changing
   * the query, and is honoured.
   *
   * State and not a ref, because the comparison below happens during render
   * and a ref read there is exactly the stale-value trap react-hooks/refs
   * warns about. It is written from inside the debounce timer, never during a
   * render, so it costs one extra render per navigation we were doing anyway.
   */
  const [pushed, setPushed] = useState(initial)

  // Re-sync when the URL changes from outside (filter tabs, back button).
  // Adjusted during render rather than in an effect to avoid a cascading render.
  const [seenInitial, setSeenInitial] = useState(initial)
  if (initial !== seenInitial) {
    setSeenInitial(initial)
    if (initial !== pushed) setValue(initial)
  }

  useEffect(() => {
    if (value === initial) return

    const timer = setTimeout(() => {
      const next = new URLSearchParams(params.toString())
      if (value) next.set('q', value)
      else next.delete('q')
      next.delete('page') // a new query invalidates the current page number
      // Claimed BEFORE navigating, so the `initial` this produces is already
      // recognisable as ours by the time it arrives: this is a default-priority
      // update and the navigation below is a transition, so it commits first.
      setPushed(value)
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
      {/* Icon and clear button sit ON the white field, so they are graded
          against white, not against the dark page behind it. */}
      <label htmlFor="customer-search" className="sr-only">
        Search customers
      </label>
      <input
        id="customer-search"
        {...SEARCH_INPUT_PROPS}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search name, phone, address, MAC or #id..."
        className={SEARCH_INPUT_CLASS}
      />
      {value ? (
        <button
          type="button"
          onClick={() => setValue('')}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-500 transition hover:text-gray-800"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  )
}
