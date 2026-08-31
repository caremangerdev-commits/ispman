'use client'

import { KeyRound, ShieldCheck } from 'lucide-react'
import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'

import { resetPasswordAsSuperAdmin, type CompanyResult } from '@/app/actions/platform'
import { Modal, settingsInput, StatusPill } from '@/components/settings/Modal'
import type { CompanyDetailUser } from '@/lib/data/platform'
import { ROLE_LABELS, type Role } from '@/lib/permissions'

const ROLE_STYLES: Record<string, string> = {
  super_admin: 'bg-amber-500/15 text-amber-400',
  company_admin: 'bg-blue-500/15 text-blue-400',
  manager: 'bg-violet-500/15 text-violet-400',
  csr: 'bg-emerald-500/15 text-emerald-400',
  cashier: 'bg-cyan-500/15 text-cyan-400',
  technician: 'bg-gray-600/30 text-gray-300',
}

function label(role: string | null) {
  return ROLE_LABELS[(role ?? '') as Role] ?? role ?? 'Unknown'
}

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-500 disabled:opacity-60"
    >
      {pending ? 'Resetting…' : 'Reset Password'}
    </button>
  )
}

function ResetForm({ user, onDone }: { user: CompanyDetailUser; onDone: () => void }) {
  const [state, action] = useActionState<CompanyResult | null, FormData>(
    resetPasswordAsSuperAdmin, null
  )

  const [seen, setSeen] = useState(state)
  const [done, setDone] = useState(false)
  if (state !== seen) {
    setSeen(state)
    if (state?.ok) setDone(true)
  }

  if (done) {
    return (
      <div className="space-y-4">
        <p className="rounded-lg border border-green-900/60 bg-green-950/30 px-3 py-2 text-sm text-green-300">
          Password reset for {user.email}. They can sign in with it now and change it from
          their own account menu.
        </p>
        <button
          type="button"
          onClick={onDone}
          className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-medium text-gray-300 transition hover:bg-gray-700"
        >
          Close
        </button>
      </div>
    )
  }

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="user_id" value={user.id} />

      {state && !state.ok ? (
        <p role="alert" className="rounded-lg border border-red-900/60 bg-red-950/50 px-3 py-2 text-xs text-red-300">
          {state.error}
        </p>
      ) : null}

      <p className="text-sm text-gray-400">
        {user.first_name} {user.last_name} · <span className="text-gray-500">{user.email}</span>
        <span className="mx-1.5 text-gray-700">·</span>
        {label(user.role)}
      </p>

      <p className="rounded-lg border border-amber-900/50 bg-amber-950/20 px-3 py-2 text-xs text-amber-300">
        This is a platform-level reset across tenant boundaries. It is recorded in this
        company&apos;s audit log.
      </p>

      <div className="space-y-1.5">
        <label htmlFor="sa-reset-pw" className="block text-xs font-medium text-gray-400">
          New Temporary Password
        </label>
        <input
          id="sa-reset-pw"
          name="password"
          type="text"
          minLength={8}
          autoComplete="new-password"
          className={settingsInput}
        />
        <p className="text-[11px] text-gray-600">At least 8 characters.</p>
      </div>

      <div className="flex gap-2">
        <SubmitButton />
        <button
          type="button"
          onClick={onDone}
          className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-medium text-gray-300 transition hover:bg-gray-700"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

/**
 * Every account in the company, whatever its role.
 *
 * Reset Password is the ONLY action here. No editing, no deactivating, no role
 * changes — those belong to the tenant's own Users screen, operated by someone
 * inside it. This page exists to see a company and recover access to it.
 */
export function CompanyUsers({
  users,
  currentUserId,
}: {
  users: CompanyDetailUser[]
  /** The super admin's own id — their password goes through Change Password. */
  currentUserId: number
}) {
  const [resetting, setResetting] = useState<CompanyDetailUser | null>(null)

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-[11px] uppercase tracking-wider text-gray-500">
              <th scope="col" className="px-5 py-2 font-semibold">Name</th>
              <th scope="col" className="px-5 py-2 font-semibold">Email</th>
              <th scope="col" className="px-5 py-2 font-semibold">Role</th>
              <th scope="col" className="px-5 py-2 font-semibold">Created</th>
              <th scope="col" className="px-5 py-2 font-semibold">Status</th>
              <th scope="col" className="px-5 py-2 text-right font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {users.length === 0 && (
              <tr>
                <td colSpan={6} className="px-5 py-10 text-center text-gray-600">
                  This company has no user accounts — nobody can sign in to it.
                </td>
              </tr>
            )}

            {users.map((u) => (
              <tr key={u.id} className="transition hover:bg-gray-800/40">
                <td className="px-5 py-2.5 font-medium text-gray-200">
                  {[u.first_name, u.last_name].filter(Boolean).join(' ') || '—'}
                </td>
                <td className="px-5 py-2.5 text-gray-400">{u.email}</td>
                <td className="px-5 py-2.5">
                  <span
                    className={
                      'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ' +
                      (ROLE_STYLES[u.role ?? ''] ?? 'bg-gray-600/30 text-gray-300')
                    }
                  >
                    {u.is_super_admin ? <ShieldCheck className="h-3 w-3" aria-hidden /> : null}
                    {label(u.role)}
                  </span>
                </td>
                <td className="px-5 py-2.5 text-gray-400">
                  {u.created_at
                    ? new Date(u.created_at).toLocaleDateString('en-US', {
                        day: 'numeric', month: 'short', year: 'numeric',
                      })
                    : '—'}
                </td>
                <td className="px-5 py-2.5"><StatusPill active={u.active} /></td>
                <td className="px-5 py-2.5">
                  <div className="flex items-center justify-end">
                    {u.id === currentUserId ? (
                      <span className="text-[11px] text-gray-600">Your own account</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setResetting(u)}
                        className="inline-flex items-center gap-1 rounded-md bg-gray-800 px-2 py-1 text-[11px] font-semibold text-gray-300 transition hover:bg-gray-700"
                      >
                        <KeyRound className="h-3 w-3" aria-hidden />
                        Reset Password
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {resetting ? (
        <Modal title="Reset Password" onClose={() => setResetting(null)}>
          <ResetForm user={resetting} onDone={() => setResetting(null)} />
        </Modal>
      ) : null}
    </>
  )
}
