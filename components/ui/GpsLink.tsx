import { MapPin } from 'lucide-react'

import { gpsMapUrl } from '@/lib/gps'

/**
 * Stored coordinates as a link that opens them on a map.
 *
 * Renders the placeholder rather than a dead link when there is nothing stored
 * or the stored text is not a coordinate pair — rows written before the field
 * was validated are not assumed to be well-formed.
 */
export function GpsLink({
  value,
  placeholder = '—',
}: {
  value: string | null
  placeholder?: string
}) {
  const href = gpsMapUrl(value)
  if (!href) return <span className="text-gray-500">{placeholder}</span>

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 font-mono text-xs text-blue-400 transition hover:text-blue-300"
    >
      <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {(value ?? '').trim()}
      <span className="sr-only"> (opens in Google Maps)</span>
    </a>
  )
}
