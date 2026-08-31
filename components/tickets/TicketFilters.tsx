'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'

import type { AgentOption } from '@/lib/data/checkoff'
import { TICKET_STATUSES, TICKET_STATUS_LABELS } from '@/lib/tickets'

const selectCls =
  'rounded-lg border border-gray-700 bg-gray-800 px-2.5 py-1.5 text-sm text-white outline-none transition focus:border-blue-500 focus:ring-1 focus:ring-blue-500/40'

/**
 * Status and assignee filters, held in the URL.
 *
 * Search params rather than local state so a filtered list can be linked and
 * survives a reload — the same approach the payments list takes.
 *
 * `status=` (empty) is a real value meaning "every status", and is distinct
 * from the parameter being absent, which means "the default: open and in
 * progress". Without that distinction there would be no way to ask for
 * everything.
 */
export function TicketFilters({ agents }: { agents: AgentOption[] }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  const status = params.get('status')
  const assignee = params.get('assignee') ?? ''

  function set(key: string, value: string) {
    const next = new URLSearchParams(params.toString())
    if (value === '__default__') next.delete(key)
    else next.set(key, value)

    const qs = next.toString()
    router.push(pathname + (qs ? '?' + qs : ''))
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1.5 text-xs text-gray-500">
        Status
        <select
          value={status === null ? '__default__' : status}
          onChange={(e) => set('status', e.target.value)}
          className={selectCls}
        >
          <option value="__default__">Open &amp; In Progress</option>
          <option value="">All statuses</option>
          {TICKET_STATUSES.map((s) => (
            <option key={s} value={s}>{TICKET_STATUS_LABELS[s]}</option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-1.5 text-xs text-gray-500">
        Assignee
        <select
          value={assignee}
          onChange={(e) => set('assignee', e.target.value)}
          className={selectCls}
        >
          <option value="">Anyone</option>
          <option value="unassigned">Unassigned</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      </label>
    </div>
  )
}
