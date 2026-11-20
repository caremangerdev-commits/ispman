import type { CustomerUsage } from '@/lib/data/usage'
import { formatBytes } from '@/lib/format'

/**
 * A customer's data usage: the month so far, and the last 30 days.
 *
 * THE BARS ARE SCALED TO THIS CUSTOMER'S OWN BUSIEST DAY, not to a fixed
 * ceiling and not across customers. The question this answers is "is this
 * normal for them, and when did it change" — a shared scale would flatten a
 * light user's chart to nothing and say less, not more.
 *
 * DOWNLOAD AND UPLOAD ARE STACKED, download at the bottom, because the total
 * is what a fair-use conversation is about while the split is what tells you
 * whether something is seeding. Two separate charts would take twice the room
 * to answer the same question.
 *
 * NO CLOCK IS READ HERE. Every date comes from the series the loader built, so
 * this renders the same thing twice in a row.
 */

function Bar({ rx, tx, max, day }: { rx: number; tx: number; max: number; day: string }) {
  const total = rx + tx
  // A day with traffic always shows something: a 1% bar reads as "a little",
  // where nothing at all reads as "offline", and the two are worth telling
  // apart at a glance.
  const height = total === 0 ? 0 : Math.max(4, Math.round((total / max) * 100))
  const rxShare = total === 0 ? 0 : Math.round((rx / total) * 100)

  return (
    <div className="flex h-full flex-1 flex-col justify-end" title={day + ': ' + formatBytes(total)}>
      <div className="w-full rounded-[2px] bg-gray-800" style={{ height: height + '%' }}>
        <div className="h-full w-full overflow-hidden rounded-[2px]">
          <div className="w-full bg-blue-400/80" style={{ height: 100 - rxShare + '%' }} />
          <div className="w-full bg-blue-500" style={{ height: rxShare + '%' }} />
        </div>
      </div>
    </div>
  )
}

export function UsageBlock({ usage, polling }: { usage: CustomerUsage; polling: boolean }) {
  const max = Math.max(...usage.series.map((d) => d.rx + d.tx), 1)
  const first = usage.series[0]?.day ?? ''
  const last = usage.series[usage.series.length - 1]?.day ?? ''

  return (
    <section className="rounded-xl border border-gray-800 bg-gray-900 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-white">Data used</h3>
        <p className="text-[11px] text-gray-500">This month so far</p>
      </div>

      <div className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <p className="text-2xl font-semibold tabular-nums text-white">
          {formatBytes(usage.monthRx + usage.monthTx)}
        </p>
        <p className="text-xs text-gray-400">
          <span className="tabular-nums">{formatBytes(usage.monthRx)}</span> down
          <span className="mx-1.5 text-gray-700">·</span>
          <span className="tabular-nums">{formatBytes(usage.monthTx)}</span> up
        </p>
      </div>

      {usage.empty ? (
        <p className="mt-3 text-xs leading-relaxed text-gray-500">
          {polling
            ? 'Nothing recorded for this customer yet. Usage appears once they have been online ' +
              'with a queue on their router.'
            : 'Usage is not being collected yet. It is read from the speed queues on each router, ' +
              'which needs the router set up with its one-line setup.'}
        </p>
      ) : (
        <>
          <div className="mt-4">
            <div className="flex h-20 items-end gap-[2px]" aria-hidden="true">
              {usage.series.map((d) => (
                <Bar key={d.day} day={d.day} rx={d.rx} tx={d.tx} max={max} />
              ))}
            </div>
            <div className="mt-1 flex justify-between text-[10px] text-gray-600">
              <span>{first}</span>
              <span>{last}</span>
            </div>
          </div>
          <p className="mt-2 text-[10px] text-gray-600">
            Busiest day {formatBytes(max)}. Darker is download.
          </p>
        </>
      )}
    </section>
  )
}
