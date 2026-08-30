'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ChevronRight } from 'lucide-react'

/** Segment slug -> display label. Numeric segments render as the record id. */
const LABELS: Record<string, string> = {
  dashboard: 'Dashboard',
  customers: 'Customers',
  expired: 'Expired',
  overdue: 'Overdue',
  payments: 'Payments',
  checkoff: 'Checkoff',
  invoices: 'Invoices',
  infrastructure: 'Infrastructure',
  nas: 'NAS Management',
  tickets: 'Tickets',
  'knowledge-base': 'Knowledge Base',
  services: 'Services',
  settings: 'Settings',
  users: 'Users',
  profile: 'Profile',
  activity: 'Activity',
}

/**
 * Route-derived breadcrumb.
 *
 * Reads the pathname rather than taking a prop so a single shared layout does
 * not have to be told which page is rendering beneath it.
 */
export function Breadcrumb() {
  const pathname = usePathname()
  const segments = pathname.split('/').filter(Boolean)

  const crumbs = segments.map((segment, i) => ({
    // "new" means different things per section, so it is resolved against its
    // parent before falling back to the shared table.
    label:
      segment === 'new'
        ? segments[i - 1] === 'payments' ? 'Record Payment' : 'Add Customer'
        : LABELS[segment] ?? (/^\d+$/.test(segment) ? '#' + segment : segment),
    href: '/' + segments.slice(0, i + 1).join('/'),
    last: i === segments.length - 1,
  }))

  return (
    <nav aria-label="Breadcrumb" className="shrink-0">
      <ol className="flex items-center gap-1.5 text-sm">
        <li className="text-gray-500">ISPMan</li>
        {crumbs.map((c) => (
          <li key={c.href} className="flex items-center gap-1.5">
            <ChevronRight className="h-3.5 w-3.5 text-gray-600" aria-hidden />
            {c.last ? (
              <span className="font-semibold text-white" aria-current="page">
                {c.label}
              </span>
            ) : (
              <Link href={c.href} className="text-gray-500 transition hover:text-gray-300">
                {c.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}
