'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * A router's health and its traffic right now, drawn while the page is open.
 *
 * THE GRAPH IS BUILT HERE, NOT LOADED. Each reading is one point; the line is
 * however many readings this tab has taken, up to about six minutes. Nothing
 * is stored on the server, so opening the page starts an empty graph that
 * fills in — the same way the traffic graph in Winbox does.
 *
 * ONE REQUEST AT A TIME. The next reading is scheduled only after the last one
 * came back, so a slow router is asked less often rather than having requests
 * pile up behind each other. A hidden tab asks nothing at all.
 */

type Reading = {
  ok: true
  at: number
  cpu: number | null
  memory: number | null
  uptime: string | null
  version: string | null
  board: string | null
  voltage: number | null
  temperature: number | null
  uplink: string | null
  downBps: number | null
  upBps: number | null
}

type Failure = { ok: false; error: string }

const EVERY_MS = 5000
const KEEP = 72

function rate(bps: number | null): string {
  if (bps === null) return '—'
  if (bps >= 1e9) return (bps / 1e9).toFixed(2) + ' Gbps'
  if (bps >= 1e6) return (bps / 1e6).toFixed(1) + ' Mbps'
  if (bps >= 1e3) return (bps / 1e3).toFixed(0) + ' kbps'
  return bps.toFixed(0) + ' bps'
}

function Tile({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-gray-500">{label}</dt>
      <dd className={'mt-0.5 text-sm font-semibold tabular-nums ' + (warn ? 'text-amber-300' : 'text-white')}>
        {value}
      </dd>
    </div>
  )
}

/** Points for one line, left to right, scaled to the tallest reading on show. */
function points(values: number[], max: number, width: number, height: number): string {
  if (values.length === 0) return ''
  // Always drawn across the full KEEP slots, so the line grows from the right
  // edge instead of stretching two readings across the whole width.
  const step = width / (KEEP - 1)
  const offset = KEEP - values.length
  return values
    .map((v, i) => {
      const x = (offset + i) * step
      const y = height - (v / max) * (height - 2) - 1
      return x.toFixed(1) + ',' + y.toFixed(1)
    })
    .join(' ')
}

export function RouterLive({ tunnelId }: { tunnelId: number }) {
  const [samples, setSamples] = useState<Reading[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const uplink = useRef<string | null>(null)

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const read = async () => {
      if (stopped) return
      if (document.hidden) {
        timer = setTimeout(read, EVERY_MS)
        return
      }
      try {
        const query = uplink.current ? '?uplink=' + encodeURIComponent(uplink.current) : ''
        const res = await fetch('/api/network/routers/' + tunnelId + '/live' + query, {
          cache: 'no-store',
        })
        const body = (await res.json()) as Reading | Failure
        if (stopped) return
        if (body.ok) {
          uplink.current = body.uplink
          setProblem(null)
          setSamples((prev) => [...prev, body].slice(-KEEP))
        } else {
          setProblem(body.error)
        }
      } catch {
        if (!stopped) setProblem('Could not reach ISPMan.')
      }
      if (!stopped) timer = setTimeout(read, EVERY_MS)
    }

    read()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [tunnelId])

  const last = samples[samples.length - 1]
  const down = samples.map((s) => s.downBps ?? 0)
  const up = samples.map((s) => s.upBps ?? 0)
  const max = Math.max(...down, ...up, 1)
  const W = 300
  const H = 56

  if (!last) {
    return (
      <p className="mt-4 text-[11px] text-gray-500">
        {problem ?? 'Reading the router…'}
      </p>
    )
  }

  return (
    <div className="mt-4 space-y-4">
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="text-[10px] uppercase tracking-wider text-gray-500">
            Traffic now{last.uplink ? ' · ' + last.uplink : ''}
          </p>
          <p className="text-xs tabular-nums text-gray-300">
            <span className="text-blue-400">▼</span> {rate(last.downBps)}
            <span className="mx-2 text-gray-700">|</span>
            <span className="text-emerald-400">▲</span> {rate(last.upBps)}
          </p>
        </div>
        {last.uplink ? (
          <>
            <svg
              viewBox={'0 0 ' + W + ' ' + H}
              preserveAspectRatio="none"
              className="mt-1.5 h-14 w-full rounded bg-gray-950"
              role="img"
              aria-label={'Traffic over the last few minutes. Now ' + rate(last.downBps) + ' down, ' + rate(last.upBps) + ' up.'}
            >
              <polyline
                points={points(down, max, W, H)}
                fill="none"
                stroke="#60a5fa"
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
              />
              <polyline
                points={points(up, max, W, H)}
                fill="none"
                stroke="#34d399"
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
            <div className="mt-1 flex justify-between text-[10px] text-gray-600">
              <span>Peak on screen {rate(max)}</span>
              <span>now</span>
            </div>
          </>
        ) : (
          <p className="mt-1.5 text-[11px] text-gray-500">
            Could not tell which port this router reaches the internet through.
          </p>
        )}
      </div>

      <dl className="grid grid-cols-3 gap-3 sm:grid-cols-5">
        <Tile label="CPU" value={last.cpu === null ? '—' : last.cpu + '%'} warn={(last.cpu ?? 0) >= 85} />
        <Tile
          label="Memory"
          value={last.memory === null ? '—' : last.memory + '%'}
          warn={(last.memory ?? 0) >= 90}
        />
        <Tile
          label="Temp"
          value={last.temperature === null ? '—' : last.temperature + '°C'}
          warn={(last.temperature ?? 0) >= 70}
        />
        <Tile label="Voltage" value={last.voltage === null ? '—' : last.voltage + ' V'} />
        <Tile label="Uptime" value={last.uptime ?? '—'} />
      </dl>

      <p className="text-[10px] text-gray-600">
        {[last.board, last.version ? 'RouterOS ' + last.version : null].filter(Boolean).join(' · ')}
        {problem ? ' · last reading failed: ' + problem : ''}
      </p>
    </div>
  )
}
