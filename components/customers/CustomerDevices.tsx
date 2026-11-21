'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Plus, X } from 'lucide-react'
import { useState } from 'react'
import { createPortal } from 'react-dom'

import { linkCustomerDevice, unlinkDevice } from '@/app/actions/devices'
import { DeviceIcon } from '@/components/network/DeviceIcon'
import { SignalBars } from '@/components/network/SignalBars'
import { Modal, settingsInput } from '@/components/settings/Modal'
import { MacAddressInput } from '@/components/ui/MacAddressInput'
import type { CustomerDevice } from '@/lib/data/customer-devices'
import { DEVICE_BRANDS, kindLabel, type DeviceKind } from '@/lib/network/classify'

/**
 * The equipment at a customer's premises: one line on the customer's page, and
 * a popup to add to it.
 *
 * ONE LINE, NOT A SECTION. The page already carries the customer's account,
 * billing and connection. What is installed there is a short list — an ONU, or
 * a radio and a router — so it sits in the connection card as a row of small
 * tags, and everything about adding one happens in the popup.
 *
 * MOST OF THESE ARRIVE WITHOUT THE POPUP. An ONU is matched to its customer
 * when the OLT is read, and a radio that carries the customer's MAC address
 * when it is found. The popup is for what could not be matched.
 */

/** What can be at a customer's premises. Routers and OLTs of the network itself are not offered. */
const KINDS: { kind: DeviceKind; label: string }[] = [
  { kind: 'onu', label: 'ONU (fibre)' },
  { kind: 'cpe', label: 'Customer radio (CPE)' },
  { kind: 'router', label: 'Router' },
  { kind: 'ap', label: 'Access point' },
  { kind: 'switch', label: 'Switch' },
  { kind: 'other', label: 'Other' },
]

const label = 'mb-1 block text-xs font-medium text-gray-400'

