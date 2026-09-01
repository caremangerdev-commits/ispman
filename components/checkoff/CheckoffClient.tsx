'use client'

import { AlertTriangle, Check, Users } from 'lucide-react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useState } from 'react'
import { useFormStatus } from 'react-dom'

import { confirmCheckoff, confirmCheckoffAll } from '@/app/actions/checkoff'
import { Modal } from '@/components/settings/Modal'
import {
  PAYMENT_METHOD_LABELS, type AgentOption, type AllAgentsRow, type CollectionSummary,
} from '@/lib/data/checkoff'
import { currencySymbol } from '@/lib/format'
import { ROLE_LABELS } from '@/lib/permissions'

const fmt = (n: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n)

function SubmitButton({ label, busy }: { label: string; busy: string }) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? busy : label}
    </button>
  )
}

/**
 * Reconciliation field shared by both modals: the manager types what they
 * physically counted, and the difference against the system figure is shown
 * before they can commit.
 */
function AmountReceived({
  systemTotal,
  customers,
  symbol,
}: {
  systemTotal: number
  customers: number
  symbol: string
}) {
  const [received, setReceived] = useState(String(systemTotal))

  const parsed = Number(received)
  const valid = received !== '' && Number.isFinite(parsed)
  const diff = valid ? parsed - systemTotal : 0
  const matches = valid && Math.abs(diff) < 0.005

  return (
    <>
      <div className="space-y-2 rounded-lg border border-gray-800 bg-gray-950/60 px-3 py-2.5 text-sm">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs text-gray-500">System Total</span>
          <span className="font-semibold tabular-nums text-white">
            {symbol}{fmt(systemTotal)}
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs text-gray-500">Customers</span>
          <span className="tabular-nums text-gray-300">{customers}</span>
        </div>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="amount_received" className="block text-xs font-medium text-gray-400">
          Amount Received
        </label>
        <div className="relative">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-500">
            {symbol}
          </span>
          <input
            id="amount_received"
            name="amount_received"
            type="number"
            min="0"
            step="0.01"
            required
            value={received}
            onChange={(e) => setReceived(e.target.value)}
            className="w-full rounded-lg border border-gray-700 bg-gray-800 py-2 pl-10 pr-3 text-sm text-white outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30"
          />
        </div>
      </div>

      {valid ? (
        matches ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-green-900/50 bg-green-950/30 px-3 py-2 text-sm text-green-400">
            <Check className="h-4 w-4 shrink-0" aria-hidden />
            Amounts match
          </p>
        ) : (
          <div className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
            <p className="flex items-center gap-1.5 font-semibold">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
              Discrepancy of {symbol}{fmt(Math.abs(diff))}
              <span className="font-normal text-red-400/80">
                ({diff > 0 ? 'over' : 'short'})
              </span>
            </p>
            <p className="mt-0.5 text-xs text-red-300/80">
              System shows {symbol}{fmt(systemTotal)} but {symbol}{fmt(parsed)} was received.
            </p>
          </div>
        )
      ) : null}

      <div className="space-y-1.5">
        <label htmlFor="notes" className="block text-xs font-medium text-gray-400">
          Notes (optional)
        </label>
        <textarea
          id="notes"
          name="notes"
          rows={2}
          className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30"
        />
      </div>
    </>
  )
}

