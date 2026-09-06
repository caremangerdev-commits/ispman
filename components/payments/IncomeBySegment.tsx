import { formatCurrency } from '@/lib/format'
import type { SegmentTotal } from '@/lib/data/payments'

/**
 * Income split by customer segment, for the payments page.
 *
 * WHAT THIS IS FOR. A company whose customer base is split between two owners
 * tracks the split with misc categories and needs to answer "what did I collect
 * this month" for each of them. It sits on the payments page rather than in a
 * report of its own because that question is this page's existing question with
 * a date range already applied — the filter bar, the date range and the total
 * are all here, and this adds the one dimension they were missing.
 *
 * A FILTER WOULD NOT DO. Filtering the list to one segment answers for one owner
 * at a time; what is actually wanted is to see them beside each other, with the
 * remainder that belongs to neither of them visible rather than filtered away.
 *
 * REPORTING ONLY. Everyone still sees every customer and every payment. Nothing
 * here restricts anything, and nothing should be built on top of it that does.
 */
export function IncomeBySegment({
  segments,
  totalCollected,
  showOther,
}: {
  segments: SegmentTotal[]
  /** The page's own headline figure. The rows must sum to it — see below. */
  totalCollected: number
  /** False before migration 0013, when no payment can be an "other" payment. */
  showOther: boolean
}) {
  if (segments.length === 0) return null

  // THE ROWS SUM TO THE HEADLINE FIGURE, and this checks it rather than trusting
  // it. Both come from the same filtered rows (lib/data/payments.ts
  // #summariseSegments), so a mismatch means a real bug rather than a rounding
  // artefact — and a split that does not reconcile with the total is worse than
  // no split at all, because two people will divide money by it.
  const summed = segments.reduce((sum, s) => sum + s.total, 0)
  const reconciles = Math.abs(summed - totalCollected) < 0.01

  return (
    <section
      aria-label="Income by customer category"
      className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-gray-800 px-4 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">
          Income by Category
        </h2>
        <p className="text-[11px] text-gray-600">
          Across the filtered set, not just this page
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-left text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-[11px] uppercase tracking-wider text-gray-500">
              <th className="px-4 py-2 font-medium">Category</th>
              <th className="px-4 py-2 text-right font-medium">Payments</th>
              {showOther ? (
                <>
                  <th className="px-4 py-2 text-right font-medium">Service</th>
                  {/* Its own column so an installation fee is never read as
                      recurring income. It is still that owner's money, so it is
                      counted, not excluded. */}
                  <th className="px-4 py-2 text-right font-medium">Other</th>
                </>
              ) : null}
              <th className="px-4 py-2 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {segments.map((s) => (
              <tr
                key={s.id ?? 'uncategorised'}
                className="border-b border-gray-800/60 last:border-0"
              >
                <td className="px-4 py-2.5">
                  {/* Uncategorised is styled as a remainder, not as a peer of the
                      real categories — it is money that belongs to nobody yet,
                      and it must not read as a third owner. */}
                  <span className={s.id === null ? 'text-gray-500 italic' : 'text-gray-200'}>
                    {s.label}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-gray-500">{s.count}</td>
                {showOther ? (
                  <>
                    <td className="px-4 py-2.5 text-right tabular-nums text-gray-400">
                      {formatCurrency(s.service)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-gray-400">
                      {formatCurrency(s.other)}
                    </td>
                  </>
                ) : null}
                <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-white">
                  {formatCurrency(s.total)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-gray-700 bg-gray-900/60">
              <td className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-gray-400">
                Total
              </td>
              <td />
              {showOther ? (
                <>
                  <td />
                  <td />
                </>
              ) : null}
              <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-white">
                {formatCurrency(totalCollected)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Only ever shown if the arithmetic actually disagrees. Silence here is
          the normal state; a warning is a bug report, not a disclaimer. */}
      {!reconciles ? (
        <p role="alert" className="border-t border-amber-900/60 bg-amber-950/30 px-4 py-2 text-xs text-amber-300">
          These rows come to {formatCurrency(summed)}, which does not match the{' '}
          {formatCurrency(totalCollected)} collected. Do not divide income on this
          until it is explained.
        </p>
      ) : null}
    </section>
  )
}
