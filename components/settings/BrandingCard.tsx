'use client'

import { useActionState, useMemo, useState } from 'react'
import { useFormStatus } from 'react-dom'

import {
  removeCompanyLogo, saveBrandColor, uploadCompanyLogo, type BrandingResult,
} from '@/app/actions/branding'
import { settingsInput } from '@/components/settings/Modal'
import {
  brandColorNote, brandPalette, DEFAULT_BRAND_COLOR, LOGO_UPLOAD_MAX_BYTES, LOGO_UPLOAD_TYPES,
  normaliseBrandColor, type Brand,
} from '@/lib/brand'
import { blocksFromText, renderEmailHtml } from '@/lib/messaging/email-shell'

/**
 * Logo, colour, and what they do to an email — on Company Settings.
 *
 * ITS OWN FORMS, outside GeneralSettingsForm: see app/actions/branding.ts for
 * why a file input does not belong in a forty-field save.
 *
 * THE PREVIEW IS THE REAL SHELL. It calls the same renderEmailHtml the
 * dispatcher does, with the same brand, so what is shown is what is sent. The
 * one difference is the logo's address: a browser cannot resolve cid:, so the
 * server hands the stored file over as a data URI. The bucket stays private —
 * there is still no URL.
 *
 * The colour previews AS IT IS PICKED, before saving. That is the point of a
 * preview; a colour that makes the button unreadable should be visible before
 * it is on four hundred emails, not after.
 */

export type BrandingCardProps = {
  available: boolean
  companyName: string
  contact: Brand['contact']
  /** The stored derivative as a data URI, and its size. Null when there is no logo. */
  logo: { dataUri: string; width: number; height: number } | null
  /** The saved colour, or null for the default. */
  color: string | null
  /** A message body to preview with, already filled in with sample values. */
  sampleSubject: string
  sampleBody: string
}

function Notice({ state }: { state: BrandingResult | null }) {
  if (!state) return null
  return (
    <p
      role="alert"
      className={
        'rounded-lg border px-3 py-2 text-xs ' +
        (state.ok
          ? 'border-green-900/60 bg-green-950/40 text-green-300'
          : 'border-red-900/60 bg-red-950/50 text-red-300')
      }
    >
      {state.ok ? state.message : state.error}
    </p>
  )
}

function Submit({ label, busy, tone = 'primary', disabled }: {
  label: string
  busy: string
  tone?: 'primary' | 'quiet'
  disabled?: boolean
}) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className={
        'rounded-lg px-3 py-2 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ' +
        (tone === 'primary'
          ? 'bg-blue-600 text-white hover:bg-blue-500'
          : 'border border-gray-700 text-gray-300 hover:border-gray-500 hover:text-white')
      }
    >
      {pending ? busy : label}
    </button>
  )
}

