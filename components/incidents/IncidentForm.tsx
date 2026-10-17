'use client'

import { useActionState, useState } from 'react'

import { openIncident, type IncidentResult } from '@/app/actions/incidents'

/**
 * Declare an outage. Scope is the whole company or one access point — scoping
 * is the point, so an unaffected customer is never shown a banner. "Next update
 * by" is a time we commit to saying more, not a promised fix.
 */
export function IncidentForm({ accessPoints }: { accessPoints: string[] }) {
  const [state, action, pending] = useActionState<IncidentResult | null, FormData>(openIncident, null)
  const [scope, setScope] = useState<'company' | 'access_point'>('company')

  const input = 'w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 outline-none focus:border-gray-500'

  return (
    <form action={action} className="space-y-3 rounded-lg border border-gray-800 bg-gray-900/40 p-4">
      <h2 className="text-sm font-semibold text-gray-200">Open an incident</h2>

      <label className="block space-y-1">
        <span className="text-xs text-gray-400">Title (shown to customers)</span>
        <input name="title" required maxLength={120} placeholder="Fibre cut affecting Red Hills" className={input} />
      </label>

      <label className="block space-y-1">
        <span className="text-xs text-gray-400">Message (optional)</span>
        <textarea name="message" rows={2} maxLength={400} placeholder="Our team is on site." className={input} />
      </label>

      <fieldset className="space-y-2">
        <span className="text-xs text-gray-400">Who is affected</span>
        <label className="flex items-center gap-2 text-sm text-gray-200">
          <input type="radio" name="scope" value="company" checked={scope === 'company'} onChange={() => setScope('company')} />
          Everyone (company-wide)
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-200">
          <input type="radio" name="scope" value="access_point" checked={scope === 'access_point'} onChange={() => setScope('access_point')} />
          One access point
        </label>
      </fieldset>

      {scope === 'access_point' ? (
        <label className="block space-y-1">
          <span className="text-xs text-gray-400">Access point</span>
          <select name="scope_value" className={input} defaultValue="">
            <option value="" disabled>Choose…</option>
            {accessPoints.map((ap) => (
              <option key={ap} value={ap}>{ap}</option>
            ))}
          </select>
        </label>
      ) : null}

      <label className="block space-y-1">
        <span className="text-xs text-gray-400">Next update by (optional)</span>
        <input name="next_update_at" type="datetime-local" className={input} />
      </label>

      {state && !state.ok ? <p className="text-xs text-red-400">{state.error}</p> : null}
      {state && state.ok ? <p className="text-xs text-green-400">Incident opened{accessPoints.length ? '' : ''}. Customers in scope will see the banner.</p> : null}

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
      >
        {pending ? 'Opening…' : 'Open incident'}
      </button>
    </form>
  )
}
