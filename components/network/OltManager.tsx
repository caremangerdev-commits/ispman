'use client'

import Link from 'next/link'
import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'

import { addOlt, checkOlt, removeOlt, type OltActionResult } from '@/app/actions/olts'
import type { Olt } from '@/lib/data/olts'

/**
 * A company's OLTs: add one, see whether ISPMan can reach it, and what cards
 * it has.
 *
 * THE DOT IS ONE QUESTION: could ISPMan log in to this OLT the last time it
 * tried. Card state is shown separately underneath, because an OLT that
 * answers perfectly can still have a PON card that never started — and that
 * is the difference between "check the cable" and "check the card".
 */

export type OltRouterOption = { id: number; name: string; ready: boolean }

const input =
  'w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 ' +
  'placeholder:text-gray-600 focus:border-blue-500 focus:outline-none'
const label = 'mb-1 block text-xs font-medium text-gray-400'
const smallButton =
  'inline-flex items-center gap-1 rounded-md bg-gray-800 px-2.5 py-1 text-[11px] font-medium ' +
  'text-gray-300 hover:bg-gray-700 disabled:opacity-50'

function Submit({ children, pending, small }: { children: string; pending: string; small?: boolean }) {
  const status = useFormStatus()
  return (
    <button
      type="submit"
      disabled={status.pending}
      className={
        small
          ? smallButton
          : 'rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-60'
      }
    >
      {status.pending ? pending : children}
    </button>
  )
}

function Result({ state }: { state: OltActionResult | null }) {
  if (!state) return null
  return (
    <p
      role="status"
      className={
        'mt-2 rounded-lg px-3 py-2 text-xs leading-relaxed ' +
        (state.ok ? 'bg-emerald-950/40 text-emerald-300' : 'bg-red-950/40 text-red-300')
      }
    >
      {state.ok ? state.message : state.error}
    </p>
  )
}

/** In service, or standing by as the spare: both are a card doing its job. */
const cardFine = (status: string) => status === 'INSERVICE' || status === 'STANDBY'

