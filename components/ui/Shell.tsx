'use client'

import { usePathname } from 'next/navigation'
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'

import { SIDEBAR, SIDEBAR_COOKIE, SIDEBAR_COOKIE_MAX_AGE } from '@/lib/shell'

/**
 * The dashboard shell's two pieces of layout state.
 *
 * `drawerOpen` is the mobile off-canvas sidebar. `collapsed` is the desktop
 * icon rail. They are deliberately separate: a phone drawer that opened in
 * collapsed form would be a column of unlabelled icons, and collapsing on a
 * desk should not be undone by someone having opened the drawer on a phone.
 *
 * It lives in a context rather than in the layout because three siblings need
 * it — the sidebar, the header and `main` — and the layout that renders them
 * is a server component, which cannot hold state.
 */
type ShellState = {
  drawerOpen: boolean
  setDrawerOpen: (open: boolean) => void
  collapsed: boolean
  toggleCollapsed: () => void
}

const ShellContext = createContext<ShellState | null>(null)

export function useShell(): ShellState {
  const ctx = useContext(ShellContext)
  if (!ctx) throw new Error('useShell must be used inside <ShellProvider>')
  return ctx
}

export function ShellProvider({
  defaultCollapsed,
  children,
}: {
  /** Read from the cookie by the server layout, so the first paint is correct. */
  defaultCollapsed: boolean
  children: ReactNode
}) {
  const pathname = usePathname()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(defaultCollapsed)

  // Navigating closes the drawer — otherwise tapping a nav link leaves the
  // panel covering the page it just opened.
  //
  // Adjusted during render rather than in an effect, matching CustomerSearch:
  // setting state in an effect body costs a second render pass and trips
  // react-hooks/set-state-in-effect.
  const [seenPath, setSeenPath] = useState(pathname)
  if (pathname !== seenPath) {
    setSeenPath(pathname)
    if (drawerOpen) setDrawerOpen(false)
  }

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      // Written straight from the client. A server action would be a round trip
      // for a display preference, and the value is already in React state — the
      // cookie exists only so the NEXT first paint is right.
      document.cookie =
        SIDEBAR_COOKIE + '=' + (next ? '1' : '0') +
        '; path=/; max-age=' + SIDEBAR_COOKIE_MAX_AGE + '; samesite=lax'
      return next
    })
  }, [])

  return (
    <ShellContext.Provider value={{ drawerOpen, setDrawerOpen, collapsed, toggleCollapsed }}>
      {children}
    </ShellContext.Provider>
  )
}

/**
 * The scrim behind the mobile drawer.
 *
 * Rendered unconditionally and hidden with opacity so the drawer's slide has
 * something to fade against; `pointer-events-none` keeps it from swallowing
 * taps while closed.
 */
export function DrawerBackdrop() {
  const { drawerOpen, setDrawerOpen } = useShell()

  return (
    <div
      onClick={() => setDrawerOpen(false)}
      aria-hidden
      className={
        'fixed inset-0 z-30 bg-black/60 transition-opacity duration-200 lg:hidden ' +
        (drawerOpen ? 'opacity-100' : 'pointer-events-none opacity-0')
      }
    />
  )
}

/**
 * `main`, wrapped so its left margin can follow the sidebar.
 *
 * Bottom padding clears the mobile tab bar (see MobileTabBar) — without it the
 * last row of any list sits underneath a fixed bar and cannot be tapped.
 */
export function ShellMain({
  topPadding,
  children,
}: {
  /** The layout's existing navbar/banner offset, unchanged. */
  topPadding: string
  children: ReactNode
}) {
  const { collapsed } = useShell()

  return (
    <main
      className={
        'transition-[margin] duration-200 ' +
        (collapsed ? SIDEBAR.main.collapsed : SIDEBAR.main.expanded) + ' ' + topPadding
      }
    >
      {/* p-4 on a phone, not p-6: 24px a side off a 360px screen is 13% of the
          width spent on nothing, and these pages are already tight. */}
      <div className="p-4 pb-24 lg:p-6 lg:pb-6">{children}</div>
    </main>
  )
}
