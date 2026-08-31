'use client'

import { usePathname } from 'next/navigation'

import { titleForPath } from '@/lib/navigation'

/**
 * The page title in the header bar, where the breadcrumb used to sit.
 *
 * Reads the pathname rather than taking a prop so a single shared layout does
 * not have to be told which page is rendering beneath it. The title names the
 * section, never the record — a customer page reads "Customer Details" whoever
 * is open in it.
 */
export function PageTitle() {
  const pathname = usePathname()

  return (
    <h2 className="shrink-0 text-sm font-semibold text-white">
      {titleForPath(pathname)}
    </h2>
  )
}
