import type { Metadata, Viewport } from 'next'
import { Archivo } from 'next/font/google'
import type { ReactNode } from 'react'

import styles from '@/components/portal/portal.module.css'

/**
 * The portal root: the paper background, the system's tokens, Archivo, and a
 * FORCED LIGHT theme so a phone set to dark mode cannot turn the text
 * invisible. The staff chrome is deliberately absent — a customer sees only
 * their own account.
 *
 * NO COLUMN HERE. Each page frames itself with components/portal/PortalShell:
 * the brand band, then either the wide two-column account page or the narrow
 * phone-sized column the other pages use. A width set here would cap the
 * account page at a phone's.
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
  colorScheme: 'light',
}

const archivo = Archivo({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
})

export default function PortalLayout({ children }: { children: ReactNode }) {
  return <div className={archivo.className + ' ' + styles.root}>{children}</div>
}
