'use client'

import { KeyRound, Plus, ShieldCheck } from 'lucide-react'
import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'

import {
  createUser, resetUserPassword, toggleUserActive, updateUser, updateUserRole,
  type UserResult,
} from '@/app/actions/users'
import { Modal, settingsInput, StatusPill } from '@/components/settings/Modal'
import { seesAdminRows, type CompanyUser } from '@/lib/data/users'
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

/**
 * Details and role in ONE dialog, but two forms and two server actions.
 *
 * They are separate posts on purpose. updateUserRole carries a stricter
 * guardrail than updateUser — no admin target may be re-roled by anyone from
 * this screen, whoever is asking — so folding role into the details write would
 * either loosen that rule or tighten the other. Keeping them apart lets a
 * company_admin correct another admin's name without also being handed the
 * ability to demote them.
 */
function EditUserForm({
  user, roles, canEditRole, onDone,
}: {
  user: CompanyUser
  roles: Role[]
  /** False for an admin target: updateUserRole rejects those for every caller. */
  canEditRole: boolean
  onDone: () => void
}) {
  const [detailState, detailAction] = useActionState<UserResult | null, FormData>(
    updateUser, null
  )
  const [roleState, roleAction] = useActionState<UserResult | null, FormData>(
    updateUserRole, null
  )

  const [seenDetail, setSeenDetail] = useState(detailState)
  if (detailState !== seenDetail) {
    setSeenDetail(detailState)
    if (detailState?.ok) onDone()
  }

  const [seenRole, setSeenRole] = useState(roleState)
  if (roleState !== seenRole) {
    setSeenRole(roleState)
    if (roleState?.ok) onDone()
  }

  const errors = detailState && !detailState.ok ? (detailState.fieldErrors ?? {}) : {}

  return (
    <div className="space-y-5">
      <form action={detailAction} className="space-y-4">
        <input type="hidden" name="id" value={user.id} />

        {detailState && !detailState.ok ? (
          <p role="alert" className="rounded-lg border border-red-900/60 bg-red-950/50 px-3 py-2 text-xs text-red-300">
            {detailState.error}
          </p>
        ) : null}

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label htmlFor="edit-first" className="block text-xs font-medium text-gray-400">
              First Name
            </label>
            <input
              id="edit-first"
              name="first_name"
              defaultValue={user.first_name ?? ''}
              className={settingsInput}
            />
            {errors.first_name ? (
              <p role="alert" className="text-xs text-red-400">{errors.first_name}</p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <label htmlFor="edit-last" className="block text-xs font-medium text-gray-400">
              Last Name
            </label>
            <input
              id="edit-last"
              name="last_name"
              defaultValue={user.last_name ?? ''}
              className={settingsInput}
            />
            {errors.last_name ? (
              <p role="alert" className="text-xs text-red-400">{errors.last_name}</p>
            ) : null}
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="edit-email" className="block text-xs font-medium text-gray-400">
            Email
          </label>
          <input
            id="edit-email"
            name="email"
            type="email"
            defaultValue={user.email}
            autoComplete="off"
            className={settingsInput}
          />
          {errors.email ? (
            <p role="alert" className="text-xs text-red-400">{errors.email}</p>
          ) : (
            <p className="text-[11px] text-gray-600">
              This is what they sign in with. Changing it updates their sign-in account too.
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <label htmlFor="edit-phone" className="block text-xs font-medium text-gray-400">
            Phone
          </label>
          <input
            id="edit-phone"
            name="phone"
            defaultValue={user.phone ?? ''}
            className={settingsInput}
          />
        </div>

        <SubmitButton label="Save Details" />
      </form>

      <div className="border-t border-gray-800 pt-5">
        {canEditRole ? (
          <form action={roleAction} className="space-y-4">
            <input type="hidden" name="id" value={user.id} />

            {roleState && !roleState.ok ? (
              <p role="alert" className="rounded-lg border border-red-900/60 bg-red-950/50 px-3 py-2 text-xs text-red-300">
                {roleState.error}
              </p>
            ) : null}

            <div className="space-y-1.5">
              <label htmlFor="edit-role" className="block text-xs font-medium text-gray-400">
                Role
              </label>
              <select
                id="edit-role"
                name="role"
                defaultValue={user.role ?? 'csr'}
                className={settingsInput}
              >
                {roles.map((r) => (
                  <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                ))}
              </select>
              <p className="text-[11px] text-gray-600">
                Admin roles are not assignable here — only a super admin can grant those.
              </p>
            </div>

            <SubmitButton label="Save Role" />
          </form>
        ) : (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-gray-400">Role</p>
            <p className="text-sm text-gray-300">{label(user.role)}</p>
            <p className="text-[11px] text-gray-600">
              An admin role cannot be changed from this screen.
            </p>
          </div>
        )}
      </div>

      <div className="border-t border-gray-800 pt-4">
        <button
          type="button"
          onClick={onDone}
          className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-medium text-gray-300 transition hover:bg-gray-700"
        >
          Close
        </button>
      </div>
    </div>
  )
}

function ResetPasswordForm({ user, onDone }: { user: CompanyUser; onDone: () => void }) {
  const [state, action] = useActionState<UserResult | null, FormData>(resetUserPassword, null)

  const [seen, setSeen] = useState(state)
  const [done, setDone] = useState(false)
  if (state !== seen) {
    setSeen(state)
    if (state?.ok) setDone(true)
  }

  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {}

  if (done) {
    return (
      <div className="space-y-4">
        <p className="rounded-lg border border-green-900/60 bg-green-950/30 px-3 py-2 text-sm text-green-300">
          Password reset for {user.email}. Share the new one with them and ask them to change
          it from their account menu.
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
      <input type="hidden" name="id" value={user.id} />

      {state && !state.ok && Object.keys(errors).length === 0 ? (
        <p role="alert" className="rounded-lg border border-red-900/60 bg-red-950/50 px-3 py-2 text-xs text-red-300">
          {state.error}
        </p>
      ) : null}

      <p className="text-sm text-gray-400">
        {user.first_name} {user.last_name} · <span className="text-gray-500">{user.email}</span>
      </p>

      <div className="space-y-1.5">
        <label htmlFor="reset-pw" className="block text-xs font-medium text-gray-400">
          New Temporary Password
        </label>
        <input
          id="reset-pw"
          name="password"
          type="text"
          minLength={8}
          autoComplete="new-password"
          className={settingsInput}
        />
        {errors.password ? (
          <p role="alert" className="text-xs text-red-400">{errors.password}</p>
        ) : (
          <p className="text-[11px] text-gray-600">
            At least 8 characters. They can change it themselves afterwards.
          </p>
        )}
      </div>

      <div className="flex gap-2">
        <SubmitButton label="Reset Password" />
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
  viewerRole,
}: {
  users: CompanyUser[]
  roles: Role[]
  currentUserId: number
  /** Admin rows are already filtered out of `users` for a non-admin caller. */
  viewerRole: Role
}) {
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<CompanyUser | null>(null)
  const [resetting, setResetting] = useState<CompanyUser | null>(null)

  const viewerIsAdmin = seesAdminRows(viewerRole)

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
                const isAdmin = u.role === 'company_admin' || u.role === 'super_admin'

                // A non-admin caller never receives an admin row at all — the
                // list is filtered server-side — so this only ever describes
                // what an ADMIN caller may do to another admin.
                //
                // Details and password reset are open to them; role and
                // deactivate are not, because updateUserRole and
                // toggleUserActive reject an admin target for every caller and
                // those guardrails are unchanged. Mirroring that split here
                // keeps the buttons honest instead of offering a click that
                // the server will refuse.
                const mayTouch = !isSelf && (!isAdmin || viewerIsAdmin)
                const mayEditRole = !isSelf && !isAdmin
                const mayDeactivate = !isSelf && !isAdmin

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
                        {isSelf ? (
                          <span className="text-[11px] text-gray-600">
                            Cannot edit yourself
                          </span>
                        ) : (
                          <>
                            {mayTouch ? (
                              <>
                                <button
                                  type="button"
                                  onClick={() => setEditing(u)}
                                  className="rounded-md bg-gray-800 px-2 py-1 text-[11px] font-semibold text-gray-300 transition hover:bg-gray-700"
                                >
                                  {mayEditRole ? 'Edit' : 'Edit Details'}
                                </button>

                                <button
                                  type="button"
                                  onClick={() => setResetting(u)}
                                  className="inline-flex items-center gap-1 rounded-md bg-gray-800 px-2 py-1 text-[11px] font-semibold text-gray-300 transition hover:bg-gray-700"
                                >
                                  <KeyRound className="h-3 w-3" aria-hidden />
                                  Reset Password
                                </button>
                              </>
                            ) : null}

                            {mayDeactivate ? (
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
                            ) : null}
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
        <Modal title="Edit User" onClose={() => setEditing(null)}>
          <EditUserForm
            user={editing}
            roles={roles}
            canEditRole={
              editing.role !== 'company_admin' && editing.role !== 'super_admin'
            }
            onDone={() => setEditing(null)}
          />
        </Modal>
      ) : null}

      {resetting ? (
        <Modal title="Reset Password" onClose={() => setResetting(null)}>
          <ResetPasswordForm user={resetting} onDone={() => setResetting(null)} />
        </Modal>
      ) : null}
    </div>
  )
}
