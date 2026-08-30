'use client'

import { Search, X } from 'lucide-react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

import {
  PAYMENT_METHODS, PAYMENT_METHOD_LABELS,
} from '@/lib/data/checkoff'

const control =
  'rounded-lg border border-gray-800 bg-gray-950 px-3 py-2 text-sm text-gray-200 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30'

/**
 * Filter bar for the payments list.
 *
 * Filters live in the URL so a filtered view is linkable and survives a
 * refresh. The text search debounces; the selects apply immediately.
 */
export function PaymentFilters({
  from, to, type, query, agent, checked, agents, checkoffAvailable,
}: {
  from: string
  to: string
  type: string
  query: string
  agent: string
  checked: string
  /** Distinct agent names present in this company's payments. */
  agents: string[]
  /** False until migration 0010 lands; hides the checkoff filter. */
  checkoffAvailable: boolean
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  const [text, setText] = useState(query)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Re-sync when the URL changes from outside (Clear, back button).
  const [seen, setSeen] = useState(query)
  if (query !== seen) {
    setSeen(query)
    setText(query)
  }

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  function push(patch: Record<string, string>) {
    const next = new URLSearchParams(params.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v)
      else next.delete(k)
    }
    // Any filter change invalidates the current page number.
    next.delete('page')
    const qs = next.toString()
    router.replace(pathname + (qs ? '?' + qs : ''))
  }

  function onSearch(value: string) {
    setText(value)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => push({ q: value }), 300)
  }

  const hasFilters = Boolean(from || to || type || query || agent || checked)

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-xl border border-gray-800 bg-gray-900 p-4">
      <div className="space-y-1.5">
        <label htmlFor="from" className="block text-xs font-medium text-gray-400">From</label>
        <input
          id="from"
          type="date"
          value={from}
          onChange={(e) => push({ from: e.target.value })}
          className={control}
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="to" className="block text-xs font-medium text-gray-400">To</label>
        <input
          id="to"
          type="date"
          value={to}
          onChange={(e) => push({ to: e.target.value })}
          className={control}
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="type" className="block text-xs font-medium text-gray-400">Method</label>
        <select
          id="type"
          value={type}
          onChange={(e) => push({ type: e.target.value })}
          className={control}
        >
          <option value="">All</option>
          {PAYMENT_METHODS.map((t) => (
            <option key={t} value={t}>{PAYMENT_METHOD_LABELS[t]}</option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="agent" className="block text-xs font-medium text-gray-400">Agent</label>
        <select
          id="agent"
          value={agent}
          onChange={(e) => push({ agent: e.target.value })}
          className={control}
        >
          <option value="">All</option>
          {agents.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
      </div>

      {checkoffAvailable ? (
        <div className="space-y-1.5">
          <label htmlFor="checked" className="block text-xs font-medium text-gray-400">
            Checked Off
          </label>
          <select
            id="checked"
            value={checked}
            onChange={(e) => push({ checked: e.target.value })}
            className={control}
          >
            <option value="">All</option>
            <option value="yes">Checked off</option>
            <option value="no">Outstanding</option>
          </select>
        </div>
      ) : null}

      <div className="min-w-[220px] flex-1 space-y-1.5">
        <label htmlFor="q" className="block text-xs font-medium text-gray-400">Customer</label>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" aria-hidden />
          <input
            id="q"
            type="search"
            value={text}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search by customer name..."
            className={control + ' w-full pl-9'}
          />
        </div>
      </div>

      {hasFilters ? (
        <button
          type="button"
          onClick={() => push({ from: '', to: '', type: '', q: '', agent: '', checked: '' })}
          className="inline-flex items-center gap-1 rounded-lg bg-gray-800 px-3 py-2 text-xs font-semibold text-gray-300 transition hover:bg-gray-700"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
          Clear
        </button>
      ) : null}
    </div>
  )
}