function LinkDeviceModal({
  customerId, customerName, customerMac, olts, onClose,
}: {
  customerId: number
  customerName: string
  customerMac: string | null
  olts: { id: number; name: string }[]
  onClose: () => void
}) {
  const router = useRouter()
  const [kind, setKind] = useState<DeviceKind>(olts.length ? 'onu' : 'cpe')
  const [serial, setSerial] = useState('')
  const [oltId, setOltId] = useState(olts.length === 1 ? String(olts[0].id) : '')
  const [brand, setBrand] = useState('')
  const [model, setModel] = useState('')
  const [mac, setMac] = useState('')
  const [ip, setIp] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isOnu = kind === 'onu'
  const save = async () => {
    setBusy(true)
    setError(null)
    const res = await linkCustomerDevice({
      customerId,
      kind,
      name: '',
      brand,
      model,
      ip: isOnu ? '' : ip,
      mac,
      serial,
      oltId: isOnu && oltId ? Number(oltId) : null,
      notes,
    })
    setBusy(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    router.refresh()
    onClose()
  }

  return (
    <Modal title={'Link a device to ' + customerName} onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className={label} htmlFor="ld-kind">Device type</label>
          <select
            id="ld-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as DeviceKind)}
            className={settingsInput}
          >
            {KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>{k.label}</option>
            ))}
          </select>
        </div>

        {isOnu ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={label} htmlFor="ld-serial">Serial number</label>
              <input
                id="ld-serial"
                value={serial}
                onChange={(e) => setSerial(e.target.value.toUpperCase())}
                placeholder="ZTEGC1234567"
                autoComplete="off"
                className={settingsInput + ' font-mono'}
              />
              <p className="mt-1 text-[11px] text-gray-500">Printed on the label under the ONU.</p>
            </div>
            <div>
              <label className={label} htmlFor="ld-olt">OLT</label>
              <select id="ld-olt" value={oltId} onChange={(e) => setOltId(e.target.value)} className={settingsInput}>
                <option value="">Not sure</option>
                {olts.map((o) => (
                  <option key={o.id} value={o.id}>{o.name}</option>
                ))}
              </select>
            </div>
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={label} htmlFor="ld-brand">Brand</label>
            <select id="ld-brand" value={brand} onChange={(e) => setBrand(e.target.value)} className={settingsInput}>
              <option value="">Choose…</option>
              {DEVICE_BRANDS.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={label} htmlFor="ld-model">Model</label>
            <input
              id="ld-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={isOnu ? 'F660' : 'LiteBeam M5'}
              className={settingsInput}
            />
          </div>
        </div>

        <div>
          <div className="mb-1 flex items-baseline justify-between">
            <span className="text-xs font-medium text-gray-400">MAC address{isOnu ? ' (optional)' : ''}</span>
            {customerMac && !isOnu ? (
              <button
                type="button"
                onClick={() => setMac(customerMac)}
                className="text-[11px] text-blue-400 hover:underline"
              >
                Same as the customer&apos;s
              </button>
            ) : null}
          </div>
          <MacAddressInput value={mac} onChange={setMac} />
        </div>

        {!isOnu ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={label} htmlFor="ld-ip">IP address (optional)</label>
              <input
                id="ld-ip"
                value={ip}
                onChange={(e) => setIp(e.target.value)}
                placeholder="10.10.4.50"
                className={settingsInput + ' font-mono'}
              />
            </div>
            <div>
              <label className={label} htmlFor="ld-serial2">Serial number (optional)</label>
              <input
                id="ld-serial2"
                value={serial}
                onChange={(e) => setSerial(e.target.value.toUpperCase())}
                autoComplete="off"
                className={settingsInput + ' font-mono'}
              />
            </div>
          </div>
        ) : null}

        <div>
          <label className={label} htmlFor="ld-notes">Note (optional)</label>
          <input
            id="ld-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="On the roof, facing the tower"
            maxLength={200}
            className={settingsInput}
          />
        </div>

        {error ? <p className="rounded-lg bg-red-950/30 px-3 py-2 text-xs text-red-300">{error}</p> : null}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm text-gray-300 transition hover:bg-gray-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-60"
          >
            {busy ? 'Linking…' : 'Link device'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

export function CustomerDevices({
  customerId, customerName, customerMac, devices, olts, canEdit,
}: {
  customerId: number
  customerName: string
  customerMac: string | null
  devices: CustomerDevice[]
  olts: { id: number; name: string }[]
  canEdit: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [removing, setRemoving] = useState<number | null>(null)

  const unlink = async (id: number) => {
    setRemoving(id)
    await unlinkDevice(id, customerId)
    setRemoving(null)
    router.refresh()
  }

  return (
    <div className="flex items-start justify-between gap-3 px-4 py-2">
      <dt className="shrink-0 pt-1 text-xs text-gray-500">Devices</dt>
      <dd className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-1.5">
        {devices.map((d) => {
          const id = d.serial ?? d.mac ?? d.name
          const what = [kindLabel(d.kind), d.brand, d.model].filter(Boolean).join(' · ')
          const body = (
            <>
              <DeviceIcon kind={d.kind} className="h-4 w-4 shrink-0 text-gray-400" />
              <span className="font-mono">{id}</span>
              {d.live ? (
                <>
                  <span
                    className={'h-1.5 w-1.5 rounded-full ' + (d.live.online ? 'bg-green-400' : 'bg-red-500')}
                    aria-hidden
                  />
                  <span className={d.live.online ? 'text-green-400' : 'text-red-400'}>
                    {d.live.online ? 'Online' : 'Offline'}
                  </span>
                  {d.live.online ? <SignalBars label="Signal" dbm={d.live.rx} side="onu" /> : null}
                </>
              ) : null}
            </>
          )
          return (
            <span
              key={d.id}
              title={what + (d.linkedBy === 'auto' ? ' · matched by ISPMan' : '') + (d.notes ? ' · ' + d.notes : '')}
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-800 bg-gray-950/60 py-0.5 pl-1.5 pr-1 text-[11px] text-gray-200"
            >
              {d.kind === 'onu' && d.oltId ? (
                <Link href={'/dashboard/network/olts/' + d.oltId} className="inline-flex items-center gap-1.5 hover:text-blue-400">
                  {body}
                </Link>
              ) : (
                body
              )}
              {canEdit ? (
                <button
                  type="button"
                  onClick={() => void unlink(d.id)}
                  disabled={removing === d.id}
                  aria-label={'Unlink ' + id}
                  className="rounded p-0.5 text-gray-500 hover:bg-gray-800 hover:text-red-300 disabled:opacity-50"
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              ) : null}
            </span>
          )
        })}
        {devices.length === 0 && !canEdit ? <span className="text-xs text-gray-500">—</span> : null}
        {canEdit ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="inline-flex items-center gap-1 rounded-md bg-gray-800 px-2 py-1 text-[11px] font-medium text-gray-200 transition hover:bg-gray-700"
          >
            <Plus className="h-3 w-3" aria-hidden />
            Link device
          </button>
        ) : null}
      </dd>
      {open
        ? createPortal(
            <LinkDeviceModal
              customerId={customerId}
              customerName={customerName}
              customerMac={customerMac}
              olts={olts}
              onClose={() => setOpen(false)}
            />,
            document.body
          )
        : null}
    </div>
  )
}
