'use client'

import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'

import {
  deleteAdditionalService, saveAdditionalService, toggleAdditionalService,
  type CatalogResult,
} from '@/app/actions/catalog'
import { Modal, settingsInput, StatusPill } from '@/components/settings/Modal'
import type { WithCount } from '@/lib/data/catalog'
import type { AdditionalService } from '@/lib/types'

type Row = WithCount<AdditionalService>

function SaveButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-60"
    >
      {pending ? 'Saving…' : 'Save Service'}
    </button>
  )
}

function ServiceForm({ service, onDone }: { service: Row | null; onDone: () => void }) {
  const [state, action] = useActionState<CatalogResult | null, FormData>(
    saveAdditionalService, null
  )

  const [seen, setSeen] = useState(state)
  if (state !== seen) {
    setSeen(state)
    if (state?.ok) onDone()
  }

  return (
    <form action={action} className="space-y-4">
      {service ? <input type="hidden" name="id" value={service.id} /> : null}

      {state && !state.ok ? (
        <p role="alert" className="rounded-lg border border-red-900/60 bg-red-950/50 px-3 py-2 text-xs text-red-300">
          {state.error}
        </p>
      ) : null}

      <div className="space-y-1.5">
        <label htmlFor="svc-name" className="block text-xs font-medium text-gray-400">Name</label>
        <input id="svc-name" name="name" required defaultValue={service?.name ?? ''} className={settingsInput} />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="svc-price" className="block text-xs font-medium text-gray-400">Monthly Price</label>
        <input id="svc-price" name="monthly_price" type="number" min="0" step="1" required defaultValue={service ? Number(service.monthly_price) : ''} className={settingsInput} />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="svc-desc" className="block text-xs font-medium text-gray-400">Description</label>
        <input id="svc-desc" name="description" defaultValue={service?.description ?? ''} className={settingsInput} />
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

export function AdditionalServicesManager({
  services,
  currency,
}: {
  services: Row[]
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
          {services.length} {services.length === 1 ? 'service' : 'services'}
        </p>
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-blue-500"
        >
          <Plus className="h-4 w-4" aria-hidden />
          Add Service
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-[11px] uppercase tracking-wider text-gray-500">
                <th scope="col" className="px-4 py-2.5 font-semibold">Name</th>
                <th scope="col" className="px-4 py-2.5 text-right font-semibold">Monthly Price</th>
                <th scope="col" className="px-4 py-2.5 font-semibold">Description</th>
                <th scope="col" className="px-4 py-2.5 text-right font-semibold">Customers</th>
                <th scope="col" className="px-4 py-2.5 font-semibold">Status</th>
                <th scope="col" className="px-4 py-2.5 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {services.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-gray-600">
                    No additional services yet.
                  </td>
                </tr>
              ) : null}

              {services.map((s) => {
                const active = (s.status ?? 'active') === 'active'
                return (
                  <tr key={s.id} className="transition hover:bg-gray-800/40">
                    <td className="px-4 py-2.5 font-medium text-gray-200">{s.name}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-gray-100">{money(s.monthly_price)}</td>
                    <td className="px-4 py-2.5 text-gray-500">{s.description ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-gray-400">{s.customerCount}</td>
                    <td className="px-4 py-2.5"><StatusPill active={active} /></td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => setEditing(s)}
                          className="inline-flex items-center gap-1 rounded-md bg-gray-800 px-2 py-1 text-[11px] font-semibold text-gray-300 transition hover:bg-gray-700"
                        >
                          <Pencil className="h-3 w-3" aria-hidden />
                          Edit
                        </button>

                        <form action={toggleAdditionalService}>
                          <input type="hidden" name="id" value={s.id} />
                          <input type="hidden" name="status" value={s.status ?? 'active'} />
                          <button type="submit" className="rounded-md bg-gray-800 px-2 py-1 text-[11px] font-semibold text-gray-300 transition hover:bg-gray-700">
                            {active ? 'Deactivate' : 'Activate'}
                          </button>
                        </form>

                        <form action={deleteAdditionalService}>
                          <input type="hidden" name="id" value={s.id} />
                          <button
                            type="submit"
                            onClick={(e) => {
                              const warning =
                                s.customerCount > 0
                                  ? 'Delete "' + s.name + '"? ' + s.customerCount +
                                    ' customer(s) subscribe to it and will lose it. This cannot be undone.'
                                  : 'Delete "' + s.name + '"? This cannot be undone.'
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
        <Modal title="Add Additional Service" onClose={() => setAdding(false)}>
          <ServiceForm service={null} onDone={() => setAdding(false)} />
        </Modal>
      ) : null}

      {editing ? (
        <Modal title={'Edit ' + editing.name} onClose={() => setEditing(null)}>
          <ServiceForm service={editing} onDone={() => setEditing(null)} />
        </Modal>
      ) : null}
    </div>
  )
}