export function CheckoffClient({
  agents,
  selectedAgent,
  summary,
  allAgents,
  currency,
  timezone,
}: {
  agents: AgentOption[]
  selectedAgent: AgentOption | null
  summary: CollectionSummary | null
  allAgents: { rows: AllAgentsRow[]; total: number; customers: number }
  currency: string
  timezone: string
}) {
  const router = useRouter()
  const params = useSearchParams()
  const [confirming, setConfirming] = useState(false)
  const [confirmingAll, setConfirmingAll] = useState(false)

  const symbol = currencySymbol(currency)

  function selectAgent(id: string) {
    const next = new URLSearchParams(params.toString())
    if (id) next.set('agent', id)
    else next.delete('agent')
    router.push('/dashboard/checkoff' + (next.toString() ? '?' + next.toString() : ''))
  }

  const stamp = (iso: string) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date(iso))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-500">
          {allAgents.rows.length === 0
            ? 'Nothing outstanding'
            : allAgents.rows.length + ' agent(s) holding ' + symbol + fmt(allAgents.total)}
        </p>

        <button
          type="button"
          onClick={() => setConfirmingAll(true)}
          disabled={allAgents.rows.length === 0}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Users className="h-4 w-4" aria-hidden />
          Checkoff All Agents
        </button>
      </div>

      {/* Agent selector */}
      <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <label htmlFor="agent" className="block text-xs font-medium text-gray-400">
          Agent
        </label>
        <select
          id="agent"
          value={selectedAgent ? String(selectedAgent.id) : ''}
          onChange={(e) => selectAgent(e.target.value)}
          className="mt-1.5 w-full max-w-md rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30"
        >
          <option value="">Select an agent...</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} — {ROLE_LABELS[a.role]}
            </option>
          ))}
        </select>
      </section>

      {/* Agent summary */}
      {selectedAgent && summary ? (
        <section className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
          <header className="flex flex-wrap items-center gap-2 border-b border-gray-800 px-5 py-3">
            <h2 className="text-sm font-semibold text-white">{selectedAgent.name}</h2>
            <span className="rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-400">
              {ROLE_LABELS[selectedAgent.role]}
            </span>
          </header>

          <div className="grid gap-3 p-5 sm:grid-cols-4">
            <Stat label="Total Since Checkoff" value={symbol + fmt(summary.sinceCheckoffTotal)} accent />
            <Stat label="Total Today" value={symbol + fmt(summary.todayTotal)} />
            <Stat label="Customers Since Checkoff" value={String(summary.sinceCheckoffCustomers)} />
            <Stat label="Customers Today" value={String(summary.todayCustomers)} />
          </div>

          {summary.byMethod.length > 0 ? (
            <div className="border-t border-gray-800 px-5 py-4">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
                Breakdown by payment method
              </h3>
              <dl className="space-y-1.5 text-sm">
                {summary.byMethod.map((m) => (
                  <div key={m.method} className="flex items-baseline justify-between gap-3">
                    <dt className="text-gray-300">{PAYMENT_METHOD_LABELS[m.method]}</dt>
                    <dd className="tabular-nums text-gray-200">
                      {symbol}{fmt(m.total)}
                      <span className="ml-2 text-[11px] text-gray-500">
                        ({m.count} payment{m.count === 1 ? '' : 's'})
                      </span>
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}

          <div className="border-t border-gray-800">
            {summary.payments.length === 0 ? (
              <p className="px-5 py-10 text-center text-sm text-gray-600">
                {selectedAgent.name} has nothing outstanding.
              </p>
            ) : (
              <div className="max-h-96 overflow-y-auto">
                <table className="w-full text-left text-sm">
                  <thead className="sticky top-0 bg-gray-900">
                    <tr className="border-b border-gray-800 text-[11px] uppercase tracking-wider text-gray-500">
                      <th scope="col" className="px-5 py-2 font-semibold">Customer</th>
                      <th scope="col" className="px-5 py-2 text-right font-semibold">Amount</th>
                      <th scope="col" className="px-5 py-2 font-semibold">Method</th>
                      <th scope="col" className="px-5 py-2 font-semibold">Time</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {summary.payments.map((p) => (
                      <tr key={p.id}>
                        <td className="px-5 py-2 text-gray-200">{p.customerName}</td>
                        <td className="px-5 py-2 text-right font-medium tabular-nums text-gray-100">
                          {symbol}{fmt(p.amount)}
                        </td>
                        <td className="px-5 py-2 text-gray-400">
                          {PAYMENT_METHOD_LABELS[p.method]}
                        </td>
                        <td className="px-5 py-2 text-gray-500">{stamp(p.payment_date)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {summary.payments.length > 0 ? (
            <div className="flex justify-end border-t border-gray-800 px-5 py-3">
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-500"
              >
                Confirm Checkoff
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* Single-agent modal */}
      {confirming && selectedAgent && summary ? (
        <Modal title={'Confirm Checkoff — ' + selectedAgent.name} onClose={() => setConfirming(false)}>
          <form action={confirmCheckoff} className="space-y-4">
            <input type="hidden" name="agent_id" value={selectedAgent.id} />
            <AmountReceived
              systemTotal={summary.sinceCheckoffTotal}
              customers={summary.sinceCheckoffCustomers}
              symbol={symbol}
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-semibold text-gray-300 transition hover:bg-gray-700"
              >
                Cancel
              </button>
              <SubmitButton label="Complete Checkoff" busy="Completing…" />
            </div>
          </form>
        </Modal>
      ) : null}

      {/* All-agents modal */}
      {confirmingAll ? (
        <Modal title="Checkoff All Agents" onClose={() => setConfirmingAll(false)}>
          <form action={confirmCheckoffAll} className="space-y-4">
            <div className="overflow-hidden rounded-lg border border-gray-800">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-gray-800 bg-gray-950/60 text-[11px] uppercase tracking-wider text-gray-500">
                    <th scope="col" className="px-3 py-2 font-semibold">Agent</th>
                    <th scope="col" className="px-3 py-2 text-right font-semibold">Total</th>
                    <th scope="col" className="px-3 py-2 text-right font-semibold">Customers</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {allAgents.rows.map((r) => (
                    <tr key={r.agent.id}>
                      <td className="px-3 py-2 text-gray-200">{r.agent.name}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-100">
                        {symbol}{fmt(r.total)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-400">
                        {r.customers}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <AmountReceived
              systemTotal={allAgents.total}
              customers={allAgents.customers}
              symbol={symbol}
            />

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmingAll(false)}
                className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-semibold text-gray-300 transition hover:bg-gray-700"
              >
                Cancel
              </button>
              <SubmitButton label="Complete Checkoff" busy="Completing…" />
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  )
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-950/60 px-3 py-2.5">
      <p className="text-[11px] font-medium text-gray-500">{label}</p>
      <p
        className={
          'mt-0.5 text-lg font-semibold tabular-nums tracking-tight ' +
          (accent ? 'text-emerald-400' : 'text-white')
        }
      >
        {value}
      </p>
    </div>
  )
}
