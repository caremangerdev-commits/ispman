'use client'

import { Plus, ShieldCheck } from 'lucide-react'
import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'

import { createUser, toggleUserActive, updateUserRole, type UserResult } from '@/app/actions/users'
import { Modal, settingsInput, StatusPill } from '@/components/settings/Modal'
import type { CompanyUser } from '@/lib/data/users'
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

function SubmitButton({ label: text }: { label: string }) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-60"
    >
      {pending ? 'Saving…' : text}
    </button>
  )
}

function AddUserForm({ roles, onDone }: { roles: Role[]; onDone: () => void }) {
  const [state, action] = useActionState<UserResult | null, FormData>(createUser, null)

  const [seen, setSeen] = useState(state)
  if (state !== seen) {
    setSeen(state)
    if (state?.ok) onDone()
  }

  return (
    <form action={action} className="space-y-4">
      {state && !state.ok ? (
        <p role="alert" className="rounded-lg border border-red-900/60 bg-red-950/50 px-3 py-2 text-xs text-red-300">
          {state.error}
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <label htmlFor="u-first" className="block text-xs font-medium text-gray-400">First Name</label>
          <input id="u-first" name="first_name" required className={settingsInput} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="u-last" className="block text-xs font-medium text-gray-400">Last Name</label>
          <input id="u-last" name="last_name" required className={settingsInput} />
        </div>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="u-email" className="block text-xs font-medium text-gray-400">Email</label>
        <input id="u-email" name="email" type="email" required autoComplete="off" className={settingsInput} />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="u-role" className="block text-xs font-medium text-gray-400">Role</label>
        <select id="u-role" name="role" defaultValue="csr" className={settingsInput}>
          {roles.map((r) => (
            <option key={r} value={r}>{ROLE_LABELS[r]}</option>
          ))}
        </select>
        <p className="text-[11px] text-gray-600">
          Admin roles are not assignable here — only a super admin can grant those.
        </p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="u-pw" className="block text-xs font-medium text-gray-400">Temporary Password</label>
        <input id="u-pw" name="password" type="text" required minLength={8} autoComplete="new-password" className={settingsInput} />
        <p className="text-[11px] text-gray-600">
          At least 8 characters. Share it with them and ask them to change it.
        </p>
      </div>

      <div className="flex gap-2">
        <SubmitButton label="Create User" />
        <button type="button" onClick={onDone} className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-medium text-gray-300 transition hover:bg-gray-700">
          Cancel
        </button>
      </div>
    </form>
  )
}

function EditRoleForm({
  user, roles, onDone,
}: {
  user: CompanyUser
  roles: Role[]
  onDone: () => void
}) {
  const [state, action] = useActionState<UserResult | null, FormData>(updateUserRole, null)

  const [seen, setSeen] = useState(state)
  if (state !== seen) {
    setSeen(state)
    if (state?.ok) onDone()
  }

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="id" value={user.id} />

      {state && !state.ok ? (
        <p role="alert" className="rounded-lg border border-red-900/60 bg-red-950/50 px-3 py-2 text-xs text-red-300">
          {state.error}
        </p>
      ) : null}

      <p className="text-sm text-gray-400">
        {user.first_name} {user.last_name} · <span className="text-gray-500">{user.email}</span>
      </p>

      <div className="space-y-1.5">
        <label htmlFor="edit-role" className="block text-xs font-medium text-gray-400">Role</label>
        <select id="edit-role" name="role" defaultValue={user.role ?? 'csr'} className={settingsInput}>
          {roles.map((r) => (
            <option key={r} value={r}>{ROLE_LABELS[r]}</option>
          ))}
        </select>
        <p className="text-[11px] text-gray-600">Email cannot be changed here.</p>
      </div>

      <div className="flex gap-2">
        <SubmitButton label="Save Role" />
        <button type="button" onClick={onDone} className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-medium text-gray-300 transition hover:bg-gray-700">
          Cancel
        </button>
      </div>
    </form>
  )
}

export function UsersManager({
  users,
  roles,
  currentUserId,
}: {
  users: CompanyUser[]
  roles: Role[]
  currentUserId: number
}) {
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<CompanyUser | null>(null)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-gray-500">
          {users.length} {users.length === 1 ? 'user' : 'users'} in this company
        </p>
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-blue-500"
        >
          <Plus className="h-4 w-4" aria-hidden />
          Add User
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[780px] text-left text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-[11px] uppercase tracking-wider text-gray-500">
                <th scope="col" className="px-4 py-2.5 font-semibold">Name</th>
                <th scope="col" className="px-4 py-2.5 font-semibold">Email</th>
                <th scope="col" className="px-4 py-2.5 font-semibold">Role</th>
                <th scope="col" className="px-4 py-2.5 font-semibold">Created</th>
                <th scope="col" className="px-4 py-2.5 font-semibold">Status</th>
                <th scope="col" className="px-4 py-2.5 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {users.map((u) => {
                const isSelf = u.id === currentUserId
                // Admin rows are read-only here; only a super admin may touch them.
                const isAdmin = u.role === 'company_admin' || u.role === 'super_admin'
                const locked = isSelf || isAdmin

                return (
                  <tr key={u.id} className="transition hover:bg-gray-800/40">
                    <td className="px-4 py-2.5">
                      <span className="font-medium text-gray-200">
                        {[u.first_name, u.last_name].filter(Boolean).join(' ') || '—'}
                      </span>
                      {isSelf ? (
                        <span className="ml-2 rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-blue-400">
                          You
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-2.5 text-gray-400">{u.email}</td>
                    <td className="px-4 py-2.5">
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
                    <td className="px-4 py-2.5 text-gray-400">
                      {u.created_at
                        ? new Date(u.created_at).toLocaleDateString('en-US', {
                            day: 'numeric', month: 'short', year: 'numeric',
                          })
                        : '—'}
                    </td>
                    <td className="px-4 py-2.5"><StatusPill active={u.active} /></td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-1.5">
                        {locked ? (
                          <span className="text-[11px] text-gray-600">
                            {isSelf ? 'Cannot edit yourself' : 'Super admin only'}
                          </span>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => setEditing(u)}
                              className="rounded-md bg-gray-800 px-2 py-1 text-[11px] font-semibold text-gray-300 transition hover:bg-gray-700"
                            >
                              Edit Role
                            </button>
                            <form action={toggleUserActive}>
                              <input type="hidden" name="id" value={u.id} />
                              <input type="hidden" name="active" value={String(u.active)} />
                              <button
                                type="submit"
                                onClick={(e) => {
                                  if (
                                    u.active &&
                                    !confirm('Deactivate ' + u.email + '? They will not be able to sign in.')
                                  ) {
                                    e.preventDefault()
                                  }
                                }}
                                className={
                                  'rounded-md px-2 py-1 text-[11px] font-semibold transition ' +
                                  (u.active
                                    ? 'bg-gray-800 text-gray-400 hover:bg-red-500/20 hover:text-red-400'
                                    : 'bg-green-500/10 text-green-400 hover:bg-green-500/20')
                                }
                              >
                                {u.active ? 'Deactivate' : 'Activate'}
                              </button>
                            </form>
                          </>
                        )}
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
        <Modal title="Add User" onClose={() => setAdding(false)}>
          <AddUserForm roles={roles} onDone={() => setAdding(false)} />
        </Modal>
      ) : null}

      {editing ? (
        <Modal title="Edit Role" onClose={() => setEditing(null)}>
          <EditRoleForm user={editing} roles={roles} onDone={() => setEditing(null)} />
        </Modal>
      ) : null}
    </div>
  )
}
