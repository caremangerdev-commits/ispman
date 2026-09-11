import { Archive, FileDown } from 'lucide-react'

import type { HandoverRecord } from '@/lib/data/checkoff'
import { formatDateTime } from '@/lib/format'

/**
 * Handovers that have already been settled.
 *
 * SEPARATE FROM THE RECONCILIATION SCREEN, because they answer different
 * questions. The main tab asks "who owes a handover right now" and derives it
 * from unchecked payments; this asks "what was handed over, by whom, when".
 * A settled handover can never appear on the first by construction — its
 * payments are checked off — which is why 36 records across two companies had
 * never been visible anywhere.
 *
 * A server component: it renders a table and has nothing to interact with.
 */

function money(symbol: string, n: number) {
  return symbol + new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n)
}

export function HandoverHistory({
  rows, symbol,
}: {
  rows: HandoverRecord[]
  symbol: string
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-gray-800 bg-gray-900 px-4 py-12 text-center">
        <Archive className="mx-auto h-5 w-5 text-gray-600" aria-hidden />
        <p className="mt-2 text-sm text-gray-500">No handovers recorded yet.</p>
        <p className="mt-1 text-xs text-gray-600">
          A handover appears here once an agent&apos;s collections have been checked off.
        </p>
      </div>
    )
  }

  const migratedCount = rows.filter((r) => r.migrated).length

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-gray-500">
          {rows.length} handover{rows.length === 1 ? '' : 's'}
          {migratedCount > 0 ? (
            <span className="text-gray-600">
              {' '}· {migratedCount} carried over from your previous system
            </span>
          ) : null}
        </p>
      </div>

      <div className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-[11px] uppercase tracking-wider text-gray-500">
                <th scope="col" className="px-4 py-2.5 font-semibold">Date</th>
                <th scope="col" className="px-4 py-2.5 font-semibold">Agent</th>
                <th scope="col" className="px-4 py-2.5 text-right font-semibold">
                  Amount handed over
                </th>
                <th scope="col" className="px-4 py-2.5 text-right font-semibold">
                  System total
                </th>
                <th scope="col" className="px-4 py-2.5 text-right font-semibold">
                  Difference
                </th>
                <th scope="col" className="px-4 py-2.5 font-semibold">Source</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-gray-800">
              {rows.map((r) => (
                <tr key={r.id} className="transition hover:bg-gray-800/40">
                  <td className="whitespace-nowrap px-4 py-2.5 text-gray-400">
                    {formatDateTime(r.createdAt)}
                  </td>

                  <td className="px-4 py-2.5">
                    <span className="text-gray-200">{r.agentName}</span>
                    {r.isAllAgents ? (
                      <span className="ml-1.5 rounded bg-gray-800 px-1.5 py-0.5 text-[10px] font-medium text-gray-400">
                        all agents
                      </span>
                    ) : null}
                  </td>

                  {/* NULL IS NOT ZERO. The all-agents checkoff records the
                      money on a single summary row, so a per-agent row
                      legitimately has no amount of its own — and printing a
                      zero there would say the agent handed over nothing. */}
                  <td className="whitespace-nowrap px-4 py-2.5 text-right font-medium text-gray-200">
                    {r.amountReceived === null ? (
                      <span
                        className="text-xs font-normal text-gray-600"
                        title="Recorded on the all-agents summary row for this batch"
                      >
                        on summary row
                      </span>
                    ) : (
                      money(symbol, r.amountReceived)
                    )}
                  </td>

                  {/* A migrated row has no system total to compare against — the
                      legacy table recorded what was handed over and nothing
                      else. Showing 0 would read as "the system expected
                      nothing", which is a different and wrong claim. */}
                  <td className="whitespace-nowrap px-4 py-2.5 text-right text-gray-400">
                    {r.migrated ? <span className="text-gray-600">—</span>
                      : money(symbol, r.systemTotal)}
                  </td>

                  <td className="whitespace-nowrap px-4 py-2.5 text-right">
                    {r.migrated || r.discrepancy === null ? (
                      <span className="text-gray-600">—</span>
                    ) : r.discrepancy === 0 ? (
                      <span className="text-gray-500">—</span>
                    ) : (
                      <span className={r.discrepancy < 0 ? 'text-red-400' : 'text-amber-400'}>
                        {r.discrepancy > 0 ? '+' : ''}{money(symbol, r.discrepancy)}
                      </span>
                    )}
                  </td>

                  <td className="px-4 py-2.5">
                    {r.migrated ? (
                      <span
                        className="inline-flex items-center gap-1 rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-300"
                        title={
                          'Imported from your previous system. The legacy records ' +
                          'show the amount handed over but not which payments made ' +
                          'it up, so there is nothing to open.'
                        }
                      >
                        <FileDown className="h-3 w-3" aria-hidden />
                        Migrated
                      </span>
                    ) : (
                      <span className="text-[11px] text-gray-600">
                        {r.customersCount} customer{r.customersCount === 1 ? '' : 's'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {migratedCount > 0 ? (
        <p className="rounded-lg border border-gray-800 bg-gray-950 px-3 py-2 text-[11px] leading-relaxed text-gray-500">
          <strong className="font-semibold text-gray-400">About migrated handovers.</strong>{' '}
          These came across from your previous system, which recorded the amount
          handed over but not which payments made it up. They are history only — no
          payments are linked to them, and nothing here can be opened or reconciled.
        </p>
      ) : null}
    </div>
  )
}
