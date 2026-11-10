'use client'

import { Search, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { GlobalSearch } from '@/components/ui/GlobalSearch'

/**
 * Search from anywhere on a phone.
 *
 * The navbar's own GlobalSearch is `hidden md:block`, so until now the only
 * search on a handset was the one on the customers page — you had to navigate
 * to a list to look something up (owner, 10 Nov 2026). Search is how this
 * platform is actually used, so it belongs on every screen.
 *
 * A sheet rather than a box in the header: a 44px target costs no width, and
 * once open the field gets the full screen width plus the touch size, instead
 * of the ~160px that would be left beside the menu and avatar buttons.
 */
export function MobileSearch() {
  // Picking a result navigates, and the sheet must not survive that: closing
  // is done by the onNavigate below rather than by watching the pathname,
  // since every way out of the sheet goes through picking a result.
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Search customers"
        aria-expanded={open}
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-gray-300 transition hover:bg-gray-800 hover:text-white md:hidden"
      >
        <Search className="h-5 w-5" aria-hidden />
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Search">
          {/* Tap anywhere off the field to dismiss. */}
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            onClick={() => setOpen(false)}
            className="absolute inset-0 h-full w-full cursor-default bg-black/60"
          />

          <div className="relative border-b border-gray-800 bg-gray-900 p-3 shadow-xl">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <GlobalSearch autoFocus size="lg" onNavigate={() => setOpen(false)} />
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close search"
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-gray-400 transition hover:bg-gray-800 hover:text-white"
              >
                <X className="h-5 w-5" aria-hidden />
              </button>
            </div>
            <p className="mt-2 px-1 text-xs text-gray-500">
              Search by name, phone, address, MAC or #id
            </p>
          </div>
        </div>
      ) : null}
    </>
  )
}
