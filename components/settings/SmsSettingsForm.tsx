'use client'

import {
  AlertTriangle, CheckCircle2, Smartphone, Trash2, WifiOff,
} from 'lucide-react'
import { useActionState, useState } from 'react'

import {
  pairSmsDevice, saveSmsSettings, unpairSmsDevice, type SmsActionResult,
} from '@/app/actions/sms'
import type { SafeSmsDevice, SmsSettings } from '@/lib/data/sms'
import {
  AUTOMATED_KINDS, DEFAULT_TEMPLATES, KIND_DESCRIPTIONS, KIND_LABELS,
  PLACEHOLDERS, countSegments, worstCaseLength,
} from '@/lib/sms/templates'

const input =
  'w-full rounded-lg border border-gray-800 bg-gray-950 px-3 py-2 text-sm text-gray-200 ' +
  'outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30'

const label = 'block text-xs font-medium text-gray-400'

function Toggle({
  name, checked, onChange, title, description, disabled,
}: {
  name: string
  checked: boolean
  onChange: (v: boolean) => void
  title: string
  description: string
  disabled?: boolean
}) {
  return (
    <label
      className={
        'flex items-start gap-3 rounded-lg border p-3 transition ' +
        (disabled
          ? 'cursor-not-allowed border-gray-900 bg-gray-950/50 opacity-60'
          : 'cursor-pointer border-gray-800 bg-gray-950 hover:border-gray-700')
      }
    >
      <input
        type="checkbox"
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-gray-700 bg-gray-900 text-blue-600"
      />
      <span>
        <span className="block text-sm font-medium text-gray-200">{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-gray-500">
          {description}
        </span>
      </span>
    </label>
  )
}

/** "3 minutes", "1 hour 5 minutes" — never a bare count of seconds. */
export function humaniseDuration(seconds: number): string {
  if (seconds < 60) return Math.round(seconds) + ' seconds'
  const mins = Math.round(seconds / 60)
  if (mins < 60) return mins + ' minute' + (mins === 1 ? '' : 's')
  const hours = Math.floor(mins / 60)
  const rest = mins % 60
  return hours + ' hour' + (hours === 1 ? '' : 's') +
    (rest ? ' ' + rest + ' minute' + (rest === 1 ? '' : 's') : '')
}

function DevicePanel({
  device, relayConfigured, minutesAgo,
}: {
  device: SafeSmsDevice | null
  relayConfigured: boolean
  /**
   * How long since the relay last heard from the phone, computed on the SERVER.
   *
   * Not derived from Date.now() here: a render is supposed to be a pure
   * function of its props, and reading the clock during one makes what the page
   * says depend on when React happened to re-run it.
   */
  minutesAgo: number | null
}) {
  const [state, action, pending] = useActionState<SmsActionResult | null, FormData>(
    pairSmsDevice, null
  )
  const [removing, setRemoving] = useState(false)

  if (!relayConfigured) {
    return (
      <div className="rounded-xl border border-amber-900/50 bg-amber-950/30 px-4 py-3">
        <p className="text-sm font-semibold text-amber-300">Relay not configured</p>
        <p className="mt-1 text-xs leading-relaxed text-amber-300/80">
          This server has no SMS relay set up, so no phone can be paired. Ask your
          administrator to set <code className="font-mono">SMS_RELAY_URL</code>.
        </p>
      </div>
    )
  }

  if (device) {
    // "Online" is a claim about a phone we cannot see from here. It is derived
    // from when the relay last heard from it, and says so, rather than showing
    // a green dot the app has no way to justify.
    const seen = device.lastSeenAt
    const online = minutesAgo !== null && minutesAgo < 15

    return (
      <div className="space-y-3 rounded-xl border border-gray-800 bg-gray-900 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span
              className={
                'flex h-9 w-9 items-center justify-center rounded-lg ' +
                (online ? 'bg-green-500/10 text-green-400' : 'bg-gray-800 text-gray-500')
              }
            >
              {online ? <Smartphone className="h-4 w-4" /> : <WifiOff className="h-4 w-4" />}
            </span>
            <div>
              <p className="text-sm font-semibold text-gray-200">
                {device.label || 'Paired phone'}
              </p>
              <p className="mt-0.5 text-xs text-gray-500">
                {!seen || minutesAgo === null
                  ? 'The relay has never heard from this phone.'
                  : online
                    ? 'Online — last seen ' + minutesAgo + ' minutes ago.'
                    : 'Last seen ' + (minutesAgo > 1440
                      ? Math.round(minutesAgo / 1440) + ' days ago'
                      : minutesAgo + ' minutes ago') + '.'}
              </p>
              <p className="mt-1 font-mono text-[11px] text-gray-600">
                {device.apiUsername}
                {device.simNumber ? ' · SIM ' + device.simNumber : ''}
              </p>
            </div>
          </div>

          <form action={async () => { setRemoving(true); await unpairSmsDevice() }}>
            <button
              type="submit"
              disabled={removing}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-900/60 px-2.5 py-1.5 text-xs font-medium text-red-400 transition hover:bg-red-950/40 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
              {removing ? 'Removing…' : 'Remove'}
            </button>
          </form>
        </div>

        {!online && seen ? (
          <p className="rounded-lg bg-amber-950/30 px-3 py-2 text-xs text-amber-300/90">
            Messages will queue but not send while the phone is offline. Check that it
            has signal, is charged, and that battery optimisation is still off for the
            gateway app.
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <form action={action} className="space-y-3 rounded-xl border border-gray-800 bg-gray-900 p-4">
      <div>
        <p className="text-sm font-semibold text-gray-200">Pair a phone</p>
        <p className="mt-1 text-xs leading-relaxed text-gray-500">
          On the Android gateway app, switch to Cloud Server mode and enter the relay
          address your administrator gave you. The app will then show a username and
          password — enter those here. Until a phone is paired, this company sends
          nothing.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="api_username" className={label}>Username from the app</label>
          <input id="api_username" name="api_username" className={input + ' mt-1'} autoComplete="off" />
          {state?.ok === false && state.fieldErrors?.api_username ? (
            <p className="mt-1 text-xs text-red-400">{state.fieldErrors.api_username}</p>
          ) : null}
        </div>
        <div>
          <label htmlFor="api_password" className={label}>Password from the app</label>
          <input
            id="api_password" name="api_password" type="password"
            className={input + ' mt-1'} autoComplete="off"
          />
          {state?.ok === false && state.fieldErrors?.api_password ? (
            <p className="mt-1 text-xs text-red-400">{state.fieldErrors.api_password}</p>
          ) : null}
        </div>
        <div>
          <label htmlFor="label" className={label}>Name it (optional)</label>
          <input
            id="label" name="label" className={input + ' mt-1'}
            placeholder="Front desk phone"
          />
        </div>
        <div>
          <label htmlFor="sim_number" className={label}>SIM slot (optional)</label>
          <input
            id="sim_number" name="sim_number" type="number" min={1} max={3}
            className={input + ' mt-1'} placeholder="Leave blank for default"
          />
        </div>
      </div>

      {state?.ok === false ? (
        <p className="rounded-lg bg-red-950/40 px-3 py-2 text-xs text-red-300">{state.error}</p>
      ) : null}
      {state?.ok ? (
        <p className="rounded-lg bg-green-950/40 px-3 py-2 text-xs text-green-300">
          {state.message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-50"
      >
        {pending ? 'Checking…' : 'Pair phone'}
      </button>
    </form>
  )
}

export function SmsSettingsForm({
  settings, device, companyName, relayConfigured, reachableCount, totalCount,
  deviceMinutesAgo,
}: {
  settings: SmsSettings
  device: SafeSmsDevice | null
  companyName: string
  relayConfigured: boolean
  reachableCount: number
  totalCount: number
  /** Computed on the server — see the note on DevicePanel. */
  deviceMinutesAgo: number | null
}) {
  const [state, action, pending] = useActionState<SmsActionResult | null, FormData>(
    saveSmsSettings, null
  )

  const [enabled, setEnabled] = useState(settings.smsEnabled)
  const [types, setTypes] = useState({
    payment_receipt: settings.paymentReceipt,
    expiry_warning: settings.expiryWarning,
    disconnection_notice: settings.disconnection,
  })
  const [templates, setTemplates] = useState(settings.smsTemplates)
  const [allowForeign, setAllowForeign] = useState(settings.allowForeign)
  const [throttle, setThrottle] = useState(String(settings.throttleSeconds))

  const fieldError = (k: string) =>
    state?.ok === false ? state.fieldErrors?.[k] : undefined

  const perMinute = Math.max(1, Math.floor(60 / Math.max(1, Number(throttle) || 6)))

  return (
    <div className="space-y-5">
      <DevicePanel
        device={device}
        relayConfigured={relayConfigured}
        minutesAgo={deviceMinutesAgo}
      />

      <form action={action} className="space-y-5">
        {/* THE MASTER SWITCH. Rendered first and on its own, because it is what
            an owner reaches for when a SIM starts being flagged and it must not
            be somewhere they have to hunt for. */}
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
          <Toggle
            name="sms_enabled"
            checked={enabled}
            onChange={setEnabled}
            title="Send SMS for this company"
            description={
              'The master switch. While this is off nothing sends, whatever the ' +
              'individual message types below say.'
            }
          />
          {!enabled ? (
            <p className="mt-2 rounded-lg bg-gray-950 px-3 py-2 text-xs text-gray-500">
              SMS is off. Messages are not queued and nothing is sent.
            </p>
          ) : null}
        </div>

        <div className="space-y-3 rounded-xl border border-gray-800 bg-gray-900 p-4">
          <div>
            <p className="text-sm font-semibold text-gray-200">Automatic messages</p>
            <p className="mt-1 text-xs text-gray-500">
              All off by default. Turn on only what you want customers to receive.
            </p>
          </div>

          {AUTOMATED_KINDS.map((kind) => {
            const worst = worstCaseLength(templates[kind], companyName)
            const current = countSegments(templates[kind])
            return (
              <div key={kind} className="space-y-2">
                <Toggle
                  name={
                    kind === 'payment_receipt' ? 'sms_payment_receipt_enabled'
                      : kind === 'expiry_warning' ? 'sms_expiry_warning_enabled'
                        : 'sms_disconnection_enabled'
                  }
                  checked={types[kind]}
                  onChange={(v) => setTypes({ ...types, [kind]: v })}
                  title={KIND_LABELS[kind]}
                  description={KIND_DESCRIPTIONS[kind]}
                  disabled={!enabled}
                />

                {types[kind] ? (
                  <div className="ml-7 space-y-1.5">
                    <label
                      htmlFor={'tpl-' + kind}
                      className={label}
                    >
                      Message wording
                    </label>
                    <textarea
                      id={'tpl-' + kind}
                      name={
                        kind === 'payment_receipt' ? 'sms_payment_receipt_template'
                          : kind === 'expiry_warning' ? 'sms_expiry_warning_template'
                            : 'sms_disconnection_template'
                      }
                      rows={3}
                      value={templates[kind]}
                      onChange={(e) => setTemplates({ ...templates, [kind]: e.target.value })}
                      className={input + ' font-mono text-xs'}
                    />
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                      <span className="text-gray-600">
                        {current.characters} characters · {current.segments} SMS
                        {current.encoding === 'UCS2' ? ' · unicode (70 per SMS)' : ''}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setTemplates({ ...templates, [kind]: DEFAULT_TEMPLATES[kind] })}
                        className="text-gray-500 underline transition hover:text-gray-300"
                      >
                        Reset to default
                      </button>
                    </div>

                    {/* The worst case, not the current one. An operator needs to
                        know a template will cost two messages for the customer
                        with the longest name BEFORE it goes to 1,276 people. */}
                    {worst.segments > current.segments ? (
                      <p className="rounded bg-amber-950/30 px-2 py-1 text-[11px] text-amber-300/90">
                        With the longest names and amounts this becomes {worst.segments} SMS
                        per customer.
                      </p>
                    ) : null}
                    {current.encoding === 'UCS2' ? (
                      <p className="rounded bg-amber-950/30 px-2 py-1 text-[11px] text-amber-300/90">
                        This contains a character outside the standard SMS set — often a
                        curly apostrophe pasted from Word. That cuts each message from 160
                        characters to 70.
                      </p>
                    ) : null}
                    {fieldError(
                      kind === 'payment_receipt' ? 'sms_payment_receipt_template'
                        : kind === 'expiry_warning' ? 'sms_expiry_warning_template'
                          : 'sms_disconnection_template'
                    ) ? (
                      <p className="text-xs text-red-400">
                        {fieldError(
                          kind === 'payment_receipt' ? 'sms_payment_receipt_template'
                            : kind === 'expiry_warning' ? 'sms_expiry_warning_template'
                              : 'sms_disconnection_template'
                        )}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )
          })}

          <div className="rounded-lg bg-gray-950 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              Placeholders
            </p>
            <dl className="mt-1.5 grid gap-x-4 gap-y-1 text-[11px] sm:grid-cols-2">
              {Object.entries(PLACEHOLDERS).map(([token, what]) => (
                <div key={token} className="flex gap-2">
                  <dt className="font-mono text-blue-400">{token}</dt>
                  <dd className="text-gray-500">{what}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>

        <div className="grid gap-4 rounded-xl border border-gray-800 bg-gray-900 p-4 sm:grid-cols-2">
          <div>
            <label htmlFor="sms_expiry_warning_days" className={label}>
              Warn this many days before cut-off
            </label>
            <input
              id="sms_expiry_warning_days"
              name="sms_expiry_warning_days"
              type="number" min={1} max={30}
              defaultValue={settings.expiryWarningDays}
              className={input + ' mt-1'}
            />
            {fieldError('sms_expiry_warning_days') ? (
              <p className="mt-1 text-xs text-red-400">{fieldError('sms_expiry_warning_days')}</p>
            ) : null}
          </div>

          <div>
            <label htmlFor="sms_throttle_seconds" className={label}>
              Seconds between messages
            </label>
            <input
              id="sms_throttle_seconds"
              name="sms_throttle_seconds"
              type="number" min={1} max={600}
              value={throttle}
              onChange={(e) => setThrottle(e.target.value)}
              className={input + ' mt-1'}
            />
            <p className="mt-1 text-[11px] text-gray-600">
              About {perMinute} per minute. Sending faster than this from an ordinary
              SIM is what gets a number flagged by the carrier.
            </p>
            {fieldError('sms_throttle_seconds') ? (
              <p className="mt-1 text-xs text-red-400">{fieldError('sms_throttle_seconds')}</p>
            ) : null}
          </div>

          <div className="sm:col-span-2">
            <Toggle
              name="sms_allow_foreign"
              checked={allowForeign}
              onChange={setAllowForeign}
              title="Also text overseas numbers"
              description={
                'Some customers are paid for by relatives abroad. Texting those numbers ' +
                'is charged at international rates on your SIM, so this is off unless ' +
                'you turn it on.'
              }
            />
          </div>
        </div>

        {/* The data quality panel. The counts are the point: an owner cannot fix
            411 country-code stubs they have never been told about. */}
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
          <p className="text-sm font-semibold text-gray-200">Who you can reach</p>
          <p className="mt-1 text-xs text-gray-500">
            {reachableCount} of {totalCount} customers have a phone number this system can
            text.{' '}
            {totalCount - reachableCount > 0 ? (
              <span className="text-amber-400">
                {totalCount - reachableCount} cannot be reached — usually a missing number
                or one that is only a country code.
              </span>
            ) : null}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-50"
          >
            {pending ? 'Saving…' : 'Save settings'}
          </button>

          {state?.ok ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-green-400">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
              {state.message}
            </span>
          ) : null}
          {state?.ok === false ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-red-400">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
              {state.error}
            </span>
          ) : null}
        </div>
      </form>
    </div>
  )
}
