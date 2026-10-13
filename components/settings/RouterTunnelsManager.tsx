'use client'

import { Check, Copy, KeyRound, Plus, Terminal, Trash2, X } from 'lucide-react'
import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'

import {
  addRouterTunnel, revokeRouterTunnel, setRouterTunnelKey, showRouterTunnelConfig,
  type TunnelActionResult,
} from '@/app/actions/tunnels'
import { settingsInput } from '@/components/settings/Modal'
import { ROUTER_SERVICES, type ConfigBlock } from '@/lib/tunnels/wireguard'

export type TunnelStatus = 'waiting' | 'up' | 'down' | 'never' | 'not_on_server' | 'unknown'

/**
 * One router as the card shows it. Nothing secret: config is fetched on demand.
 *
 * Seen by company admins as well as the platform operator, so nothing on this
 * card names the RADIUS server's software or shows how the server is set up.
 */
export type TunnelView = {
  id: number
  name: string
  tunnelIp: string
  services: string[]
  keyPrefix: string | null
  status: TunnelStatus
  statusText: string
  createdText: string
  revokedText: string | null
}

const STATUS_CLS: Record<TunnelStatus, string> = {
  up: 'bg-emerald-500/15 text-emerald-400',
  down: 'bg-red-500/15 text-red-400',
  never: 'bg-red-500/15 text-red-400',
  not_on_server: 'bg-amber-500/15 text-amber-400',
  waiting: 'bg-blue-500/15 text-blue-400',
  unknown: 'bg-gray-800 text-gray-400',
}

const buttonCls =
  'inline-flex items-center gap-1 rounded-md bg-gray-800 px-2 py-1 text-[11px] font-semibold text-gray-300 transition hover:bg-gray-700'

