'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'

import { changePassword, type PasswordResult } from '@/app/actions/auth'
import { Modal, settingsInput } from '@/components/settings/Modal'

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-60"
    >
      {pending ? 'Saving…' : 'Change Password'}
    </button>
  )
}

function Field({
  label, htmlFor, error, hint, children,
}: {
  label: string
  htmlFor: string
  error?: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-xs font-medium text-gray-400">
        {label}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-xs text-red-400">{error}</p>
      ) : hint ? (
        <p className="text-[11px] text-gray-600">{hint}</p>
      ) : null}
    </div>
  )
}

export function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [state, action] = useActionState<PasswordResult | null, FormData>(changePassword, null)

  // Adjust during render rather than in an effect, matching the pattern in
  // UsersManager — a successful change closes the dialog.
  const [seen, setSeen] = useState(state)
  const [done, setDone] = useState(false)
  if (state !== seen) {
    setSeen(state)
    if (state?.ok) setDone(true)
  }

  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {}

  if (done) {
    return (
      <Modal title="Password Changed" onClose={onClose}>
        <div className="space-y-4">
          <p className="rounded-lg border border-green-900/60 bg-green-950/30 px-3 py-2 text-sm text-green-300">
            Your password has been changed. Use it the next time you sign in.
          </p>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-medium text-gray-300 transition hover:bg-gray-700"
          >
            Close
          </button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title="Change Password" onClose={onClose}>
      <form action={action} className="space-y-4">
        {state && !state.ok && Object.keys(errors).length === 0 ? (
          <p
            role="alert"
            className="rounded-lg border border-red-900/60 bg-red-950/50 px-3 py-2 text-xs text-red-300"
          >
            {state.error}
          </p>
        ) : null}

        <Field
          label="Current Password"
          htmlFor="current_password"
          error={errors.current_password}
        >
          <input
            id="current_password"
            name="current_password"
            type="password"
            autoComplete="current-password"
            className={settingsInput}
          />
        </Field>

        <Field
          label="New Password"
          htmlFor="new_password"
          error={errors.new_password}
          hint="At least 8 characters."
        >
          <input
            id="new_password"
            name="new_password"
            type="password"
            autoComplete="new-password"
            className={settingsInput}
          />
        </Field>

        <Field
          label="Confirm New Password"
          htmlFor="confirm_password"
          error={errors.confirm_password}
        >
          <input
            id="confirm_password"
            name="confirm_password"
            type="password"
            autoComplete="new-password"
            className={settingsInput}
          />
        </Field>

        <div className="flex gap-2">
          <SubmitButton />
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-medium text-gray-300 transition hover:bg-gray-700"
          >
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  )
}
