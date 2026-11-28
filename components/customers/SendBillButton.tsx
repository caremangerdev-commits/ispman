'use client'

import { Mail, MessageSquare, Send } from 'lucide-react'
import { useState } from 'react'
import { createPortal } from 'react-dom'

import { previewBillSend, sendCustomerBill, type BillSendPreview, type SendBillResult } from '@/app/actions/bills'
import { Modal, settingsInput } from '@/components/settings/Modal'
import { countSegments } from '@/lib/sms/templates'

const CHANNEL_ROW = 'rounded-lg border border-gray-800 p-3'

/**
 * "Send bill" on the customer record: a pop-up that shows exactly what goes,
 * by email (the PDF bill with its cover note) and by text (the bill in a few
 * words, which staff may edit), before anything is sent. Either or both.
 */
export function SendBillButton({ customerId, customerName }: { customerId: number; customerName: string }) {
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<BillSendPreview | null>(null)
  const [useEmail, setUseEmail] = useState(false)
  const [useSms, setUseSms] = useState(false)
  const [smsText, setSmsText] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<SendBillResult | null>(null)

  const start = async () => {
    setOpen(true)
    setPreview(null)
    setResult(null)
    try {
      const p = await previewBillSend(customerId)
      setPreview(p)
      if (p.ok) {
        setUseEmail(p.email.ok)
        setUseSms(p.sms.ok)
        setSmsText(p.sms.ok ? p.sms.body : '')
      }
    } catch {
      setPreview({ ok: false, error: 'Could not reach ISPMan. Reload the page and try again.' })
    }
  }

  const send = async () => {
    setBusy(true)
    try {
      setResult(await sendCustomerBill({ customerId, email: useEmail, sms: useSms, smsText }))
    } catch {
      setResult({ ok: false, lines: [{ channel: 'email', ok: false, text: 'Could not reach ISPMan. Reload the page and try again.' }] })
    }
    setBusy(false)
  }

  const seg = countSegments(smsText)

  return (
    <>
      <button
        type="button"
        onClick={() => void start()}
        className="inline-flex items-center gap-1 font-medium text-blue-400 transition hover:text-blue-300"
      >
        <Send className="h-3.5 w-3.5" aria-hidden />
        Send bill
      </button>

      {open
        ? createPortal(
          <Modal title={'Send ' + customerName + ' their bill'} onClose={() => setOpen(false)}>
            {!preview ? <p className="text-sm text-gray-400">Preparing the bill…</p> : null}
            {preview && !preview.ok ? <p className="text-sm text-red-300">{preview.error}</p> : null}

            {preview?.ok && !result ? (
              <div className="space-y-3">
                {/* Email */}
                <div className={CHANNEL_ROW}>
                  <label className="flex items-center gap-2 text-sm font-medium text-gray-100">
                    <input type="checkbox" checked={useEmail} disabled={!preview.email.ok} onChange={(e) => setUseEmail(e.target.checked)} />
                    <Mail className="h-4 w-4 text-gray-400" aria-hidden />
                    Email
                    {preview.email.ok ? <span className="font-normal text-gray-400">to {preview.email.to}</span> : null}
                  </label>
                  {preview.email.ok ? (
                    <div className="mt-2 space-y-1.5">
                      <p className="text-xs text-gray-400">
                        <span className="text-gray-500">Subject:</span> {preview.email.subject}
                      </p>
                      <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-gray-950 p-2.5 font-sans text-xs leading-relaxed text-gray-300">
                        {preview.email.body}
                      </pre>
                      <p className="text-xs text-gray-500">
                        The bill goes with it as a PDF.{' '}
                        <a href={preview.pdfUrl} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">
                          See the PDF
                        </a>
                      </p>
                    </div>
                  ) : (
                    <p className="mt-1 text-xs text-gray-500">{preview.email.reason}</p>
                  )}
                </div>

                {/* Text */}
                <div className={CHANNEL_ROW}>
                  <label className="flex items-center gap-2 text-sm font-medium text-gray-100">
                    <input type="checkbox" checked={useSms} disabled={!preview.sms.ok} onChange={(e) => setUseSms(e.target.checked)} />
                    <MessageSquare className="h-4 w-4 text-gray-400" aria-hidden />
                    Text
                    {preview.sms.ok ? <span className="font-normal text-gray-400">to +{preview.sms.to.replace(/^\+/, '')}</span> : null}
                  </label>
                  {preview.sms.ok ? (
                    <div className="mt-2 space-y-1">
                      <textarea
                        aria-label="The text message"
                        value={smsText}
                        onChange={(e) => setSmsText(e.target.value)}
                        rows={4}
                        maxLength={640}
                        className={settingsInput + ' text-xs leading-relaxed'}
                      />
                      <p className="text-[11px] text-gray-500">
                        {seg.characters} characters, {seg.segments} {seg.segments === 1 ? 'text' : 'texts'}
                        {seg.encoding === 'UCS2' ? '. A special character makes each text shorter: use plain letters to keep it to fewer texts.' : '.'}
                      </p>
                    </div>
                  ) : (
                    <p className="mt-1 text-xs text-gray-500">{preview.sms.reason}</p>
                  )}
                </div>

                <div className="flex justify-end gap-2 pt-1">
                  <button type="button" onClick={() => setOpen(false)} className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-semibold text-gray-300 hover:bg-gray-700">
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void send()}
                    disabled={busy || (!useEmail && !useSms) || (useSms && !smsText.trim())}
                    className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {busy ? 'Sending…' : useEmail && useSms ? 'Send email and text' : useSms ? 'Send text' : 'Send email'}
                  </button>
                </div>
              </div>
            ) : null}

            {result ? (
              <div className="space-y-3">
                {result.lines.map((l) => (
                  <p key={l.channel} className={'rounded-lg px-3 py-2 text-sm ' + (l.ok ? 'bg-emerald-950/40 text-emerald-300' : 'bg-red-950/30 text-red-300')}>
                    {l.text}
                  </p>
                ))}
                <p className="text-xs text-gray-500">Messages leave within a minute or two.</p>
                <div className="flex justify-end">
                  <button type="button" onClick={() => setOpen(false)} className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-semibold text-gray-300 hover:bg-gray-700">
                    Close
                  </button>
                </div>
              </div>
            ) : null}
          </Modal>,
          document.body
        )
        : null}
    </>
  )
}