export function BrandingCard({
  available, companyName, contact, logo, color, sampleSubject, sampleBody,
}: BrandingCardProps) {
  const [uploadState, uploadAction] = useActionState<BrandingResult | null, FormData>(uploadCompanyLogo, null)
  const [removeState, removeAction] = useActionState<BrandingResult | null, FormData>(removeCompanyLogo, null)
  const [colorState, colorAction] = useActionState<BrandingResult | null, FormData>(saveBrandColor, null)

  const [fileError, setFileError] = useState<string | null>(null)
  const [hasFile, setHasFile] = useState(false)

  // What is typed, which may not be a colour yet; and the last thing that was.
  const [typed, setTyped] = useState(color ?? '')
  const live = typed.trim() ? normaliseBrandColor(typed) : null
  const invalid = Boolean(typed.trim()) && !live
  const shown = live ?? (invalid ? color : null)

  const html = useMemo(() => renderEmailHtml({
    brand: {
      name: companyName,
      // The shell reads only the size; the bytes are behind `logoSrc`.
      logo: logo ? { png: new Uint8Array(0), width: logo.width, height: logo.height } : null,
      palette: brandPalette(shown),
      contact,
    },
    logoSrc: logo?.dataUri ?? null,
    subject: sampleSubject,
    blocks: blocksFromText(sampleBody),
  }), [companyName, contact, logo, shown, sampleSubject, sampleBody])

  const note = brandColorNote(shown)

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    setHasFile(Boolean(file))
    // Said here, because past the server action's body limit the request is
    // refused before any code of ours runs and the error names nothing useful.
    if (file && file.size > LOGO_UPLOAD_MAX_BYTES) {
      setFileError('That image is ' + Math.ceil(file.size / 1024) + ' KB. The limit is 512 KB.')
      e.target.value = ''
      setHasFile(false)
      return
    }
    setFileError(null)
  }

  return (
    <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
      <h2 className="text-sm font-semibold text-white">Branding</h2>
      <p className="mt-1 text-xs text-gray-500">
        Your logo and colour head every email and every full-page document, such as bills.
        The 80mm receipt is not affected.
      </p>

      {!available ? (
        <p className="mt-4 rounded-lg border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
          Needs migration 0023. Until then, messages go out under your company name in the default colour,
          as previewed here.
        </p>
      ) : null}

      <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <div className="space-y-5">
          {/* ---- Logo ---- */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-gray-400">Logo</p>
            <div className="flex min-h-[5.5rem] items-center justify-center rounded-lg border border-gray-700 bg-white p-4">
              {logo ? (
                // eslint-disable-next-line @next/next/no-img-element -- a data URI from a private bucket; there is no URL for next/image to fetch
                <img src={logo.dataUri} alt={companyName} className="max-h-16 max-w-full" />
              ) : (
                <span className="text-center text-lg font-bold" style={{ color: brandPalette(shown).ink }}>
                  {companyName}
                </span>
              )}
            </div>
            <p className="text-[11px] text-gray-600">
              {logo
                ? 'Stored at ' + logo.width + ' x ' + logo.height + ' on a white background.'
                : 'No logo yet, so your company name is set in its place.'}
            </p>

            <form action={uploadAction} className="space-y-2">
              <input
                type="file"
                name="logo"
                accept={LOGO_UPLOAD_TYPES.join(',')}
                onChange={onFile}
                disabled={!available}
                className="block w-full text-xs text-gray-400 file:mr-3 file:rounded-lg file:border-0 file:bg-gray-800 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-gray-200 hover:file:bg-gray-700 disabled:opacity-50"
              />
              <p className="text-[11px] text-gray-600">
                PNG, JPEG or WebP, up to 512 KB. Wide logos work best. A transparent background is filled with white.
              </p>
              {fileError ? <p className="text-xs text-red-300">{fileError}</p> : <Notice state={uploadState} />}
              <Submit label={logo ? 'Replace logo' : 'Upload logo'} busy="Uploading…" disabled={!available || !hasFile} />
            </form>

            {logo ? (
              <form action={removeAction} className="space-y-2">
                <Notice state={removeState} />
                <Submit label="Remove logo" busy="Removing…" tone="quiet" disabled={!available} />
              </form>
            ) : null}
          </div>

          {/* ---- Colour ---- */}
          <form action={colorAction} className="space-y-2">
            <label htmlFor="brand_color" className="block text-xs font-medium text-gray-400">Brand colour</label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                aria-label="Pick a brand colour"
                value={shown ?? DEFAULT_BRAND_COLOR}
                onChange={(e) => setTyped(e.target.value)}
                disabled={!available}
                className="h-9 w-12 shrink-0 cursor-pointer rounded border border-gray-700 bg-gray-800 p-1 disabled:opacity-50"
              />
              <input
                id="brand_color"
                name="brand_color"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={DEFAULT_BRAND_COLOR + ' (default)'}
                maxLength={7}
                disabled={!available}
                className={settingsInput + ' font-mono'}
              />
            </div>
            <p className="text-[11px] text-gray-600">
              One colour: the rule under your logo, buttons, and your name when there is no logo.
              Leave empty for the default.
            </p>
            {invalid ? <p className="text-xs text-red-300">Enter six hex digits, like #0f766e.</p> : null}
            {note ? <p className="text-xs text-amber-300/90">{note}</p> : null}
            <Notice state={colorState} />
            <Submit label="Save colour" busy="Saving…" disabled={!available || invalid} />
          </form>

          <a
            href="/api/company/letterhead"
            target="_blank"
            rel="noreferrer"
            className="inline-block text-xs font-medium text-blue-400 hover:text-blue-300"
          >
            Open a sample letterhead (PDF)
          </a>
        </div>

        {/* ---- Preview ---- */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-gray-400">Email preview</p>
          <iframe
            title="Email preview"
            // No scripts, no forms, no navigation: it is a picture of an email.
            sandbox=""
            srcDoc={html}
            className="h-[34rem] w-full rounded-lg border border-gray-700 bg-white"
          />
          <p className="text-[11px] text-gray-600">
            The wording is your expiry warning template with sample details. Every message uses this layout.
          </p>
        </div>
      </div>
    </section>
  )
}
