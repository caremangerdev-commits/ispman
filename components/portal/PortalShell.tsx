import type { ReactNode } from 'react'

import { logout } from '@/app/actions/portal'
import { brandVars, type PortalBrand } from '@/components/portal/Brand'
import styles from '@/components/portal/portal.module.css'

/**
 * Every portal page's frame: the brand band across the top, then the page on
 * the paper background. Defined once so the band — the brand colour's first
 * job — is the same on the sign-in, the account and the support pages.
 *
 *   wide    the account page: up to 1120px, two columns from 900px.
 *   narrow  everything else: one centred column of cards, phone-sized.
 *
 * `signedIn` adds "Hi, …" and Log out on the right of the band. The sign-in
 * and the walled-garden reconnect page have no session, so they show the
 * company alone.
 */
export function PortalShell({
  brand,
  signedIn = false,
  firstName = null,
  width = 'narrow',
  footer = null,
  children,
}: {
  brand: PortalBrand
  signedIn?: boolean
  firstName?: string | null
  width?: 'wide' | 'narrow'
  footer?: string | null
  children: ReactNode
}) {
  return (
    <div style={brandVars(brand.palette)}>
      <header className={styles.band}>
        <div className={styles.bandIn}>
          <BandMark brand={brand} />
          {signedIn ? (
            <div className={styles.who}>
              {firstName ? <span>Hi, {firstName}</span> : null}
              <form action={logout}>
                <button type="submit" className={styles.whoLink}>Log out</button>
              </form>
            </div>
          ) : null}
        </div>
      </header>

      <main className={width === 'wide' ? styles.wrap : styles.narrow}>
        {children}
        {footer ? <p className={styles.foot}>{footer}</p> : null}
      </main>
    </div>
  )
}

/**
 * The company on the band: its logo on a white chip (the stored logo is
 * flattened onto white, so it is shown on white rather than sitting as a white
 * box on the colour), or a badge with its initial and its name.
 */
function BandMark({ brand }: { brand: PortalBrand }) {
  if (brand.hasLogo) {
    return (
      <div className={styles.mark}>
        <span className={styles.markLogo}>
          {/* eslint-disable-next-line @next/next/no-img-element -- streamed from a private bucket via /api/portal/logo; there is no static URL for next/image */}
          <img src="/api/portal/logo" alt={brand.name} />
        </span>
      </div>
    )
  }
  const initial = (brand.name.trim()[0] ?? '').toUpperCase()
  return (
    <div className={styles.mark}>
      {initial ? <span className={styles.markBadge} aria-hidden="true">{initial}</span> : null}
      <span className={styles.markName}>{brand.name}</span>
    </div>
  )
}

/** "{Company} · {phone}", the line at the foot of a signed-in page. */
export function footerLine(name: string, phone: string | null): string | null {
  const parts = [name.trim(), (phone ?? '').trim()].filter(Boolean)
  return parts.length ? parts.join(' · ') : null
}

/**
 * A muted "‹ Back" link at the top of a narrow page. A plain <a>, not <Link>:
 * '/' is rewritten to /portal by proxy.ts, and a full navigation keeps that.
 */
export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className={styles.back}>
      <span aria-hidden="true">‹</span> {children}
    </a>
  )
}