function SubmitButton({
  label, pending: pendingLabel, danger, confirmText,
}: {
  label: string
  pending: string
  danger?: boolean
  /** Asked before submitting; Cancel stops the action. */
  confirmText?: string
}) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      onClick={(e) => {
        if (confirmText && !confirm(confirmText)) e.preventDefault()
      }}
      className={
        'shrink-0 rounded-lg px-3.5 py-2 text-sm font-semibold text-white transition disabled:opacity-60 ' +
        (danger ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-500')
      }
    >
      {pending ? pendingLabel : label}
    </button>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      className={buttonCls}
    >
      {copied ? <Check className="h-3 w-3" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

function Block({ block }: { block: ConfigBlock }) {
  return (
    <div className="overflow-hidden rounded-lg border border-gray-800">
      <div className="flex items-center justify-between gap-2 bg-gray-800/60 px-3 py-1.5">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-gray-300">
          <Terminal className="h-3 w-3" aria-hidden />
          {block.title}
        </span>
        <CopyButton text={block.text} />
      </div>
      <pre className="max-h-80 overflow-auto bg-gray-950 px-3 py-2 text-[11px] leading-relaxed text-gray-300">
        {block.text}
      </pre>
    </div>
  )
}

function Result({ state }: { state: TunnelActionResult | null }) {
  if (!state) return null
  if (!state.ok) {
    return (
      <p role="alert" className="rounded-lg border border-red-900/60 bg-red-950/50 px-3 py-2 text-xs text-red-300">
        {state.error}
      </p>
    )
  }
  return (
    <div className="space-y-2">
      <p className="rounded-lg border border-emerald-900/50 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-300">
        {state.message}
      </p>
      {state.blocks.map((b, i) => <Block key={i} block={b} />)}
    </div>
  )
}

function AddRouterForm({ onClose }: { onClose: () => void }) {
  const [state, action] = useActionState(addRouterTunnel, null)

  return (
    <div className="space-y-3 rounded-xl border border-gray-800 bg-gray-900 p-4">
      {state?.ok ? null : (
        <form action={action} className="space-y-3">
          <div className="flex items-center gap-2">
            <label htmlFor="tunnel-name" className="sr-only">Router name</label>
            <input
              id="tunnel-name"
              name="name"
              required
              maxLength={40}
              placeholder="Router name, e.g. Main CCR"
              className={settingsInput}
            />
            <SubmitButton label="Add router" pending="Adding…" />
          </div>
          <fieldset className="flex flex-wrap items-center gap-4">
            <legend className="sr-only">Services through the tunnel</legend>
            <span className="text-xs text-gray-500">RADIUS for:</span>
            {ROUTER_SERVICES.map((s) => (
              <label key={s.value} className="inline-flex items-center gap-1.5 text-xs text-gray-300">
                <input type="checkbox" name="services" value={s.value} defaultChecked={s.value === 'dhcp'} />
                {s.label}
              </label>
            ))}
          </fieldset>
        </form>
      )}
      <Result state={state} />
      <button type="button" onClick={onClose} className={buttonCls}>
        <X className="h-3 w-3" aria-hidden />
        {state?.ok ? 'Done' : 'Cancel'}
      </button>
    </div>
  )
}

function KeyPanel({ id, replace }: { id: number; replace: boolean }) {
  const [state, action] = useActionState(setRouterTunnelKey, null)
  return (
    <div className="space-y-2">
      {state?.ok ? null : (
        <form action={action} className="flex items-center gap-2">
          <input type="hidden" name="id" value={id} />
          {replace ? <input type="hidden" name="confirm_replace" value="yes" /> : null}
          <label htmlFor={'key-' + id} className="sr-only">Router public key</label>
          <input
            id={'key-' + id}
            name="public_key"
            required
            autoComplete="off"
            spellCheck={false}
            placeholder="The public key step 1 printed, 44 characters ending in ="
            className={settingsInput + ' font-mono text-xs'}
          />
          <SubmitButton
            label={replace ? 'Replace key' : 'Save key'}
            pending="Saving…"
            confirmText={
              replace
                ? "Replace this router's key? The tunnel is down until the server side has the new key."
                : undefined
            }
          />
        </form>
      )}
      <Result state={state} />
    </div>
  )
}

function ConfigPanel({ id }: { id: number }) {
  const [state, action] = useActionState(showRouterTunnelConfig, null)
  return (
    <div className="space-y-2">
      {state?.ok ? null : (
        <form action={action} className="flex items-center gap-3">
          <input type="hidden" name="id" value={id} />
          <p className="text-xs text-gray-500">Step 2 includes the router&apos;s RADIUS secret.</p>
          <SubmitButton label="Show config" pending="Loading…" />
        </form>
      )}
      <Result state={state} />
    </div>
  )
}

function RevokePanel({ id, name }: { id: number; name: string }) {
  const [state, action] = useActionState(revokeRouterTunnel, null)
  return (
    <div className="space-y-2">
      {state?.ok ? null : (
        <form action={action} className="flex items-center gap-3">
          <input type="hidden" name="id" value={id} />
          <p className="text-xs text-gray-500">
            Removes the router from the RADIUS server. If the router has no other RADIUS entry, it
            loses RADIUS altogether.
          </p>
          <SubmitButton
            label="Revoke"
            pending="Revoking…"
            danger
            confirmText={'Revoke ' + name + '? Its nas row is removed and its address is never reused.'}
          />
        </form>
      )}
      <Result state={state} />
    </div>
  )
}

type Mode = 'key' | 'replace' | 'config' | 'revoke' | null

/**
 * A revoked router stays in the list, dimmed, in the same place — not moved to
 * a list of its own. Moving it would unmount the row the moment the revoke
 * lands and take the removal blocks it just returned off the screen.
 */
function TunnelRow({ tunnel }: { tunnel: TunnelView }) {
  const [mode, setMode] = useState<Mode>(null)
  const toggle = (m: Exclude<Mode, null>) => setMode((cur) => (cur === m ? null : m))
  const revoked = tunnel.revokedText !== null

  return (
    <li className="space-y-3 px-4 py-3">
      <div className={'flex flex-wrap items-center gap-3' + (revoked ? ' opacity-50' : '')}>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-gray-200">{tunnel.name}</p>
          <p className="mt-0.5 text-[11px] text-gray-500">
            <span className="font-mono text-gray-400">{tunnel.tunnelIp}</span>
            {' · '}{tunnel.services.join(', ')}
            {tunnel.keyPrefix ? <> · key <span className="font-mono">{tunnel.keyPrefix}</span></> : null}
            {' · added '}{tunnel.createdText}
          </p>
        </div>
        {revoked ? (
          <span className="shrink-0 rounded bg-gray-800 px-2 py-0.5 text-[11px] font-semibold text-gray-400">
            Revoked {tunnel.revokedText}
          </span>
        ) : (
          <span className={'shrink-0 rounded px-2 py-0.5 text-[11px] font-semibold ' + STATUS_CLS[tunnel.status]}>
            {tunnel.statusText}
          </span>
        )}
        <div className={'flex shrink-0 items-center gap-1.5' + (revoked ? ' hidden' : '')}>
          {tunnel.keyPrefix ? (
            <button type="button" onClick={() => toggle('replace')} className={buttonCls}>
              <KeyRound className="h-3 w-3" aria-hidden />
              Replace key
            </button>
          ) : (
            <button type="button" onClick={() => toggle('key')} className={buttonCls}>
              <KeyRound className="h-3 w-3" aria-hidden />
              Paste key
            </button>
          )}
          <button type="button" onClick={() => toggle('config')} className={buttonCls}>
            <Terminal className="h-3 w-3" aria-hidden />
            Config
          </button>
          <button
            type="button"
            onClick={() => toggle('revoke')}
            className={buttonCls + ' hover:bg-red-500/20 hover:text-red-400'}
          >
            <Trash2 className="h-3 w-3" aria-hidden />
            Revoke
          </button>
        </div>
      </div>

      {/* Keyed by mode so each panel opens with its own fresh action state. */}
      {mode === 'key' ? <KeyPanel key="key" id={tunnel.id} replace={false} /> : null}
      {mode === 'replace' ? <KeyPanel key="replace" id={tunnel.id} replace /> : null}
      {mode === 'config' ? <ConfigPanel key="config" id={tunnel.id} /> : null}
      {mode === 'revoke' ? <RevokePanel key="revoke" id={tunnel.id} name={tunnel.name} /> : null}
    </li>
  )
}

export function RouterTunnelsManager({
  tunnels,
  operator,
  canAdd,
  statusReported,
}: {
  tunnels: TunnelView[]
  /** The platform operator: the only one told how status is reported. */
  operator: boolean
  /** False for a tenant while the server is not set up: a step 1 they could never finish. */
  canAdd: boolean
  statusReported: boolean
}) {
  const [adding, setAdding] = useState(false)
  const live = tunnels.filter((t) => t.revokedText === null)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-gray-500">
          {live.length} {live.length === 1 ? 'router' : 'routers'}
          {statusReported || !operator ? '' : ' · tunnel status is not reported (WG_HANDSHAKES_FILE)'}
        </p>
        {!adding && canAdd ? (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-blue-500"
          >
            <Plus className="h-4 w-4" aria-hidden />
            Add Router
          </button>
        ) : null}
      </div>

      {adding ? <AddRouterForm onClose={() => setAdding(false)} /> : null}

      <div className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
        {tunnels.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-gray-600">No router tunnels yet.</p>
        ) : (
          <ul className="divide-y divide-gray-800">
            {tunnels.map((t) => <TunnelRow key={t.id} tunnel={t} />)}
          </ul>
        )}
      </div>
    </div>
  )
}
