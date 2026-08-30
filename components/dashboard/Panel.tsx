import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import type { ReactNode } from 'react'

/** Shared card shell for the dashboard's lower panels. */
export function Panel({
  title,
  subtitle,
  href,
  linkLabel,
  children,
}: {
  title: string
  subtitle?: string
  href?: string
  linkLabel?: string
  children: ReactNode
}) {
  return (
    <section className="flex flex-col rounded-xl border border-gray-800 bg-gray-900">
      <header className="flex items-baseline justify-between gap-3 border-b border-gray-800 px-5 py-3.5">
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        {subtitle ? <p className="text-xs text-gray-500">{subtitle}</p> : null}
      </header>

      <div className="flex-1">{children}</div>

      {href && linkLabel ? (
        <footer className="border-t border-gray-800 px-5 py-2.5">
          <Link
            href={href}
            className="inline-flex items-center gap-1 text-xs font-medium text-blue-400 transition hover:text-blue-300"
          >
            {linkLabel}
            <ArrowRight className="h-3 w-3" aria-hidden />
          </Link>
        </footer>
      ) : null}
    </section>
  )
}

export function EmptyState({ message }: { message: string }) {
  return <p className="px-5 py-10 text-center text-sm text-gray-600">{message}</p>
}
