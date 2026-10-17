import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'

/**
 * The portal shell. Phone-first: a single narrow column that fills a small
 * screen, generous padding, room under the home indicator, and a FORCED LIGHT
 * theme so a phone set to dark mode cannot turn the text invisible. The staff
 * chrome is deliberately absent — a customer sees only their own account.
 */
export const metadata: Metadata = {
  title: 'My account',
  // A customer's account page is private; keep it out of search indexes.
  robots: { index: false, follow: false },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Extends under the phone's home indicator so the safe-area padding works.
  viewportFit: 'cover',
  themeColor: '#ffffff',
}

export default function PortalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-white text-neutral-900">
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pb-[calc(2rem+env(safe-area-inset-bottom))] pt-7">
        {children}
      </main>
    </div>
  )
}
