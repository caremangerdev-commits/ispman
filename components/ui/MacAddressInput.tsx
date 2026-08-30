'use client'

import { Check, ClipboardCheck, ClipboardCopy, ClipboardPaste } from 'lucide-react'
import { useId, useState } from 'react'

const HEX = /[^0-9A-F]/g
export const MAC_PATTERN = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/

/**
 * Strips separators and regroups into XX:XX:XX:XX:XX:XX.
 *
 * Accepts anything a MAC realistically arrives as — colons, dashes, dots,
 * spaces or none at all — and keeps at most 12 hex digits.
 */
export function formatMac(raw: string): string {
  const hex = raw.toUpperCase().replace(HEX, '').slice(0, 12)
  return hex.match(/.{1,2}/g)?.join(':') ?? ''
}

export function isValidMac(value: string): boolean {
  return MAC_PATTERN.test(value)
}

export const MAC_ERROR = 'MAC address must be in format XX:XX:XX:XX:XX:XX'

type CommonProps = {
  value: string
  name?: string
  id?: string
  className?: string
}

export type MacAddressInputProps = CommonProps &
  (
    | { mode?: 'input'; onChange: (value: string) => void; required?: boolean; disabled?: boolean }
    | { mode: 'display'; onChange?: never; required?: never; disabled?: never }
  )

export function MacAddressInput(props: MacAddressInputProps) {
  const mode = props.mode ?? 'input'
  const generatedId = useId()
  const inputId = props.id ?? generatedId

  const [touched, setTouched] = useState(false)
  const [copied, setCopied] = useState(false)
  const [pasteError, setPasteError] = useState<string | null>(null)

  const value = props.value
  const complete = isValidMac(value)
  const showError = mode === 'input' && touched && value.length > 0 && !complete

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      // Revert the icon after the confirmation has been seen.
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setPasteError('Clipboard unavailable')
    }
  }

  async function paste() {
    if (mode !== 'input' || !props.onChange) return
    try {
      const text = await navigator.clipboard.readText()
      props.onChange(formatMac(text))
      setPasteError(null)
      setTouched(true)
    } catch {
      // Firefox and non-secure contexts block readText outright.
      setPasteError('Clipboard read blocked — paste with Ctrl+V instead')
    }
  }

  if (mode === 'display') {
    return (
      <span className={'inline-flex items-center gap-2 ' + (props.className ?? '')}>
        <span className="font-mono text-sm text-gray-200">{value || '—'}</span>
        {value ? (
          <span className="relative">
            <button
              type="button"
              onClick={copy}
              aria-label="Copy MAC address"
              className="rounded p-1 text-gray-500 transition hover:bg-gray-800 hover:text-gray-300"
            >
              {copied ? (
                <ClipboardCheck className="h-3.5 w-3.5 text-green-400" aria-hidden />
              ) : (
                <ClipboardCopy className="h-3.5 w-3.5" aria-hidden />
              )}
            </button>
            {copied ? (
              <span
                role="status"
                className="absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-green-600 px-1.5 py-0.5 text-[10px] font-semibold text-white"
              >
                Copied!
              </span>
            ) : null}
          </span>
        ) : null}
      </span>
    )
  }

  return (
    <div className={props.className}>
      <div className="flex items-center gap-1.5">
        <div className="relative flex-1">
          <input
            id={inputId}
            name={props.name}
            value={value}
            required={props.required}
            disabled={props.disabled}
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="AA:BB:CC:DD:EE:FF"
            aria-invalid={showError || undefined}
            aria-describedby={showError ? inputId + '-error' : undefined}
            onChange={(e) => {
              // Reformatting on every keystroke keeps the colons in step with
              // the hex digits, including when text is deleted from the middle.
              props.onChange?.(formatMac(e.target.value))
              setPasteError(null)
            }}
            onBlur={() => setTouched(true)}
            className={
              'w-full rounded-lg border bg-gray-800 px-3 py-2 pr-8 font-mono text-sm text-white placeholder:text-gray-500 outline-none transition focus:ring-2 ' +
              (showError
                ? 'border-red-700 focus:border-red-500 focus:ring-red-500/30'
                : 'border-gray-700 focus:border-blue-500 focus:ring-blue-500/30')
            }
          />
          {complete ? (
            <Check
              className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-green-400"
              aria-label="Valid MAC address"
            />
          ) : null}
        </div>

        <div className="relative">
          <button
            type="button"
            onClick={copy}
            disabled={!value}
            aria-label="Copy MAC address"
            className="rounded-lg border border-gray-700 bg-gray-800 p-2 text-gray-400 transition hover:bg-gray-700 hover:text-gray-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {copied ? (
              <ClipboardCheck className="h-4 w-4 text-green-400" aria-hidden />
            ) : (
              <ClipboardCopy className="h-4 w-4" aria-hidden />
            )}
          </button>
          {copied ? (
            <span
              role="status"
              className="absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-green-600 px-1.5 py-0.5 text-[10px] font-semibold text-white"
            >
              Copied!
            </span>
          ) : null}
        </div>

        <button
          type="button"
          onClick={paste}
          aria-label="Paste MAC address from clipboard"
          className="rounded-lg border border-gray-700 bg-gray-800 p-2 text-gray-400 transition hover:bg-gray-700 hover:text-gray-200"
        >
          <ClipboardPaste className="h-4 w-4" aria-hidden />
        </button>
      </div>

      {showError ? (
        <p id={inputId + '-error'} role="alert" className="mt-1 text-xs text-red-400">
          {MAC_ERROR}
        </p>
      ) : null}
      {pasteError ? <p className="mt-1 text-xs text-amber-400">{pasteError}</p> : null}
    </div>
  )
}
