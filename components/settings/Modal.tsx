'use client'

import { X } from 'lucide-react'
import { useEffect } from 'react'

/**
 * Minimal dialog shell for the settings CRUD forms.
 *
 * Closes on Escape and on backdrop click. Not focus-trapped — these are short
 * forms behind an admin-only route; swap for a real dialog primitive if this
 * grows.
 */
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-lg rounded-xl border border-gray-800 bg-gray-900 shadow-2xl"
      >
        <header className="flex items-center justify-between gap-3 border-b border-gray-800 px-5 py-3">
          <h2 className="text-sm font-semibold text-white">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-gray-500 transition hover:bg-gray-800 hover:text-gray-300"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>
        <div className="p-5">{children}</div>
      </div>
    </div>
  )
}

export const settingsInput =
  'w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder:text-gray-500 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30'

export function StatusPill({ active }: { active: boolean }) {
  return (
    <span
      className={
        'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ' +
        (active ? 'bg-green-500/15 text-green-400' : 'bg-gray-600/30 text-gray-400')
      }
    >
      {active ? 'Active' : 'Inactive'}
    </span>
  )
}
