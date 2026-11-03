'use client'

import { Crosshair, MapPin, TriangleAlert } from 'lucide-react'
import { useState } from 'react'

/**
 * The GPS fix, taken from the phone the rep is holding.
 *
 * WHY THIS EXISTS. The address a rep writes at a gate is for a human who
 * already knows the area — "blue house past the shop", "third gate after the
 * church". An installer who has never been there cannot use it. A coordinate
 * they can put into any map can be used by anybody.
 *
 * THE FIX IS OPTIONAL AND THE FORM SAVES WITHOUT IT. GPS fails indoors, under
 * trees, in a yard between two concrete walls, and whenever the rep taps the
 * wrong thing on the browser's permission prompt. None of that is a reason to
 * lose a sale, so a refusal here never blocks the submit — it says what
 * happened and leaves the button there to try again.
 *
 * ACCURACY IS SHOWN, NOT HIDDEN. A phone with no satellite lock will happily
 * return a position derived from a cell tower, two kilometres wide, and it
 * looks exactly like a good fix unless the radius is on screen. So the radius
 * is on screen, in words, and a bad one says so.
 */

/** Below this many metres a fix is worth navigating to. */
const GOOD_M = 20
/** Above this it will not find the house, and the rep should be told plainly. */
const POOR_M = 100

type Fix = { lat: number; lng: number; accuracy: number | null }

export function LocationCapture() {
  const [fix, setFix] = useState<Fix | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function capture() {
    setError(null)

    // Not available over plain HTTP, in an old browser, or in a webview with
    // location stripped out. Say so rather than appearing to do nothing.
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setError('This phone or browser will not give a location.')
      return
    }

    setBusy(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setBusy(false)
        setFix({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
        })
      },
      (err) => {
        setBusy(false)
        // The three cases a rep can actually do something about, in their own
        // terms. The browser's own message is jargon on a phone screen.
        setError(
          err.code === err.PERMISSION_DENIED
            ? 'Location was blocked. Allow it for this site in your browser settings, then try again.'
            : err.code === err.POSITION_UNAVAILABLE
              ? 'No signal for a location here. Step into the open and try again.'
              : 'Took too long to find a location. Try again.'
        )
      },
      {
        // The whole point is the house in front of the rep, so the battery
        // cost of the real GPS is worth paying.
        enableHighAccuracy: true,
        // Long enough for a cold lock outdoors, short enough that nobody
        // stands at a gate watching a spinner.
        timeout: 20000,
        // A fix from a minute ago is the same gate. Anything older is not.
        maximumAge: 60000,
      }
    )
  }

  const quality =
    fix === null || fix.accuracy === null ? null
      : fix.accuracy <= GOOD_M ? 'good'
        : fix.accuracy <= POOR_M ? 'rough'
          : 'poor'

  return (
    <div className="space-y-2">
      {/* The hidden carriers. Named for the columns they land in, and empty
          until there is a fix — the server treats half a coordinate as none. */}
      <input type="hidden" name="latitude" value={fix ? String(fix.lat) : ''} />
      <input type="hidden" name="longitude" value={fix ? String(fix.lng) : ''} />
      <input
        type="hidden"
        name="gps_accuracy_m"
        value={fix && fix.accuracy !== null ? String(Math.round(fix.accuracy)) : ''}
      />

      <button
        type="button"
        onClick={capture}
        disabled={busy}
        // Full width and py-3.5 on purpose: this is pressed with a thumb,
        // standing up, often in sunlight.
        className={
          'flex w-full items-center justify-center gap-2 rounded-xl border-2 px-4 py-3.5 text-sm font-semibold transition disabled:opacity-60 ' +
          (fix
            ? 'border-green-800 bg-green-950/40 text-green-300 hover:bg-green-950/60'
            : 'border-blue-700 bg-blue-950/40 text-blue-200 hover:bg-blue-950/70')
        }
      >
        {busy ? (
          <>
            <Crosshair className="h-4 w-4 animate-spin" aria-hidden />
            Finding you…
          </>
        ) : fix ? (
          <>
            <MapPin className="h-4 w-4" aria-hidden />
            Location saved — tap to redo
          </>
        ) : (
          <>
            <Crosshair className="h-4 w-4" aria-hidden />
            Capture this location
          </>
        )}
      </button>

      {fix ? (
        <div className="rounded-lg border border-gray-800 bg-gray-950/60 px-3 py-2">
          <p className="font-mono text-xs text-gray-300">
            {fix.lat.toFixed(6)}, {fix.lng.toFixed(6)}
          </p>
          {quality ? (
            <p
              className={
                'mt-0.5 text-[11px] ' +
                (quality === 'good' ? 'text-green-400'
                  : quality === 'rough' ? 'text-amber-400'
                    : 'text-red-400')
              }
            >
              {quality === 'good'
                ? 'Accurate to about ' + Math.round(fix.accuracy ?? 0) + 'm. Good enough to find the house.'
                : quality === 'rough'
                  ? 'Accurate to about ' + Math.round(fix.accuracy ?? 0) + 'm. Usable, but step outside and redo it if you can.'
                  : 'Only accurate to about ' + Math.round(fix.accuracy ?? 0) + 'm — that is the whole street. Step into the open and tap again.'}
            </p>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="flex items-start gap-1.5 text-[11px] text-amber-400">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{error} You can still save without it.</span>
        </p>
      ) : null}

      {!fix && !error ? (
        <p className="text-[11px] text-gray-600">
          Optional, but it is what lets the installer find the house.
        </p>
      ) : null}
    </div>
  )
}
