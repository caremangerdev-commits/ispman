/**
 * A small drawing of each kind of device.
 *
 * DRAWN HERE, NOT PHOTOGRAPHS. A manufacturer's product photo is theirs, and a
 * page full of other companies' pictures is not ours to publish. These are
 * plain outlines of what each kind of device looks like — a rack chassis with
 * card slots for an OLT, a dish for a customer radio — so a row can be told
 * apart at a glance without borrowing anyone's image.
 *
 * Decorative: every place one appears also says the type in words.
 */

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

function Shape({ kind }: { kind: string }) {
  switch (kind) {
    case 'olt':
      // A rack chassis: card slots across the front, each with a row of ports.
      return (
        <>
          <rect x="3" y="9" width="42" height="30" rx="2.5" {...stroke} />
          <path d="M13 9v30M23 9v30M33 9v30" {...stroke} />
          <path d="M8 15h0M8 20h0M8 25h0M8 30h0M18 15h0M18 20h0M18 25h0M18 30h0M28 15h0M28 20h0M28 25h0M38 15h0M38 20h0" {...stroke} strokeWidth={2.6} />
          <path d="M36 32h5" {...stroke} />
        </>
      )
    case 'onu':
      // A small box with one fibre in and a couple of lights.
      return (
        <>
          <rect x="9" y="18" width="30" height="16" rx="3" {...stroke} />
          <path d="M15 26h0M21 26h0M27 26h0" {...stroke} strokeWidth={2.6} />
          <path d="M39 26c4 0 4-9 7-9" {...stroke} />
          <path d="M14 34v3M34 34v3" {...stroke} />
        </>
      )
    case 'router':
      // A flat box with ports along the front and an arrow pair for routing.
      return (
        <>
          <rect x="5" y="20" width="38" height="14" rx="2.5" {...stroke} />
          <path d="M11 29h0M16 29h0M21 29h0M26 29h0" {...stroke} strokeWidth={2.6} />
          <path d="M32 27h7M36 24l3 3-3 3" {...stroke} />
          <path d="M16 20v-6M32 20v-6" {...stroke} />
        </>
      )
    case 'switch':
      // A wide, thin box: two rows of ports.
      return (
        <>
          <rect x="3" y="17" width="42" height="15" rx="2.5" {...stroke} />
          <path d="M9 22h0M14 22h0M19 22h0M24 22h0M29 22h0M34 22h0M39 22h0M9 27h0M14 27h0M19 27h0M24 27h0M29 27h0M34 27h0M39 27h0" {...stroke} strokeWidth={2.4} />
        </>
      )
    case 'ap':
      // A sector antenna on a pole, with signal spreading out.
      return (
        <>
          <rect x="19" y="8" width="8" height="24" rx="2" {...stroke} />
          <path d="M23 32v10M17 42h12" {...stroke} />
          <path d="M32 14c3 3 3 9 0 12M37 10c5 6 5 14 0 20" {...stroke} />
        </>
      )
    case 'cpe':
      // A dish on a bracket, pointing up at a tower.
      return (
        <>
          <path d="M12 12c0 12 8 20 20 20" {...stroke} />
          <path d="M12 12l20 20" {...stroke} />
          <path d="M24 20l7-7" {...stroke} />
          <circle cx="32.5" cy="11.5" r="2" {...stroke} />
          <path d="M22 32v10M15 42h14" {...stroke} />
        </>
      )
    case 'backhaul':
      // Two dishes facing each other with a link between them.
      return (
        <>
          <path d="M6 14c7 0 12 5 12 12s-5 12-12 12" {...stroke} />
          <path d="M42 14c-7 0-12 5-12 12s5 12 12 12" {...stroke} />
          <path d="M20 26h8" {...stroke} strokeDasharray="1.5 3" />
          <path d="M6 14v24M42 14v24" {...stroke} />
        </>
      )
    default:
      return (
        <>
          <rect x="10" y="14" width="28" height="20" rx="3" {...stroke} />
          <path d="M18 24h12" {...stroke} />
        </>
      )
  }
}

export function DeviceIcon({ kind, className }: { kind: string; className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className ?? 'h-8 w-8 text-gray-400'} aria-hidden="true">
      <Shape kind={kind} />
    </svg>
  )
}
