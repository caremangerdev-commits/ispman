/**
 * Signal strength as four bars with the reading beside them.
 *
 * TWO SCALES, BECAUSE THE TWO ENDS HAVE DIFFERENT LIMITS. An ONU stops working
 * when what it receives falls below about -27 dBm; the OLT's receiver is a
 * little more sensitive and holds on to about -30. The same reading is
 * therefore worse news at the ONU than at the OLT.
 *
 * The bars are never the only signal: the reading is printed, and the title
 * says in words what it means.
 */

const SCALES = {
  // What the ONU receives from the OLT.
  onu: [-27, -25, -22],
  // The ONU's light as it arrives at the OLT.
  olt: [-30, -28, -25],
} as const

const WORDS = ['Too low', 'Weak', 'Good', 'Strong']
const TONES = ['bg-red-500', 'bg-amber-400', 'bg-green-500', 'bg-green-500']
const TEXT = ['text-red-400', 'text-amber-300', 'text-gray-300', 'text-gray-300']

export function SignalBars({
  label, dbm, side, levels,
}: {
  label: string
  dbm: number | null
  side: 'onu' | 'olt'
  /** The company's own weak / too-low levels for this port (ONU side). */
  levels?: { warn: number; critical: number }
}) {
  if (dbm === null) {
    return (
      <span className="inline-flex items-center gap-1.5 text-gray-600" title={label + ': no reading'}>
        <Bars lit={0} tone="bg-gray-700" />
        <span className="text-[11px]">—</span>
      </span>
    )
  }
  const scale = side === 'onu' && levels ? [levels.critical, levels.warn, levels.warn + 3] : SCALES[side]
  const level = scale.filter((limit) => dbm >= limit).length
  return (
    <span
      className={'inline-flex items-center gap-1.5 ' + TEXT[level]}
      title={label + ': ' + dbm.toFixed(1) + ' dBm, ' + WORDS[level].toLowerCase()}
    >
      <Bars lit={level + 1} tone={TONES[level]} />
      <span className="whitespace-nowrap font-mono text-[11px]">{dbm.toFixed(1)}</span>
      <span className="sr-only">{WORDS[level]}</span>
    </span>
  )
}

function Bars({ lit, tone }: { lit: number; tone: string }) {
  return (
    <span className="inline-flex items-end gap-[2px]" aria-hidden>
      {[1, 2, 3, 4].map((n) => (
        <span
          key={n}
          className={'w-[3px] rounded-sm ' + (n <= lit ? tone : 'bg-gray-700')}
          style={{ height: 3 + n * 3 }}
        />
      ))}
    </span>
  )
}
