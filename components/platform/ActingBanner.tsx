import { ShieldAlert } from 'lucide-react'

import { exitCompany } from '@/app/actions/switch'
import type { SessionCompany } from '@/lib/session'

/**
 * The standing warning shown while a super admin is inside someone else's
 * tenant.
 *
 * Rendered from the LAYOUTS, not from any page, so it is on every screen the
 * operator can reach while switched rather than only the one they entered on.
 *
 * Deliberately not dismissible and deliberately loud: everything below it is
 * another company's live data, and every write lands in that company's audit
 * trail attributed to the platform operator. Exit is the only control.
 *
 * Fixed rather than in the flow because the dashboard's own chrome is fixed —
 * a banner that scrolled away would not be the guarantee this is meant to be.
 * Anything it sits above must be pushed down by ACTING_BANNER_HEIGHT.
 */
export const ACTING_BANNER_HEIGHT = 'h-11'

/** Tailwind offsets for chrome that has to clear the banner. */
export const ACTING_BANNER_OFFSET = {
  /** For a fixed element pinned to the top. */
  top: 'top-11',
  /** For content already clearing the 4rem navbar (4rem + 2.75rem). */
  navbarAndBanner: 'pt-[6.75rem]',
  /** For content clearing the banner alone. */
  bannerOnly: 'pt-11',
}

export function ActingBanner({ company }: { company: SessionCompany }) {
  return (
    <div
      className={
        'fixed inset-x-0 top-0 z-50 flex items-center border-b border-amber-400/40 ' +
        'bg-amber-500 px-6 text-amber-950 ' + ACTING_BANNER_HEIGHT
      }
    >
      <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden />
      <p className="ml-3 min-w-0 flex-1 truncate text-sm font-semibold">
        Viewing <span className="font-bold">{company.name}</span> as super admin
      </p>
      <form action={exitCompany} className="ml-3 shrink-0">
        <button
          type="submit"
          className="rounded-md bg-amber-950 px-3.5 py-1 text-xs font-semibold text-amber-50 transition hover:bg-amber-900"
        >
          Exit
        </button>
      </form>
    </div>
  )
}
