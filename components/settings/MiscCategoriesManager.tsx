'use client'

import { Pencil, Plus, Trash2, X } from 'lucide-react'
import { useActionState, useEffect, useState } from 'react'
import { useFormStatus } from 'react-dom'

import { deleteMiscCategory, saveMiscCategory, type CatalogResult } from '@/app/actions/catalog'
import { settingsInput } from '@/components/settings/Modal'
import type { WithCount } from '@/lib/data/catalog'
import type { MiscCategory } from '@/lib/types'

type Row = WithCount<MiscCategory>

function SaveButton({ label }: { label: string }) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-60"
    >
      {pending ? 'Saving…' : label}
    </button>
  )
}

function CategoryForm({
  category,
  onDone,
  inline,
}: {
  category: Row | null
  onDone: () => void
  inline?: boolean
}) {
  const [state, action] = useActionState<CatalogResult | null, FormData>(saveMiscCategory, null)

  // Closes after the commit. Calling onDone() during render updated the parent
  // while this component was still rendering, which React does not guarantee.
  // The action state is a fresh object per submission, so this fires once per
  // result.
  useEffect(() => {
    if (state?.ok) onDone()
  }, [state, onDone])

  return (
    <form action={action} className={inline ? 'flex flex-col gap-2 px-4 py-3' : 'space-y-3 rounded-xl border border-gray-800 bg-gray-900 p-4'}>
      {category ? <input type="hidden" name="id" value={category.id} /> : null}

      {state && !state.ok ? (
        <p role="alert" className="rounded-lg border border-red-900/60 bg-red-950/50 px-3 py-2 text-xs text-red-300">
          {state.error}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <label htmlFor={'cat-' + (category?.id ?? 'new')} className="sr-only">Category name</label>
        <input
          id={'cat-' + (category?.id ?? 'new')}
          name="name"
          required
          defaultValue={category?.name ?? ''}
          placeholder="e.g. Hospital"
          className={settingsInput}
        />
        <SaveButton label={category ? 'Save' : 'Add'} />
        <button
          type="button"
          onClick={onDone}
          className="inline-flex items-center gap-1 rounded-lg bg-gray-800 px-3.5 py-2 text-sm font-medium text-gray-300 transition hover:bg-gray-700"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
          Cancel
        </button>
      </div>
    </form>
  )
}

export function MiscCategoriesManager({ categories }: { categories: Row[] }) {
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-gray-500">
          {categories.length} {categories.length === 1 ? 'category' : 'categories'}
        </p>
        {!adding ? (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-blue-500"
          >
            <Plus className="h-4 w-4" aria-hidden />
            Add Category
          </button>
        ) : null}
      </div>

      {adding ? <CategoryForm category={null} onDone={() => setAdding(false)} /> : null}

      <div className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
        {categories.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-gray-600">No categories yet.</p>
        ) : (
          <ul className="divide-y divide-gray-800">
            {categories.map((c) => (
              <li key={c.id}>
                {editingId === c.id ? (
                  <CategoryForm category={c} onDone={() => setEditingId(null)} inline />
                ) : (
                  <div className="flex items-center gap-3 px-4 py-3">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-200">
                      {c.name}
                    </span>
                    <span className="shrink-0 rounded bg-gray-800 px-2 py-0.5 text-[11px] font-medium text-gray-300">
                      {c.customerCount} {c.customerCount === 1 ? 'customer' : 'customers'}
                    </span>
                    <button
                      type="button"
                      onClick={() => setEditingId(c.id)}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md bg-gray-800 px-2 py-1 text-[11px] font-semibold text-gray-300 transition hover:bg-gray-700"
                    >
                      <Pencil className="h-3 w-3" aria-hidden />
                      Edit
                    </button>
                    <form action={deleteMiscCategory} className="shrink-0">
                      <input type="hidden" name="id" value={c.id} />
                      <button
                        type="submit"
                        onClick={(e) => {
                          const warning =
                            c.customerCount > 0
                              ? 'Delete "' + c.name + '"? ' + c.customerCount +
                                ' customer(s) will have their category cleared. This cannot be undone.'
                              : 'Delete "' + c.name + '"? This cannot be undone.'
                          if (!confirm(warning)) e.preventDefault()
                        }}
                        className="inline-flex items-center gap-1 rounded-md bg-gray-800 px-2 py-1 text-[11px] font-semibold text-gray-400 transition hover:bg-red-500/20 hover:text-red-400"
                      >
                        <Trash2 className="h-3 w-3" aria-hidden />
                        Delete
                      </button>
                    </form>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
