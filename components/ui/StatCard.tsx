import { ArrowDownRight, ArrowRight, ArrowUpRight, type LucideIcon } from 'lucide-react'

import type { Trend } from '@/lib/data/dashboard'

export type Accent = 'blue' | 'green' | 'amber' | 'red' | 'emerald' | 'orange' | 'slate'

// Full literal class strings — Tailwind scans source text, so these cannot be
// assembled from fragments at runtime.
const ACCENTS: Record<Accent, string> = {
  blue: 'bg-blue-500/10 text-blue-400',
  green: 'bg-green-500/10 text-green-400',
  amber: 'bg-amber-500/10 text-amber-400',
  red: 'bg-red-500/10 text-red-400',
  emerald: 'bg-emerald-500/10 text-emerald-400',
  orange: 'bg-orange-500/10 text-orange-400',
  slate: 'bg-slate-500/15 text-slate-300',
}

export type StatCardProps = {
  label: string
  value: string
  icon: LucideIcon
  accent: Accent
  /** Real month-over-month movement, when the data supports deriving it. */
  trend?: Trend
  /** Shown instead of a trend where no historical baseline exists. */
  hint?: string
}

export function StatCard({ label, value, icon: Icon, accent, trend, hint }: StatCardProps) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
      <div className="flex items-start justify-between gap-3">
        <span className={'flex h-9 w-9 items-center justify-center rounded-lg ' + ACCENTS[accent]}>
          <Icon className="h-4.5 w-4.5" aria-hidden />
        </span>
        {trend ? <TrendPill trend={trend} /> : null}
      </div>

      <p className="mt-3 truncate text-2xl font-semibold tracking-tight text-white">{value}</p>
      <p className="mt-0.5 text-xs font-medium text-gray-400">{label}</p>

      {!trend && hint ? <p className="mt-1.5 text-[11px] text-gray-600">{hint}</p> : null}
      {trend ? (
        <p className="mt-1.5 text-[11px] text-gray-600">vs last month</p>
      ) : null}
    </div>
  )
}

function TrendPill({ trend }: { trend: NonNullable<Trend> }) {
  const map = {
    up: { Icon: ArrowUpRight, cls: 'bg-green-500/10 text-green-400' },
    down: { Icon: ArrowDownRight, cls: 'bg-red-500/10 text-red-400' },
    flat: { Icon: ArrowRight, cls: 'bg-gray-700/40 text-gray-400' },
  }[trend.direction]

  return (
    <span
      className={
        'flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold ' + map.cls
      }
    >
      <map.Icon className="h-3 w-3" aria-hidden />
      {trend.direction === 'flat' ? '0%' : trend.percent.toFixed(0) + '%'}
    </span>
  )
}
