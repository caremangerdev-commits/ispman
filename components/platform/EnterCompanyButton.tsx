import { LogIn } from 'lucide-react'

import { enterCompany } from '@/app/actions/switch'

/**
 * "Enter company" — the super admin tenant switch.
 *
 * Rendered ONLY from inside /superadmin, whose layout has already checked
 * is_super_admin. It is not a guard itself and is not relied on as one: the
 * action behind it re-checks the flag server side, and lib/session.ts re-checks
 * it on every subsequent request. Hiding the button is presentation, not
 * security.
 */
export function EnterCompanyButton({
  companyId,
  size = 'sm',
}: {
  companyId: number
  /** 'sm' for the platform table row, 'md' for the company detail header. */
  size?: 'sm' | 'md'
}) {
  const cls =
    size === 'sm'
      ? 'gap-1 px-2 py-1 text-[11px]'
      : 'gap-1.5 px-3.5 py-2 text-sm'

  return (
    <form action={enterCompany}>
      <input type="hidden" name="company_id" value={companyId} />
      <button
        type="submit"
        className={
          'inline-flex items-center rounded-md bg-amber-500/15 font-semibold ' +
          'text-amber-400 transition hover:bg-amber-500/25 ' + cls
        }
      >
        <LogIn className={size === 'sm' ? 'h-3 w-3' : 'h-4 w-4'} aria-hidden />
        Enter company
      </button>
    </form>
  )
}
