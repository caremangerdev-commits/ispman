'use client'

import { useEffect, useState } from 'react'

import { onuAcsAction, onuAcsStatus, type OnuAcsStatus } from '@/app/actions/olts'
import { Modal } from '@/components/settings/Modal'

const small = 'rounded-md border border-gray-700 px-2.5 py-1 text-xs text-gray-200 hover:bg-gray-800 disabled:opacity-50'

function when(iso: string | null): string {
  if (!iso) return 'never'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

/** What ISPMan's ACS knows of one ONU, in a pop-up from its row. */
export function OnuAcsButton({ serial, canManage }: { serial: string; canManage: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={small}>
        Wi-Fi &amp; internet
      </button>
      {open ? <OnuAcsDialog serial={serial} canManage={canManage} onClose={() => setOpen(false)} /> : null}
    </>
  )
}

function OnuAcsDialog({ serial, canManage, onClose }: { serial: string; canManage: boolean; onClose: () => void }) {
  const [status, setStatus] = useState<OnuAcsStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const res = await onuAcsStatus(serial)
        if (!live) return
        if (res.ok) setStatus(res.status)
        else setNote({ ok: false, text: res.error })
      } catch {
        if (live) setNote({ ok: false, text: 'Could not reach ISPMan. Reload the page and try again.' })
      }
    })()
    return () => {
      live = false
    }
  }, [serial])

  const act = async (action: 'resend' | 'reboot') => {
    setBusy(action)
    setNote(null)
    try {
      const res = await onuAcsAction(serial, action)
      setNote(res.ok ? { ok: true, text: res.message } : { ok: false, text: res.error })
    } catch {
      setNote({ ok: false, text: 'Could not reach ISPMan. Reload the page and try again.' })
    }
    setBusy(null)
  }

  const row = (label: string, value: React.ReactNode) => (
    <div className="flex gap-3 py-1.5 text-sm">
      <dt className="w-36 shrink-0 text-gray-500">{label}</dt>
      <dd className="min-w-0 break-words text-gray-100">{value}</dd>
    </div>
  )

  return (
    <Modal title="Wi-Fi & internet" onClose={onClose}>
      <div className="space-y-4">
        {!status && !note ? <p className="text-sm text-gray-400">Reading…</p> : null}
        {status && !status.reached ? (
          <p className="text-sm leading-relaxed text-gray-300">
            This ONU has not checked in with ISPMan&apos;s ACS yet, so ISPMan cannot set its Wi-Fi or internet login. It
            needs the ACS address set on it, by the OLT when it is authorized (ZTE) or once on the ONU itself. The address
            is under the OLT&apos;s Settings → New ONUs.
          </p>
        ) : null}
        {status?.reached ? (
          <dl className="divide-y divide-gray-800">
            {row('Last checked in', when(status.lastSeen))}
            {row('Model', status.model ?? 'unknown')}
            {row('Wi-Fi names now', status.wifiNames.length ? status.wifiNames.join(', ') : 'not read yet')}
            {row('Internet login', status.pppoeUser ?? 'none (not PPPoE, or not read yet)')}
            {row('ISPMan last sent', when(status.sentAt))}
            {status.wifiName ? row('Wi-Fi name sent', status.wifiName) : null}
            {status.wifiPassword ? row('Wi-Fi password', <span className="font-mono">{status.wifiPassword}</span>) : null}
          </dl>
        ) : null}
        {note ? (
          <p className={'rounded-lg px-3 py-2 text-xs ' + (note.ok ? 'bg-emerald-950/40 text-emerald-300' : 'bg-red-950/30 text-red-300')}>
            {note.text}
          </p>
        ) : null}
        {canManage && status?.reached ? (
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void act('resend')} disabled={!!busy} className={small}>
              {busy === 'resend' ? 'Sending…' : 'Send setup again'}
            </button>
            <button type="button" onClick={() => void act('reboot')} disabled={!!busy} className={small}>
              {busy === 'reboot' ? 'Rebooting…' : 'Reboot'}
            </button>
          </div>
        ) : null}
      </div>
    </Modal>
  )
}
