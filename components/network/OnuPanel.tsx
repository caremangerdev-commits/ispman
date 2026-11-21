'use client'

import { useState } from 'react'

import { authoriseOnus } from '@/app/actions/olts'
import type { OltAuthoriseResult, OltOnu, OltPendingOnu } from '@/lib/olt/types'

/**
 * The ONU lists on an OLT's page: those waiting to be authorised, and those
 * already on.
 *
 * AUTHORISING DOES NOT ASK ANYTHING ABOUT THE ONU. One click registers it and
 * puts it on the OLT's VLAN, with the ONU itself left untagged — the setup for
 * a network whose ONUs have VLAN switched off. The only choice on the screen is
 * which VLAN, and that is remembered after the first time.
 *
 * "AUTHORISE ALL" WORKS IN SMALL BATCHES and keeps going until none are left,
 * showing the count as it falls. A whole PON port in one request would take
 * longer than a browser will wait.
 */

const th = 'py-2 pr-4 text-left text-[10px] font-medium uppercase tracking-wider text-gray-500'
const td = 'py-2 pr-4 text-xs text-gray-300'
const button =
  'rounded-md bg-blue-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-blue-500 disabled:opacity-50'

export type OnuLists = { pending: OltPendingOnu[]; onus: OltOnu[] }

