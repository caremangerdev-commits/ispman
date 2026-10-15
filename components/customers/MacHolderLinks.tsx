import Link from 'next/link'

import type { MacHolder } from '@/lib/data/mac-holders'

/**
 * "Already used by #2358 Dena Chambers." with each holder a link to their
 * record — so the person refused a MAC can see by whom without searching.
 * Shared by the add form and the customer page's edit form.
 */
export function MacHolderLinks({ holders }: { holders: MacHolder[] }) {
  return (
    <>
      Already used by{' '}
      {holders.map((h, i) => (
        <span key={h.id}>
          {i > 0 ? (i === holders.length - 1 ? ' and ' : ', ') : null}
          <Link href={'/dashboard/customers/' + h.id} className="font-medium underline hover:text-red-300">
            {'#' + h.id + ' ' + h.name}
          </Link>
        </span>
      ))}
      .
    </>
  )
}
