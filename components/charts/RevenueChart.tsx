'use client'

import {
  CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'

import { formatCompactCurrency, formatCurrency } from '@/lib/format'
import type { RevenuePoint } from '@/lib/data/dashboard'

const RECURRING = '#3b82f6'
const COLLECTED = '#22c55e'

export function RevenueChart({ data }: { data: RevenuePoint[] }) {
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
          <XAxis
            dataKey="month"
            stroke="#6b7280"
            fontSize={12}
            tickLine={false}
            axisLine={{ stroke: '#1f2937' }}
          />
          <YAxis
            stroke="#6b7280"
            fontSize={12}
            tickLine={false}
            axisLine={false}
            tickFormatter={formatCompactCurrency}
          />
          <Tooltip
            cursor={{ stroke: '#374151', strokeWidth: 1 }}
            contentStyle={{
              background: '#111827',
              border: '1px solid #1f2937',
              borderRadius: 10,
              fontSize: 12,
            }}
            labelStyle={{ color: '#f9fafb', fontWeight: 600, marginBottom: 4 }}
            formatter={(value, name) => [formatCurrency(Number(value)), String(name)]}
          />
          {/* "Total Billed" until it was found to be nothing of the kind: it is
              the recurring value of the customer book, and no bill run feeds
              it. Renamed rather than repaired, because attributing real bills
              to their periods needs history the schema does not keep yet. */}
          <Line
            type="monotone"
            dataKey="recurring"
            name="Recurring Monthly Value"
            stroke={RECURRING}
            strokeWidth={2}
            dot={{ r: 3, fill: RECURRING, strokeWidth: 0 }}
            activeDot={{ r: 5 }}
          />
          <Line
            type="monotone"
            dataKey="collected"
            name="Total Collected"
            stroke={COLLECTED}
            strokeWidth={2}
            dot={{ r: 3, fill: COLLECTED, strokeWidth: 0 }}
            activeDot={{ r: 5 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
