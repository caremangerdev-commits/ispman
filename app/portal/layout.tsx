import type { ReactNode } from 'react'

/**
 * The portal shell. Phone-first: a single narrow column that fills a small
 * screen, generous padding, and room under the home indicator. Desktop just
 * sees the same column centred — the afterthought, by design.
 *
 * The staff chrome (sidebar, nav) is deliberately absent: a customer sees only
 * their own account. The company is resolved per page from the subdomain the
 * proxy stamped on the request (lib/portal/context.ts).
 */
export default function PortalLayout({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-md flex-col px-5 py-8 pb-[calc(2rem+env(safe-area-inset-bottom))]">
      {children}
    </main>
  )
}
