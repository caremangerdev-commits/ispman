'use client'

import { AlertTriangle, Check, Copy, KeyRound, Plus, Terminal, Trash2, X } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useActionState, useEffect, useRef, useState } from 'react'
import { useFormStatus } from 'react-dom'

import {
  addRouterTunnel, revokeRouterTunnel, setRouterTunnelKey, showRouterTunnelConfig,
  type TunnelActionResult,
} from '@/app/actions/tunnels'
import { settingsInput } from '@/components/settings/Modal'
import type { TunnelStatus } from '@/lib/tunnels/status'
import {
  CHECK_VERDICTS, ROUTER_CHECK, ROUTER_CHECK_TUNNEL, ROUTER_CREATE, ROUTER_NTP_ON, ROUTER_SERVICES,
  ROUTER_UPGRADE, type ConfigBlock, type RouterCommand,
} from '@/lib/tunnels/wireguard'

/**
 * Router Tunnels as a guide (owner, 13 Oct 2026): five numbered steps, one
 * action each, each shown once the one before it is done.
 *
 *   1  Add the router here
 *   2  Paste these on the router  — the check first, then the tunnel
 *   3  Paste the key it printed back here
 *   4  Paste these on the router  — connect it
 *   5  Done: it shows Up within a minute
 *
 * ONE COMMAND PER COPY BUTTON. Pasting several lines into Winbox runs them
 * joined together or several times over, so nothing here copies more than one
 * line for a router (lib/tunnels/wireguard.ts).
 *
 * NTP IS ASKED, NOT PRINTED. Step 2 opens with a check that ends in one word,
 * and the guide asks which word it was before showing anything else. NTP IS
 * OFF stops the guide with the command to turn it on; nobody has to notice a
 * "false" in the output.
 *
 * Seen by company admins as well as the platform operator, so nothing here
 * names the RADIUS server's software or shows how the server is set up. Only
 * the operator, and only in hand-run mode, is shown a server block.
 */

export type Half = 'auto' | 'operator' | 'tenant'