function AddForm({
  routers, brands,
}: {
  routers: OltRouterOption[]
  brands: { brand: string; label: string }[]
}) {
  const [state, action] = useActionState(addOlt, null)
  const ready = routers.filter((r) => r.ready)

  if (routers.length === 0) {
    return (
      <p className="text-sm text-gray-400">
        Add a router first, under Settings → Router Tunnels. ISPMan reaches an OLT through the
        router it sits behind.
      </p>
    )
  }
  if (ready.length === 0) {
    return (
      <p className="text-sm text-gray-400">
        None of your routers has had its setup command yet. Run it on the router this OLT sits
        behind (Settings → Router Tunnels → Get setup command), then come back.
      </p>
    )
  }

  return (
    <form action={action} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="olt-name">Name</label>
          <input id="olt-name" name="name" className={input} placeholder="Main OLT" required maxLength={60} />
        </div>
        <div>
          <label className={label} htmlFor="olt-brand">Brand</label>
          <select id="olt-brand" name="brand" className={input} defaultValue={brands[0]?.brand}>
            {brands.map((b) => (
              <option key={b.brand} value={b.brand}>{b.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={label} htmlFor="olt-router">Router it sits behind</label>
          <select id="olt-router" name="tunnel_id" className={input} defaultValue={ready[0]?.id}>
            {routers.map((r) => (
              <option key={r.id} value={r.id} disabled={!r.ready}>
                {r.name}{r.ready ? '' : ' (needs its setup command)'}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={label} htmlFor="olt-ip">OLT IP address</label>
          <input id="olt-ip" name="mgmt_ip" className={input} placeholder="10.10.4.6" required inputMode="decimal" />
        </div>
        <div>
          <label className={label} htmlFor="olt-user">OLT username</label>
          <input id="olt-user" name="cli_user" className={input} autoComplete="off" required />
        </div>
        <div>
          <label className={label} htmlFor="olt-pass">OLT password</label>
          <input id="olt-pass" name="cli_password" type="password" className={input} autoComplete="new-password" required />
        </div>
        <div>
          <label className={label} htmlFor="olt-enable">Enable password (only if the OLT asks for one)</label>
          <input id="olt-enable" name="enable_password" type="password" className={input} autoComplete="new-password" />
        </div>
      </div>
      <p className="text-[11px] leading-relaxed text-gray-500">
        The router must be able to reach the OLT&apos;s address. ISPMan adds three rules to that
        router, labelled with this OLT, and removes them if you remove the OLT. Passwords are
        stored encrypted.
      </p>
      <Submit pending="Connecting…">Add OLT</Submit>
      <Result state={state} />
    </form>
  )
}

function OltRow({ olt, routerName, canManage }: { olt: Olt; routerName: string; canManage: boolean }) {
  const [checked, check] = useActionState(checkOlt, null)
  const [removed, remove] = useActionState(removeOlt, null)
  const [confirming, setConfirming] = useState(false)

  const dot = olt.ok === true ? 'bg-green-400' : olt.ok === false ? 'bg-red-500' : 'bg-gray-500'
  const status = olt.ok === true ? 'Connected' : olt.ok === false ? 'Not connected' : 'Not checked yet'
  const cards = olt.info?.cards ?? []
  const working = cards.filter((c) => cardFine(c.status)).length
  const pon = olt.info?.ponPorts ?? []
  const onus = pon.reduce((n, p) => n + (p.registered ?? 0), 0)
  const cell = 'px-4 py-3 text-xs text-gray-300'

  return (
    <>
      <tr className="border-t border-gray-800">
        <td className={cell}>
          <Link href={'/dashboard/network/olts/' + olt.id} className="font-semibold text-white hover:underline">
            {olt.name}
          </Link>
          <p className="mt-0.5 text-[11px] text-gray-500">behind {routerName}</p>
        </td>
        <td className={cell + ' font-mono'}>{olt.mgmtIp}</td>
        <td className={cell}>{olt.info?.model ?? '—'}</td>
        <td className={cell}>{olt.info?.version ?? '—'}</td>
        <td className={cell + (cards.length && working < cards.length ? ' text-amber-300' : '')}>
          {cards.length ? working + ' of ' + cards.length + ' working' : '—'}
        </td>
        <td className={cell + ' tabular-nums'}>{pon.length ? onus : '—'}</td>
        <td className={cell}>
          <span className="flex items-center gap-1.5">
            <span className={'h-2 w-2 rounded-full ' + dot} aria-hidden="true" />
            {status}
          </span>
        </td>
        <td className={cell}>
          <div className="flex flex-wrap items-center gap-1.5">
            <Link href={'/dashboard/network/olts/' + olt.id} className={smallButton}>
              View
            </Link>
            {canManage ? (
              <>
                <form action={check}>
                  <input type="hidden" name="id" value={olt.id} />
                  <Submit small pending="Reading…">Refresh</Submit>
                </form>
                {confirming ? (
                  <form action={remove} className="flex items-center gap-1.5">
                    <input type="hidden" name="id" value={olt.id} />
                    <Submit small pending="Removing…">Yes, remove</Submit>
                    <button type="button" onClick={() => setConfirming(false)} className={smallButton}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <button type="button" onClick={() => setConfirming(true)} className={smallButton}>
                    Remove
                  </button>
                )}
              </>
            ) : null}
          </div>
        </td>
      </tr>
      {(olt.ok === false && olt.error) || checked || removed ? (
        <tr>
          <td colSpan={8} className="px-4 pb-3">
            {olt.ok === false && olt.error && !checked ? (
              <p className="rounded-lg bg-red-950/30 px-3 py-2 text-xs text-red-300">{olt.error}</p>
            ) : null}
            <Result state={checked} />
            <Result state={removed} />
          </td>
        </tr>
      ) : null}
    </>
  )
}

export function OltManager({
  olts, routers, brands, canManage,
}: {
  olts: Olt[]
  routers: OltRouterOption[]
  brands: { brand: string; label: string }[]
  canManage: boolean
}) {
  const nameOf = (id: number) => routers.find((r) => r.id === id)?.name ?? 'a removed router'

  return (
    <div className="max-w-6xl space-y-6">
      <p className="text-sm text-gray-500">
        The OLTs on your network, whether ISPMan can reach each one, and the cards inside it.
      </p>

      <div className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
        {olts.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-gray-600">No OLTs yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-gray-500">
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">IP address</th>
                  <th className="px-4 py-2 font-medium">Model</th>
                  <th className="px-4 py-2 font-medium">Software</th>
                  <th className="px-4 py-2 font-medium">Cards</th>
                  <th className="px-4 py-2 font-medium">ONUs</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {olts.map((o) => (
                  <OltRow key={o.id} olt={o} routerName={nameOf(o.tunnelId)} canManage={canManage} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {canManage ? (
        <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
          <h2 className="mb-4 text-sm font-semibold text-white">Add an OLT</h2>
          <AddForm routers={routers} brands={brands} />
        </section>
      ) : null}
    </div>
  )
}
