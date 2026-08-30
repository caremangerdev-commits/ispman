import { ShieldAlert } from 'lucide-react'

/**
 * Banner shown after requirePermission() bounces someone back here.
 *
 * The permission name is echoed so an operator can tell an admin exactly what
 * they were missing, rather than reporting a generic "it said no".
 */
export function AccessDenied({ permission, role }: { permission: string; role: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-xl border border-red-900/60 bg-red-950/40 px-4 py-3"
    >
      <ShieldAlert className="mt-0.5 h-4.5 w-4.5 shrink-0 text-red-400" aria-hidden />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-red-300">Access denied</p>
        <p className="mt-0.5 text-xs text-red-300/80">
          Your role ({role}) does not have the{' '}
          <code className="font-mono">{permission}</code> permission. Ask a company
          administrator if you need access.
        </p>
      </div>
    </div>
  )
}
