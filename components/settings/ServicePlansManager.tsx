'use client'

import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useActionState, useEffect, useState } from 'react'
import { useFormStatus } from 'react-dom'

import {
  deleteServicePlan, saveServicePlan, toggleServicePlan, type CatalogResult,
} from '@/app/actions/catalog'
import { Modal, settingsInput, StatusPill } from '@/components/settings/Modal'
import type { WithCount } from '@/lib/data/catalog'
import type { ServicePlan } from '@/lib/types'

type Row = WithCount<ServicePlan>

function SaveButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-60"
    >
      {pending ? 'Saving…' : 'Save Plan'}
    </button>
  )
}

function PlanForm({ plan, onDone }: { plan: Row | null; onDone: () => void }) {
  const [state, action] = useActionState<CatalogResult | null, FormData>(saveServicePlan, null)

  // Closes after the commit. Calling onDone() during render updated the parent
  // while this component was still rendering, which React does not guarantee.
  // The action state is a fresh object per submission, so this fires once per
  // result.
  useEffect(() => {
    if (state?.ok) onDone()
  }, [state, onDone])

  return (
    <form action={action} className="space-y-4">
      {plan ? <input type="hidden" name="id" value={plan.id} /> : null}

      {state && !state.ok ? (
        <p role="alert" className="rounded-lg border border-red-900/60 bg-red-950/50 px-3 py-2 text-xs text-red-300">
          {state.error}
        </p>
      ) : null}

      <div className="space-y-1.5">
        <label htmlFor="plan-name" className="block text-xs font-medium text-gray-400">Name</label>
        <input id="plan-name" name="name" required defaultValue={plan?.name ?? ''} className={settingsInput} />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <label htmlFor="plan-down" className="block text-xs font-medium text-gray-400">Download Mbps</label>
          <input id="plan-down" name="speed_down_mbps" type="number" min="1" required defaultValue={plan?.speed_down_mbps ?? ''} className={settingsInput} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="plan-up" className="block text-xs font-medium text-gray-400">Upload Mbps</label>
          <input id="plan-up" name="speed_up_mbps" type="number" min="1" required defaultValue={plan?.speed_up_mbps ?? ''} className={settingsInput} />
        </div>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="plan-price" className="block text-xs font-medium text-gray-400">Monthly Price</label>
        <input id="plan-price" name="monthly_price" type="number" min="0" step="1" required defaultValue={plan ? Number(plan.monthly_price) : ''} className={settingsInput} />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="plan-desc" className="block text-xs font-medium text-gray-400">Description</label>
        <input id="plan-desc" name="description" defaultValue={plan?.description ?? ''} className={settingsInput} />
      </div>

      <div className="flex gap-2">
        <SaveButton />
        <button type="button" onClick={onDone} className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-medium text-gray-300 transition hover:bg-gray-700">
          Cancel
        </button>
      </div>
    </form>
  )
}

export function ServicePlansManager({
  plans,
  currency,
}: {
  plans: Row[]
  currency: string
}) {
  const [editing, setEditing] = useState<Row | null>(null)
  const [adding, setAdding] = useState(false)

  const money = (v: number | string) =>
    currency + ' ' + new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(v))

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-gray-500">
          {plans.length} {plans.length === 1 ? 'plan' : 'plans'}, cheapest first
        </p>
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-blue-500"
        >
          <Plus className="h-4 w-4" aria-hidden />
          Add Plan
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-[11px] uppercase tracking-wider text-gray-500">
                <th scope="col" className="px-4 py-2.5 font-semibold">Name</th>
                <th scope="col" className="px-4 py-2.5 text-right font-semibold">Download</th>
                <th scope="col" className="px-4 py-2.5 text-right font-semibold">Upload</th>
                <th scope="col" className="px-4 py-2.5 text-right font-semibold">Monthly Price</th>
                <th scope="col" className="px-4 py-2.5 text-right font-semibold">Customers</th>
                <th scope="col" className="px-4 py-2.5 font-semibold">Status</th>
                <th scope="col" className="px-4 py-2.5 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {plans.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-gray-600">
                    No service plans yet.
                  </td>
                </tr>
              ) : null}

              {plans.map((p) => {
                const active = (p.status ?? 'active') === 'active'
                return (
                  <tr key={p.id} className="transition hover:bg-gray-800/40">
                    <td className="px-4 py-2.5">
                      <span className="font-medium text-gray-200">{p.name}</span>
                      {p.description ? (
                        <span className="block truncate text-xs text-gray-500">{p.description}</span>
                      ) : null}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-gray-300">{p.speed_down_mbps} Mbps</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-gray-300">{p.speed_up_mbps} Mbps</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-gray-100">{money(p.monthly_price)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-gray-400">{p.customerCount}</td>
                    <td className="px-4 py-2.5"><StatusPill active={active} /></td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => setEditing(p)}
                          className="inline-flex items-center gap-1 rounded-md bg-gray-800 px-2 py-1 text-[11px] font-semibold text-gray-300 transition hover:bg-gray-700"
                        >
                          <Pencil className="h-3 w-3" aria-hidden />
                          Edit
                        </button>

                        <form action={toggleServicePlan}>
                          <input type="hidden" name="id" value={p.id} />
                          <input type="hidden" name="status" value={p.status ?? 'active'} />
                          <button
                            type="submit"
                            className="rounded-md bg-gray-800 px-2 py-1 text-[11px] font-semibold text-gray-300 transition hover:bg-gray-700"
                          >
                            {active ? 'Deactivate' : 'Activate'}
                          </button>
                        </form>

                        <form action={deleteServicePlan}>
                          <input type="hidden" name="id" value={p.id} />
                          <button
                            type="submit"
                            onClick={(e) => {
                              const warning =
                                p.customerCount > 0
                                  ? 'Delete "' + p.name + '"? ' + p.customerCount +
                                    ' customer(s) are on this plan and will be left with no plan. This cannot be undone.'
                                  : 'Delete "' + p.name + '"? This cannot be undone.'
                              if (!confirm(warning)) e.preventDefault()
                            }}
                            className="inline-flex items-center gap-1 rounded-md bg-gray-800 px-2 py-1 text-[11px] font-semibold text-gray-400 transition hover:bg-red-500/20 hover:text-red-400"
                          >
                            <Trash2 className="h-3 w-3" aria-hidden />
                            Delete
                          </button>
                        </form>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {adding ? (
        <Modal title="Add Service Plan" onClose={() => setAdding(false)}>
          <PlanForm plan={null} onDone={() => setAdding(false)} />
        </Modal>
      ) : null}

      {editing ? (
        <Modal title={'Edit ' + editing.name} onClose={() => setEditing(null)}>
          <PlanForm plan={editing} onDone={() => setEditing(null)} />
        </Modal>
      ) : null}
    </div>
  )
}