export function OnuPanel({
  oltId, view, lists, loading, error, canManage, vlans, defaultVlan, onReload,
}: {
  oltId: number
  view: 'authorised' | 'offline' | 'pending'
  lists: OnuLists | null
  loading: boolean
  error: string | null
  canManage: boolean
  /** VLANs that exist on the OLT, to choose from. */
  vlans: number[]
  defaultVlan: number | null
  onReload: () => void
}) {
  const [vlan, setVlan] = useState<number | null>(defaultVlan)
  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [outcomes, setOutcomes] = useState<OltAuthoriseResult[]>([])
  const [problem, setProblem] = useState<string | null>(null)

  const run = async (items: { port: string; sn: string }[] | 'all', label: string) => {
    if (!vlan) {
      setProblem('Choose the VLAN to put them on first.')
      return
    }
    setBusy(label)
    setProblem(null)
    setOutcomes([])
    const all: OltAuthoriseResult[] = []
    try {
      // Keep asking while there is work left and the last round achieved
      // something. If a round authorises nothing, stop: repeating it would
      // only fail the same way again.
      for (let round = 0; round < 40; round += 1) {
        const res = await authoriseOnus({ oltId, vlan, items })
        if (!res.ok) {
          setProblem(res.error)
          break
        }
        all.push(...res.results)
        setOutcomes([...all])
        const worked = res.results.filter((r) => r.ok).length
        if (items !== 'all' || res.remaining === 0 || worked === 0) break
        setProgress(res.remaining + ' still to do…')
      }
    } finally {
      setBusy(null)
      setProgress(null)
      onReload()
    }
  }

  if (loading && !lists) return <p className="px-1 py-6 text-sm text-gray-500">Reading the OLT…</p>
  if (error && !lists) {
    return (
      <div className="px-1 py-4">
        <p className="rounded-lg bg-red-950/30 px-3 py-2 text-xs text-red-300">{error}</p>
        <button type="button" onClick={onReload} className={button + ' mt-3'}>Try again</button>
      </div>
    )
  }
  if (!lists) return null

  const failed = outcomes.filter((o) => !o.ok)
  const succeeded = outcomes.filter((o) => o.ok)

  if (view === 'pending') {
    return (
      <div className="py-2">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
          <label className="flex items-center gap-2 text-xs text-gray-400">
            Put them on VLAN
            {vlans.length ? (
              <select
                value={vlan ?? ''}
                onChange={(e) => setVlan(Number(e.target.value) || null)}
                className="rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-100"
              >
                <option value="">Choose…</option>
                {vlans.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            ) : (
              <input
                type="number"
                min={1}
                max={4094}
                value={vlan ?? ''}
                onChange={(e) => setVlan(Number(e.target.value) || null)}
                className="w-20 rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-100"
              />
            )}
          </label>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onReload} disabled={loading || !!busy} className={button + ' bg-gray-700 hover:bg-gray-600'}>
              {loading ? 'Reading…' : 'Look again'}
            </button>
            {canManage && lists.pending.length > 0 ? (
              <button type="button" onClick={() => run('all', 'all')} disabled={!!busy} className={button}>
                {busy === 'all' ? progress ?? 'Authorizing…' : 'Authorize all (' + lists.pending.length + ')'}
              </button>
            ) : null}
          </div>
        </div>

        {problem ? <p className="mb-3 rounded-lg bg-red-950/30 px-3 py-2 text-xs text-red-300">{problem}</p> : null}
        {succeeded.length ? (
          <p className="mb-3 rounded-lg bg-emerald-950/40 px-3 py-2 text-xs text-emerald-300">
            {succeeded.length} authorized: {succeeded.map((o) => o.sn).join(', ')}
          </p>
        ) : null}
        {failed.map((o) => (
          <p key={o.sn} className="mb-2 rounded-lg bg-red-950/30 px-3 py-2 text-xs text-red-300">
            {o.sn}: {o.error}
          </p>
        ))}

        {lists.pending.length === 0 ? (
          <p className="px-1 py-6 text-sm text-gray-500">
            No ONUs are waiting. A new ONU appears here within a few seconds of being plugged into
            a working PON port.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className={th}>PON port</th>
                  <th className={th}>Serial number</th>
                  <th className={th}>Model</th>
                  <th className={th}></th>
                </tr>
              </thead>
              <tbody>
                {lists.pending.map((p) => (
                  <tr key={p.port + p.sn} className="border-t border-gray-800">
                    <td className={td + ' font-mono'}>{p.port}</td>
                    <td className={td + ' font-mono'}>{p.sn}</td>
                    <td className={td}>{p.model ?? '—'}</td>
                    <td className={td + ' text-right'}>
                      {canManage ? (
                        <button
                          type="button"
                          onClick={() => run([{ port: p.port, sn: p.sn }], p.sn)}
                          disabled={!!busy}
                          className={button}
                        >
                          {busy === p.sn ? 'Authorizing…' : 'Authorize'}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="pt-3 text-[11px] leading-relaxed text-gray-500">
          Authorizing registers the ONU and carries its traffic on the VLAN above inside the OLT.
          Nothing is set on the ONU itself, so it works with VLAN switched off.
        </p>
      </div>
    )
  }

  const shown = view === 'offline' ? lists.onus.filter((o) => !o.online) : lists.onus
  return (
    <div className="py-2">
      <div className="flex items-center justify-between pb-3">
        <p className="text-xs text-gray-500">
          {view === 'offline'
            ? shown.length + ' of ' + lists.onus.length + ' authorized ONUs are not in service'
            : lists.onus.filter((o) => o.online).length + ' of ' + lists.onus.length + ' online'}
        </p>
        <button type="button" onClick={onReload} disabled={loading} className={button + ' bg-gray-700 hover:bg-gray-600'}>
          {loading ? 'Reading…' : 'Look again'}
        </button>
      </div>
      {shown.length === 0 ? (
        <p className="px-1 py-6 text-sm text-gray-500">
          {view === 'offline' ? 'No authorized ONUs are offline.' : 'No ONUs have been authorized on this OLT yet.'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className={th}>ONU</th>
                <th className={th}>Serial number</th>
                <th className={th}>Type</th>
                <th className={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((o) => (
                <tr key={o.id} className="border-t border-gray-800">
                  <td className={td + ' font-mono'}>{o.id}</td>
                  <td className={td + ' font-mono'}>{o.sn ?? '—'}</td>
                  <td className={td}>{o.type ?? '—'}</td>
                  <td className={td + (o.online ? ' text-green-400' : ' text-red-400')}>
                    {o.online ? 'Online' : 'Offline (' + o.phase + ')'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
