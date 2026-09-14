/**
 * The dashboard shell's geometry — ONE definition, shared by the three things
 * that have to agree about it.
 *
 * The sidebar's width is not a property of the sidebar. It is also the left
 * margin of `main` and the left edge of the fixed header, and those three were
 * `w-64`, `ml-64` and `left-64` written out separately in three files. Three
 * copies of one number is three chances for a collapse to move the panel and
 * leave the content where it was.
 *
 * Same reasoning as ACTING_BANNER_OFFSET in components/platform/ActingBanner.tsx:
 * chrome that pushes other chrome exports the offset rather than expecting
 * every caller to remember it.
 *
 * The classes are written out in full rather than built by interpolation —
 * Tailwind scans source text, so `lg:ml-` + width would compile to nothing.
 */

/**
 * Remembers the desktop collapse across reloads.
 *
 * A cookie rather than localStorage so the server layout can read it and render
 * the correct width on the first paint. localStorage is only readable after
 * hydration, which is a visible flash of the wrong layout on every hard load —
 * and, if the state were used during render, a hydration mismatch.
 */
export const SIDEBAR_COOKIE = 'sidebar_collapsed'

/** One year. Nothing about this is sensitive; it is a display preference. */
export const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

/**
 * Collapse is a DESKTOP-only idea.
 *
 * Below `lg` the sidebar is an off-canvas drawer, and a drawer you have
 * deliberately opened should show its labels. So every collapsed class here is
 * `lg:`-prefixed: the same DOM is a full-width labelled drawer on a phone and a
 * 4rem icon rail on a desk, with no second copy of the nav markup.
 */
export const SIDEBAR = {
  /** The panel itself. Full width on mobile always; narrow on desktop when collapsed. */
  panel: { expanded: 'w-64', collapsed: 'w-64 lg:w-16' },
  /** `main`'s left margin. Zero on mobile — the drawer floats over the content. */
  main: { expanded: 'lg:ml-64', collapsed: 'lg:ml-16' },
  /** The fixed header's left edge. Flush to 0 on mobile for the same reason. */
  header: { expanded: 'lg:left-64', collapsed: 'lg:left-16' },
  /** Applied to anything that should disappear from the rail but not the drawer. */
  labelHidden: 'lg:hidden',
} as const

/** Parses the cookie's value. The absence of the cookie means expanded. */
export function collapsedFromCookie(value: string | undefined): boolean {
  return value === '1'
}
