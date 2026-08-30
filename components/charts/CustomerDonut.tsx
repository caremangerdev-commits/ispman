'use client'

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'

import type { StatusSlice } from '@/lib/data/dashboard'
import { STATUS_COLOR, type CustomerStatus } from '@/lib/status'

const COLORS: Record<CustomerStatus, string> = STATUS_COLOR

export function CustomerDonut({ data }: { data: StatusSlice[] }) {
  const total = data.reduce((sum, d) => sum + d.count, 0)
  // Recharts renders nothing for an all-zero dataset; show the empty ring instead.
  const slices = total > 0 ? data.filter((d) => d.count > 0) : []

  return (
    <div>
      <div className="relative h-48 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="count"
              nameKey="label"
              innerRadius={58}
              outerRadius={82}
              paddingAngle={2}
              stroke="none"
            >
              {slices.map((s) => (
                <Cell key={s.bucket} fill={COLORS[s.bucket]} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                background: '#111827',
                border: '1px solid #1f2937',
                borderRadius: 10,
                fontSize: 12,
              }}
              labelStyle={{ color: '#f9fafb' }}
              formatter={(value, name) => [Number(value) + ' customers', String(name)]}
            />
          </PieChart>
        </ResponsiveContainer>

        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-semibold text-white">{total}</span>
          <span className="text-[11px] text-gray-500">Total</span>
        </div>
      </div>

      <ul className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2">
        {data.map((s) => (
          <li key={s.bucket} className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ background: COLORS[s.bucket] }}
              aria-hidden
            />
            <span className="flex-1 truncate text-xs text-gray-400">{s.label}</span>
            <span className="text-xs font-semibold text-gray-200">{s.count}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
