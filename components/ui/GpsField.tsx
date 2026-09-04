'use client'

import { CheckCircle2, Loader2, MapPin, TriangleAlert, X } from 'lucide-react'
import { useState } from 'react'

import {
  ACCURACY_WARN_METRES, formatAccuracy, formatGps, parseGps,
} from '@/lib/gps'

/**
 * A "latitude,longitude" input with a button that fills it from the device GPS.
 *
 * IT FILLS THE FIELD. IT NEVER SAVES. The technician sees the reading, decides
 * whether it looks right, and saves it with the rest of the form — because a
 * phone indoors or under trees can be badly wrong, and someone can tap the
 * button from the van rather than the doorstep. A value you can see before it
 * is committed is the only version of this feature worth trusting.
 *
 * Typing stays available in every failure path. A technician with location
 * blocked, or standing somewhere with no fix, can still paste coordinates out
 * of Google Maps, so nothing here ever disables the input.
 */
export function GpsField({
  name,
  id,
  existing,
  autoFocus,
}: {
  /** Form field name — the value posts with the surrounding form. */
  name: string
  id: string
  /** What is currently SAVED, so a capture can warn before replacing it. */
  existing: string | null
  autoFocus?: boolean
}) {
  const saved = (existing ?? '').trim()

  const [value, setValue] = useState(saved)
  const [locating, setLocating] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  /** Accuracy of the reading now in the field. Null once it is hand-edited. */
  const [accuracy, setAccuracy] = useState<number | null>(null)
  /** A capture held back for confirmation because it would overwrite `saved`. */
  const [pending, setPending] = useState<{ value: string; accuracy: number } | null>(null)

  // Only complained about once there is something to complain about: an empty
  // field is not an error, it is a customer whose location nobody has taken yet.
  const parsed = parseGps(value)
  const invalid = value.trim() !== '' && !parsed.ok ? parsed.error : null

  function accept(next: string, metres: number) {
    setValue(next)
    setAccuracy(metres)
    setPending(null)
    setProblem(null)
  }

  function capture() {
    setProblem(null)

    // Checked on click rather than on render: reading navigator during the
    // first render would not match the server's HTML. Geolocation needs a
    // secure context, which production (HTTPS) and localhost both are.
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setProblem(
        'This browser cannot capture a location here. It needs a secure (HTTPS) ' +
        'connection — you can still type the coordinates in by hand.'
      )
      return
    }

    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false)
        const { latitude, longitude, accuracy: metres } = position.coords
        const next = formatGps(latitude, longitude)

        // Held back rather than applied when it would replace coordinates the
        // customer already has. A wrong reading that silently overwrites a good
        // one is worse than no reading at all.
        if (saved && next !== saved) {
          setPending({ value: next, accuracy: metres })
          return
        }
        accept(next, metres)
      },
      (err) => {
        setLocating(false)
        setProblem(describeGeolocationError(err))
      },
      // High accuracy is the whole point when standing at a house. maximumAge 0
      // refuses a cached fix from wherever the phone was earlier.
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 }
    )
  }

  const loose = accuracy !== null && accuracy > ACCURACY_WARN_METRES

  return (
    <div className="space-y-1.5 text-left">
      <div className="flex items-center gap-1.5">
        <input
          id={id}
          name={name}
          value={value}
          autoFocus={autoFocus}
          onChange={(e) => {
            setValue(e.target.value)
            // The accuracy belonged to the captured reading, not to whatever
            // has been typed over it.
            setAccuracy(null)
            setProblem(null)
          }}
          placeholder="lat,lng e.g. 18.16104,-77.11877"
          aria-invalid={invalid ? true : undefined}
          aria-describedby={id + '-msg'}
          className={
            'w-full min-w-0 rounded-md border bg-gray-800 px-2 py-1 font-mono text-xs text-white ' +
            'outline-none transition placeholder:font-sans placeholder:text-gray-600 ' +
            (invalid
              ? 'border-red-700 focus:border-red-500 focus:ring-1 focus:ring-red-500/40'
              : 'border-gray-700 focus:border-blue-500 focus:ring-1 focus:ring-blue-500/40')
          }
        />
        <button
          type="button"
          onClick={capture}
          disabled={locating}
          className="inline-flex shrink-0 items-center gap-1 rounded-md bg-gray-800 px-2 py-1 text-xs font-semibold text-gray-200 transition hover:bg-gray-700 disabled:opacity-60"
        >
          {locating ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <MapPin className="h-3.5 w-3.5" aria-hidden />
          )}
          {locating ? 'Locating…' : 'Use my location'}
        </button>
      </div>

      <div id={id + '-msg'} aria-live="polite" className="space-y-1.5">
        {/* Overwrite confirmation. Both values are shown because the technician
            cannot judge the replacement without seeing what it replaces. */}
        {pending ? (
          <div className="rounded-md border border-amber-800/60 bg-amber-950/40 px-2.5 py-2">
            <p className="flex gap-1.5 text-[11px] font-semibold text-amber-300">
              <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
              This customer already has coordinates.
            </p>
            <dl className="mt-1.5 space-y-0.5 text-[11px]">
              <div className="flex justify-between gap-2">
                <dt className="text-gray-500">Saved</dt>
                <dd className="font-mono text-gray-300">{saved}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-gray-500">New reading</dt>
                <dd className="font-mono text-white">
                  {pending.value}
                  <span className="ml-1 font-sans text-gray-500">
                    {formatAccuracy(pending.accuracy)}
                  </span>
                </dd>
              </div>
            </dl>
            <div className="mt-2 flex gap-1.5">
              <button
                type="button"
                onClick={() => accept(pending.value, pending.accuracy)}
                className="rounded bg-amber-600 px-2 py-1 text-[11px] font-semibold text-white transition hover:bg-amber-500"
              >
                Replace
              </button>
              <button
                type="button"
                onClick={() => setPending(null)}
                className="inline-flex items-center gap-1 rounded bg-gray-800 px-2 py-1 text-[11px] font-semibold text-gray-300 transition hover:bg-gray-700"
              >
                <X className="h-3 w-3" aria-hidden />
                Keep existing
              </button>
            </div>
          </div>
        ) : null}

        {/* A loose fix is a warning, never a block: a rough location beats none,
            and the technician is the one who knows whether it looks right. */}
        {loose ? (
          <p className="flex gap-1.5 text-[11px] leading-snug text-amber-400">
            <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              Accurate to about {formatAccuracy(accuracy)} — this reading may be
              imprecise. You can still save it.
            </span>
          </p>
        ) : accuracy !== null ? (
          <p className="flex gap-1.5 text-[11px] text-green-400">
            <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
            Captured, accurate to {formatAccuracy(accuracy)}.
          </p>
        ) : null}

        {problem ? (
          <p role="alert" className="text-[11px] leading-snug text-amber-400">
            {problem}
          </p>
        ) : null}

        {invalid ? (
          <p role="alert" className="text-[11px] leading-snug text-red-400">
            {invalid}
          </p>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Plain language for the three failures the API reports.
 *
 * Every one of them ends by pointing back at the input, because in all three
 * cases typing the coordinates is still a perfectly good way to finish the job.
 */
function describeGeolocationError(err: GeolocationPositionError): string {
  if (err.code === err.PERMISSION_DENIED) {
    return (
      'Location access is blocked for this site. Allow it in your browser ' +
      'settings, or type the coordinates in by hand.'
    )
  }
  if (err.code === err.POSITION_UNAVAILABLE) {
    return (
      'Your device could not get a location fix. Try again outside, or type the ' +
      'coordinates in by hand.'
    )
  }
  if (err.code === err.TIMEOUT) {
    return 'Getting a location took too long. Try again, or type the coordinates in by hand.'
  }
  return 'The location could not be read. You can type the coordinates in by hand.'
}
