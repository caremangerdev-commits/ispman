import { PencilLine } from 'lucide-react'

import { decodeChanges, EMPTY } from '@/lib/customer-changes'
import { logField, logSubject, readLogDetail } from '@/lib/log-detail'
import { timeAgo } from '@/lib/format'
import type { LogRow } from '@/lib/types'

/**
 * What has been edited on this customer's record, most recent first.
 *
 * Reads the `customer_updated` rows the edit form writes, so this card and the
 * company activity feed are looking at one record rather than two — see
 * lib/data/customer-changes.ts.
 *
 * SHOWS EVERY FIELD, unlike the feed, which caps its summary at three. This is
 * the surface where "what exactly changed" is the question being asked, so
 * truncating here would only send the reader to the database.
 */

/**
 * Pulls `changes=` and `by=` back out of a stored row.
 *
 * Every piece of this comes from lib/log-detail.ts. It used to carry its own
 * copy of the marker regex and its own field matcher, and the field matcher was
 * subtly wrong in a way the other copy was not — see that module for what it
 * cost. There is no regex against `details` left in this file.
 */
function parse(details: string | null) {
  const { body, viaPlatform } = readLogDetail(details)

  return {
    who: logSubject(body),
    by: logField(body, 'by'),
    platform: viaPlatform,
    changes: decodeChanges(logField(body, 'changes') ?? ''),
  }
}

export function ChangeHistory({ entries }: { entries: LogRow[] }) {
  return (
    <section className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
      <header className="flex items-baseline justify-between gap-3 border-b border-gray-800 px-5 py-3">
        <h2 className="text-sm font-semibold text-white">Change History</h2>
        <p className="text-xs text-gray-500">
          {entries.length === 0
            ? 'No edits'
            : 'Last ' + entries.length + (entries.length === 1 ? ' edit' : ' edits')}
        </p>
      </header>

      {entries.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-gray-600">
          This record has not been edited since change history was added.
        </p>
      ) : (
        <ul className="divide-y divide-gray-800">
          {entries.map((entry) => {
            const { by, platform, changes } = parse(entry.details)
            return (
              <li key={entry.id} className="flex gap-3 px-5 py-3">
                <span
                  className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-500/10 text-blue-400"
                  aria-hidden
                >
                  <PencilLine className="h-3.5 w-3.5" />
                </span>

                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-gray-500">
                    <span>{by ?? 'An operator'}</span>
                    {platform ? (
                      <span className="rounded bg-purple-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-purple-300">
                        Platform operator
                      </span>
                    ) : null}
                    <span>{timeAgo(entry.created_at)}</span>
                  </p>

                  <dl className="mt-1.5 space-y-1">
                    {changes.map((c) => (
                      <div key={c.field} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                        <dt className="text-gray-400">{c.label}</dt>
                        <dd className="flex flex-wrap items-baseline gap-x-1.5 text-gray-200">
                          {/* A change with no "from" is one where the previous
                              value is deliberately not recorded — a password —
                              or an add-on list, which reads as a delta. */}
                          {c.from ? (
                            <>
                              <span className="text-gray-500 line-through">{c.from || EMPTY}</span>
                              <span className="text-gray-600" aria-label="changed to">→</span>
                            </>
                          ) : null}
                          <span className="font-medium">{c.to || EMPTY}</span>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
