/**
 * What counts as weak and too low for the signal an ONU receives, per OLT and
 * per PON port. Each company decides: a port with a long run or an extra
 * splitter normally sits lower, and calling every ONU on it "weak" teaches
 * people to ignore the colour.
 *
 * Kept apart from the drivers so the page can use it too.
 */
export type SignalLevels = {
  /** Below this, the reading shows as weak. dBm. */
  warn: number
  /** Below this, it shows as too low and the low-signal alert fires. dBm. */
  critical: number
  /** Ports whose levels differ from the OLT's, by port name. */
  ports?: Record<string, { warn: number; critical: number }>
}

export const DEFAULT_LEVELS: SignalLevels = { warn: -25, critical: -27 }

/** The levels for one port: its own if set, else the OLT's, else the usual. */
export function levelsFor(levels: SignalLevels | null | undefined, port: string | null | undefined): { warn: number; critical: number } {
  const base = levels ?? DEFAULT_LEVELS
  const own = port ? base.ports?.[port] : undefined
  return own ?? { warn: base.warn, critical: base.critical }
}

/** Sane levels only: dBm between -40 and -10, weak above too low. */
export function cleanLevels(raw: unknown): SignalLevels | null {
  const ok = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v <= -10 && v >= -40
  const r = raw as SignalLevels | null
  if (!r || !ok(r.warn) || !ok(r.critical) || r.critical >= r.warn) return null
  const ports: Record<string, { warn: number; critical: number }> = {}
  for (const [port, l] of Object.entries(r.ports ?? {})) {
    if (/^[\w/:-]{1,40}$/.test(port) && l && ok(l.warn) && ok(l.critical) && l.critical < l.warn) {
      ports[port] = { warn: l.warn, critical: l.critical }
    }
  }
  return { warn: r.warn, critical: r.critical, ...(Object.keys(ports).length ? { ports } : {}) }
}