/** One router as the page shows it. Nothing secret: commands are fetched on demand. */
export type TunnelView = {
  id: number
  name: string
  tunnelIp: string
  services: string[]
  hasKey: boolean
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

const smallButton =
  'inline-flex items-center gap-1 rounded-md bg-gray-800 px-2 py-1 text-[11px] font-semibold text-gray-300 transition hover:bg-gray-700'
const primaryButton =
  'inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-60'

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

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

function CopyButton({ text, onCopied }: { text: string; onCopied?: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          onCopied?.()
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      className={smallButton + ' shrink-0'}
    >
      {copied ? <Check className="h-3 w-3" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'

/** One router command: its label, the line, its own copy button. A tick once copied. */
function CommandRow({ letter, command }: { letter: string; command: RouterCommand }) {
  const [used, setUsed] = useState(false)
  return (
    <li className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span
          className={
            'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ' +
            (used ? 'bg-emerald-500/20 text-emerald-400' : 'bg-gray-800 text-gray-400')
          }
        >
          {used ? <Check className="h-3 w-3" aria-hidden /> : letter}
        </span>
        <span className="min-w-0 flex-1 text-xs font-medium text-gray-300">{command.label}</span>
        <CopyButton text={command.line} onCopied={() => setUsed(true)} />
      </div>
      <code className="ml-7 block overflow-x-auto whitespace-pre rounded-md bg-gray-950 px-2.5 py-1.5 text-[11px] text-gray-300">
        {command.line}
      </code>
    </li>
  )
}

function Commands({ commands, start = 0 }: { commands: RouterCommand[]; start?: number }) {
  return (
    <ol className="space-y-3">
      {commands.map((c, i) => (
        <CommandRow key={i + start} letter={LETTERS[i + start] ?? '•'} command={c} />
      ))}
    </ol>
  )
}

function OneLineHint() {
  return (
    <p className="text-xs text-gray-500">
      One line at a time: copy it, paste it into the router&apos;s terminal, press Enter, then come
      back for the next. Pasting several lines at once into Winbox runs them joined together.
    </p>
  )
}

function ServerBlock({ block }: { block: ConfigBlock }) {
  return (
    <div className="overflow-hidden rounded-lg border border-amber-900/50">
      <div className="flex items-center justify-between gap-2 bg-amber-950/30 px-3 py-1.5">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-amber-300">
          <Terminal className="h-3 w-3" aria-hidden />
          {block.title} — over SSH, where a whole block pastes fine
        </span>
        <CopyButton text={block.text} />
      </div>
      <pre className="max-h-80 overflow-auto bg-gray-950 px-3 py-2 text-[11px] leading-relaxed text-gray-300">
        {block.text}
      </pre>
    </div>
  )
}

function Problem({ text }: { text: string }) {
  return (
    <p role="alert" className="rounded-lg border border-red-900/60 bg-red-950/50 px-3 py-2 text-xs text-red-300">
      {text}
    </p>
  )
}

function Note({ text }: { text: string }) {
  return (
    <p className="rounded-lg border border-emerald-900/50 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-300">
      {text}
    </p>
  )
}

type StepState = 'done' | 'current' | 'todo'

function Step({
  n, title, state, summary, children,
}: {
  n: number
  title: string
  state: StepState
  /** One line shown under a finished step. */
  summary?: string
  children?: React.ReactNode
}) {
  return (
    <li className="flex gap-3">
      <span
        className={
          'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ' +
          (state === 'done'
            ? 'bg-emerald-500/20 text-emerald-400'
            : state === 'current'
              ? 'bg-blue-600 text-white'
              : 'border border-gray-700 text-gray-600')
        }
      >
        {state === 'done' ? <Check className="h-4 w-4" aria-hidden /> : n}
      </span>
      <div className="min-w-0 flex-1 space-y-3 pb-1">
        <p
          className={
            'pt-1 text-sm font-semibold ' +
            (state === 'current' ? 'text-white' : state === 'done' ? 'text-gray-300' : 'text-gray-600')
          }
        >
          {title}
        </p>
        {state === 'done' && summary ? <p className="-mt-2 text-xs text-gray-500">{summary}</p> : null}
        {state === 'current' ? children : null}
      </div>
    </li>
  )
}

// ---------------------------------------------------------------------------
// The guide
// ---------------------------------------------------------------------------

type Verdict = 'unasked' | 'ready' | 'ntp_off' | 'too_old'

/** Step 2: the check, its answer, and only then the tunnel. */
function StepTwo({ onDone }: { onDone: () => void }) {
  const [verdict, setVerdict] = useState<Verdict>('unasked')

  return (
    <div className="space-y-4">
      <OneLineHint />
      <ol className="space-y-3">
        <CommandRow letter="a" command={ROUTER_CHECK} />
      </ol>

      {verdict === 'unasked' ? (
        <div className="ml-7 space-y-2">
          <p className="text-xs font-semibold text-gray-300">What does the last line it printed say?</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setVerdict('ready')} className={smallButton}>
              {CHECK_VERDICTS.ready}
            </button>
            <button type="button" onClick={() => setVerdict('ntp_off')} className={smallButton}>
              {CHECK_VERDICTS.ntpOff}
            </button>
            <button type="button" onClick={() => setVerdict('too_old')} className={smallButton}>
              {CHECK_VERDICTS.tooOld}
            </button>
          </div>
        </div>
      ) : null}

      {verdict === 'ntp_off' ? (
        <div className="ml-7 space-y-3 rounded-lg border border-amber-900/50 bg-amber-950/30 p-3">
          <p className="flex items-start gap-2 text-xs text-amber-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              <strong>Clock sync (NTP) is off on this router. Turn it on before going further.</strong>{' '}
              Without it, the tunnel will not come back after the router restarts.
            </span>
          </p>
          <ol className="space-y-3">
            <CommandRow letter="b" command={ROUTER_NTP_ON} />
          </ol>
          <button type="button" onClick={() => setVerdict('unasked')} className={smallButton}>
            Done — run the check (a) again
          </button>
        </div>
      ) : null}

      {verdict === 'too_old' ? (
        <div className="ml-7 space-y-3 rounded-lg border border-red-900/60 bg-red-950/40 p-3">
          <p className="flex items-start gap-2 text-xs text-red-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              <strong>Stop here: this router runs RouterOS 6, and tunnels need RouterOS 7.</strong>{' '}
              Upgrading reboots the router twice. Do it off-peak, with someone at the router, and
              download the two backup files off it before installing anything. Routers that share
              internet across several connections often need their routing checked afterwards.
            </span>
          </p>
          <Commands commands={ROUTER_UPGRADE} />
          <button type="button" onClick={() => setVerdict('unasked')} className={smallButton}>
            Upgraded — run the check (a) again
          </button>
        </div>
      ) : null}

      {verdict === 'ready' ? (
        <div className="space-y-3">
          <Commands commands={ROUTER_CREATE} start={1} />
          <p className="ml-7 text-xs text-gray-500">
            The last one prints one line ending in <code>=</code>. That is the router&apos;s public
            key; copy it for step 3. (The private key stays on the router.)
          </p>
          <button type="button" onClick={onDone} className={primaryButton + ' ml-7'}>
            I have the key — next step
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** Step 5: the router's live state, refreshed until it is up. */
function StepFive({ tunnel, half, statusReported }: { tunnel: TunnelView; half: Half; statusReported: boolean }) {
  const router = useRouter()
  const up = tunnel.status === 'up'

  // The status comes from the server's handshake record; reload it every 15s
  // until the tunnel is up, so "Up within a minute" happens on screen.
  useEffect(() => {
    if (up) return
    const id = window.setInterval(() => router.refresh(), 15000)
    return () => window.clearInterval(id)
  }, [up, router])

  const advice: Record<TunnelStatus, string> = {
    up: 'RADIUS for this router now goes through its tunnel. Its old RADIUS entry stays as the fallback until the move is finished.',
    not_on_server:
      half === 'auto'
        ? 'Waiting for the server to pick the router up. That takes under a minute.'
        : half === 'operator'
          ? 'Waiting for the server side: run the server block from step 4 as root.'
          : 'Waiting for the platform operator to add the server side.',
    never:
      'The server is ready but the router has not connected. Check that every line in step 4 ran without ' +
      'an error and that the router can reach the internet, then look from the router:',
    down:
      'The tunnel was up but has gone quiet. Check the router can reach the internet and its clock is ' +
      'right (NTP), then look from the router:',
    waiting: "Waiting for the router's key.",
    unknown: 'This server does not report tunnel status yet. Look from the router instead:',
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={'rounded px-2 py-0.5 text-[11px] font-semibold ' + STATUS_CLS[tunnel.status]}>
          {tunnel.statusText}
        </span>
        {!up ? <span className="text-[11px] text-gray-600">checks again every 15 seconds</span> : null}
      </div>
      <p className="text-xs text-gray-400">{advice[tunnel.status]}</p>
      {tunnel.status === 'never' || tunnel.status === 'down' || (tunnel.status === 'unknown' && !statusReported) ? (
        <ol className="space-y-3">
          <CommandRow letter="a" command={ROUTER_CHECK_TUNNEL} />
        </ol>
      ) : null}
    </div>
  )
}

function Guide({
  tunnel, expecting, half, canAdd, statusReported, onAdded, onStartOver,
}: {
  /** The router being set up; null while step 1 is still to do. */
  tunnel: TunnelView | null
  /** True when a router was just added and has not reached the list yet. */
  expecting: boolean
  half: Half
  canAdd: boolean
  statusReported: boolean
  onAdded: (id: number) => void
  onStartOver: () => void
}) {
  const [addState, addAction] = useActionState(addRouterTunnel, null)
  const [keyState, keyAction] = useActionState(setRouterTunnelKey, null)
  const [showState, showAction] = useActionState(showRouterTunnelConfig, null)
  const [stepTwoDone, setStepTwoDone] = useState(false)
  const [stepFourDone, setStepFourDone] = useState(false)

  // Step 1 done: follow the new router. The action state is a fresh object per
  // submission, so this fires once per result.
  useEffect(() => {
    if (addState?.ok && addState.tunnelId) onAdded(addState.tunnelId)
  }, [addState, onAdded])

  if (!tunnel && expecting) {
    return <p className="px-1 text-sm text-gray-500">Adding the router…</p>
  }
  if (tunnel?.revokedText) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-gray-400">{tunnel.name} was revoked.</p>
        <button type="button" onClick={onStartOver} className={primaryButton}>
          <Plus className="h-4 w-4" aria-hidden />
          Add a router
        </button>
      </div>
    )
  }

  const keySaved = Boolean(tunnel?.hasKey || keyState?.ok)
  const up = tunnel?.status === 'up'
  const stage = !tunnel ? 1 : !keySaved ? (stepTwoDone ? 3 : 2) : stepFourDone || up ? 5 : 4
  const state = (n: number): StepState => (n < stage || (n === 5 && up) ? 'done' : n === stage ? 'current' : 'todo')
  const connect = keyState?.ok ? keyState : showState?.ok ? showState : null

  return (
    <div className="space-y-4">
      <ol className="space-y-4">
        <Step
          n={1}
          title="Add the router here"
          state={state(1)}
          summary={tunnel ? tunnel.name + ' · tunnel address ' + tunnel.tunnelIp : undefined}
        >
          {canAdd ? (
            <form action={addAction} className="space-y-3">
              <div className="flex items-center gap-2">
                <label htmlFor="tunnel-name" className="sr-only">Router name</label>
                <input
                  id="tunnel-name"
                  name="name"
                  required
                  maxLength={40}
                  placeholder="A name for it, e.g. Main CCR"
                  className={settingsInput}
                />
                <SubmitButton label="Add router" pending="Adding…" />
              </div>
              <fieldset className="flex flex-wrap items-center gap-4">
                <legend className="sr-only">What the router uses RADIUS for</legend>
                <span className="text-xs text-gray-500">It uses RADIUS for:</span>
                {ROUTER_SERVICES.map((s) => (
                  <label key={s.value} className="inline-flex items-center gap-1.5 text-xs text-gray-300">
                    <input type="checkbox" name="services" value={s.value} defaultChecked={s.value === 'dhcp'} />
                    {s.label}
                  </label>
                ))}
              </fieldset>
              {addState && !addState.ok ? <Problem text={addState.error} /> : null}
            </form>
          ) : (
            <p className="text-xs text-gray-500">Not available until the server is set up.</p>
          )}
        </Step>

        <Step
          n={2}
          title="Paste these on the router"
          state={state(2)}
          summary="Checked, and the tunnel created on the router"
        >
          <StepTwo onDone={() => setStepTwoDone(true)} />
        </Step>

        <Step n={3} title="Paste the key it printed back here" state={state(3)} summary="Key saved">
          {tunnel ? (
            <form action={keyAction} className="space-y-2">
              <input type="hidden" name="id" value={tunnel.id} />
              <div className="flex items-center gap-2">
                <label htmlFor={'key-' + tunnel.id} className="sr-only">The router&apos;s public key</label>
                <input
                  id={'key-' + tunnel.id}
                  name="public_key"
                  required
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="The line from step 2, ending in ="
                  className={settingsInput + ' font-mono text-xs'}
                />
                <SubmitButton label="Save key" pending="Saving…" />
              </div>
              {keyState && !keyState.ok ? <Problem text={keyState.error} /> : null}
              <button type="button" onClick={() => setStepTwoDone(false)} className={smallButton}>
                Back to step 2
              </button>
            </form>
          ) : null}
        </Step>

        <Step n={4} title="Paste these on the router" state={state(4)} summary="Router connected to the server">
          {tunnel ? (
            <div className="space-y-4">
              {connect?.ok && connect.message ? <Note text={connect.message} /> : null}
              {connect?.ok && connect.server ? <ServerBlock block={connect.server} /> : null}
              {connect?.ok && connect.router ? (
                <>
                  <OneLineHint />
                  <Commands commands={connect.router} />
                  <button type="button" onClick={() => setStepFourDone(true)} className={primaryButton + ' ml-7'}>
                    All pasted — next step
                  </button>
                </>
              ) : (
                <form action={showAction} className="flex flex-wrap items-center gap-3">
                  <input type="hidden" name="id" value={tunnel.id} />
                  <SubmitButton label="Show the commands" pending="Loading…" />
                  <span className="text-xs text-gray-500">They include this router&apos;s RADIUS secret.</span>
                  {showState && !showState.ok ? <Problem text={showState.error} /> : null}
                </form>
              )}
            </div>
          ) : null}
        </Step>

        <Step
          n={5}
          title="Done — it shows Up within a minute"
          state={state(5)}
          summary={up ? 'Up: RADIUS for this router goes through its tunnel.' : undefined}
        >
          {tunnel ? <StepFive tunnel={tunnel} half={half} statusReported={statusReported} /> : null}
        </Step>
      </ol>

      {tunnel && (up || stage === 5) ? (
        <button type="button" onClick={onStartOver} className={smallButton}>
          <Plus className="h-3 w-3" aria-hidden />
          Add another router
        </button>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The routers already added
// ---------------------------------------------------------------------------

function ResultPanel({ state }: { state: TunnelActionResult | null }) {
  if (!state) return null
  if (!state.ok) return <Problem text={state.error} />
  return (
    <div className="space-y-3">
      {state.message ? <Note text={state.message} /> : null}
      {state.server ? <ServerBlock block={state.server} /> : null}
      {state.router ? (
        <>
          {state.routerNote ? <p className="text-xs font-medium text-amber-300">{state.routerNote}</p> : null}
          <OneLineHint />
          <Commands commands={state.router} />
        </>
      ) : null}
    </div>
  )
}

function CommandsPanel({ id }: { id: number }) {
  const [state, action] = useActionState(showRouterTunnelConfig, null)
  return state?.ok ? (
    <ResultPanel state={state} />
  ) : (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="id" value={id} />
      <SubmitButton label="Show the step 4 commands" pending="Loading…" />
      <span className="text-xs text-gray-500">They include the router&apos;s RADIUS secret.</span>
      <ResultPanel state={state} />
    </form>
  )
}

function ReplaceKeyPanel({ id }: { id: number }) {
  const [state, action] = useActionState(setRouterTunnelKey, null)
  return state?.ok ? (
    <ResultPanel state={state} />
  ) : (
    <form action={action} className="space-y-2">
      <p className="text-xs text-gray-500">
        For a router that was reset or replaced and has made a new key (step 2 again).
      </p>
      <div className="flex items-center gap-2">
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="confirm_replace" value="yes" />
        <label htmlFor={'replace-' + id} className="sr-only">The router&apos;s new public key</label>
        <input
          id={'replace-' + id}
          name="public_key"
          required
          autoComplete="off"
          spellCheck={false}
          placeholder="The new key, ending in ="
          className={settingsInput + ' font-mono text-xs'}
        />
        <SubmitButton
          label="Replace key"
          pending="Saving…"
          confirmText="Replace this router's key? The tunnel is down until the server side has the new key."
        />
      </div>
      <ResultPanel state={state} />
    </form>
  )
}

function RevokePanel({ id, name }: { id: number; name: string }) {
  const [state, action] = useActionState(revokeRouterTunnel, null)
  return state?.ok ? (
    <ResultPanel state={state} />
  ) : (
    <form action={action} className="space-y-2">
      <input type="hidden" name="id" value={id} />
      <p className="text-xs text-gray-500">
        Removes the router from the RADIUS server for good; its address is never reused. If the router
        has no other RADIUS entry, it loses RADIUS altogether.
      </p>
      <SubmitButton
        label="Revoke"
        pending="Revoking…"
        danger
        confirmText={'Revoke ' + name + '? It is removed from the RADIUS server and its address is never reused.'}
      />
      <ResultPanel state={state} />
    </form>
  )
}

type Panel = 'commands' | 'replace' | 'revoke' | null

/**
 * A router in the list. A revoked router stays in place, dimmed, rather than
 * moving: moving it would unmount the row the moment the revoke lands and take
 * the removal commands it just returned off the screen.
 */
function RouterRow({ tunnel, onContinue }: { tunnel: TunnelView; onContinue: (id: number) => void }) {
  const [panel, setPanel] = useState<Panel>(null)
  const toggle = (p: Exclude<Panel, null>) => setPanel((cur) => (cur === p ? null : p))
  const revoked = tunnel.revokedText !== null
  const finished = tunnel.hasKey && tunnel.status === 'up'

  return (
    <li className="space-y-3 px-4 py-3">
      <div className={'flex flex-wrap items-center gap-3' + (revoked ? ' opacity-50' : '')}>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-gray-200">{tunnel.name}</p>
          <p className="mt-0.5 text-[11px] text-gray-500">
            <span className="font-mono text-gray-400">{tunnel.tunnelIp}</span>
            {' · '}{tunnel.services.join(', ')}
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
        {!revoked ? (
          <div className="flex shrink-0 items-center gap-1.5">
            {!finished ? (
              <button type="button" onClick={() => onContinue(tunnel.id)} className={smallButton}>
                Continue setup
              </button>
            ) : null}
            {tunnel.hasKey ? (
              <>
                <button type="button" onClick={() => toggle('commands')} className={smallButton}>
                  <Terminal className="h-3 w-3" aria-hidden />
                  Commands
                </button>
                <button type="button" onClick={() => toggle('replace')} className={smallButton}>
                  <KeyRound className="h-3 w-3" aria-hidden />
                  Replace key
                </button>
              </>
            ) : null}
            <button
              type="button"
              onClick={() => toggle('revoke')}
              className={smallButton + ' hover:bg-red-500/20 hover:text-red-400'}
            >
              <Trash2 className="h-3 w-3" aria-hidden />
              Revoke
            </button>
          </div>
        ) : null}
      </div>

      {/* Keyed by panel so each opens with its own fresh action state. */}
      {panel === 'commands' ? <CommandsPanel key="commands" id={tunnel.id} /> : null}
      {panel === 'replace' ? <ReplaceKeyPanel key="replace" id={tunnel.id} /> : null}
      {panel === 'revoke' ? <RevokePanel key="revoke" id={tunnel.id} name={tunnel.name} /> : null}
    </li>
  )
}

// ---------------------------------------------------------------------------

export function RouterTunnelsManager({
  tunnels, half, operator, canAdd, statusReported,
}: {
  tunnels: TunnelView[]
  half: Half
  /** The platform operator: the only one told how status is reported. */
  operator: boolean
  /** False for a tenant while the server is not set up: a step 2 they could never finish. */
  canAdd: boolean
  statusReported: boolean
}) {
  // The router the guide is following; null while step 1 is still to do.
  const [guideId, setGuideId] = useState<number | null>(null)
  const guideRef = useRef<HTMLElement>(null)
  const guided = guideId === null ? null : tunnels.find((t) => t.id === guideId) ?? null
  const live = tunnels.filter((t) => t.revokedText === null)

  return (
    <div className="space-y-5">
      <section ref={guideRef} className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-white">
            {guided ? 'Setting up ' + guided.name : 'Add a router'}
          </h2>
          {guideId !== null ? (
            <button type="button" onClick={() => setGuideId(null)} className={smallButton}>
              <X className="h-3 w-3" aria-hidden />
              Close
            </button>
          ) : null}
        </div>
        {/* Keyed by router: following a different one starts its steps afresh. */}
        <Guide
          key={guideId ?? 'new'}
          tunnel={guided}
          expecting={guideId !== null}
          half={half}
          canAdd={canAdd}
          statusReported={statusReported}
          onAdded={setGuideId}
          onStartOver={() => setGuideId(null)}
        />
      </section>

      <section className="space-y-2">
        <p className="text-sm text-gray-500">
          {live.length} {live.length === 1 ? 'router' : 'routers'}
          {statusReported || !operator ? '' : ' · tunnel status is not reported (WG_HANDSHAKES_FILE)'}
        </p>
        <div className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
          {tunnels.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-gray-600">No routers yet.</p>
          ) : (
            <ul className="divide-y divide-gray-800">
              {tunnels.map((t) => (
                <RouterRow
                  key={t.id}
                  tunnel={t}
                  onContinue={(id) => {
                    setGuideId(id)
                    guideRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  )
}
