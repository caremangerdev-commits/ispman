'use client'

import { useFormStatus } from 'react-dom'

/**
 * The pieces the two company settings forms share — General Settings and
 * Billing — so a Save button or a toggle cannot drift between them.
 */

export function SaveButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-60"
    >
      {pending ? 'Saving…' : 'Save Settings'}
    </button>
  )
}

export function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
      <h2 className="mb-4 text-sm font-semibold text-white">{title}</h2>
      <div className="space-y-4">{children}</div>
    </section>
  )
}

export function Field({
  label, htmlFor, hint, children,
}: {
  label: string
  htmlFor: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-xs font-medium text-gray-400">{label}</label>
      {children}
      {hint ? <p className="text-[11px] text-gray-600">{hint}</p> : null}
    </div>
  )
}

/** On/off switch backed by a hidden input so it posts with the form. */
export function Toggle({
  name, label, checked, onChange, disabled,
}: {
  name: string
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs font-medium text-gray-400">{label}</span>
      <input type="hidden" name={name} value={String(checked)} />
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={
          'relative h-6 w-11 shrink-0 rounded-full transition disabled:cursor-not-allowed disabled:opacity-50 ' +
          (checked ? 'bg-blue-600' : 'bg-gray-700')
        }
      >
        <span
          className={
            'absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ' +
            (checked ? 'left-[22px]' : 'left-0.5')
          }
        />
      </button>
    </div>
  )
}
