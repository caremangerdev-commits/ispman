'use client'

import { Pencil } from 'lucide-react'
import { useState } from 'react'
import { createPortal, useFormStatus } from 'react-dom'

import { adjustHandover } from '@/app/actions/checkoff'
import { Modal } from '@/components/settings/Modal'

function ConfirmButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? 'Saving…' : 'Save Changes'}
    </button>
  )
}

const input =
  'w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white outline-none ' +
  'transition focus:border-amber-500 focus:ring-2 focus:ring-amber-500/30 disabled:cursor-not-allowed disabled:opacity-50'

export type HandoverEditable = {
  id: number
  /** Date and time in the COMPANY's zone, prefilled by the server. */
  date: string
  time: string
  agentId: number | null
  agentName: string
  receivedById: number | null
  amountReceived: number | null
  systemTotal: number
  isAllAgents: boolean
  migrated: boolean
}

/**
 * Admin-only: restate a recorded handover.
 *
 * Mounted only for a role that holds edit_checkoff, and the server action checks
 * the same permission itself — hiding the button is a courtesy, not the guard.
 * A reason is required and is logged with every old and new value.
 *
 * Date and time are the company's clock, not the browser's: the server prefills
 * them in the company's zone and reads them back in it.
 */
export function EditHandoverModal({
  row,
  agents,
  symbol,
}: {
  row: HandoverEditable
  agents: { id: number; name: string }[]
  symbol: string
}) {
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState(row.amountReceived === null ? '' : String(row.amountReceived))
  const [system, setSystem] = useState(String(row.systemTotal))
  const [reason, setReason] = useState('')

  const money = (n: number) =>
    symbol + new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(n)

  // The difference is shown, never typed: the server recomputes it from these two.
  const amountN = Number(amount)
  const systemN = Number(system)
  const showDiff =
    !row.migrated && amount !== '' && Number.isFinite(amountN) && Number.isFinite(systemN)
  const diff = showDiff ? amountN - systemN : 0

  const ready = reason.trim() !== ''

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={'Edit handover ' + row.id}
        className="inline-flex items-center gap-1 rounded-lg bg-amber-500/10 px-2.5 py-1 text-[11px] font-semibold text-amber-400 transition hover:bg-amber-500/20"
      >
        <Pencil className="h-3 w-3" aria-hidden />
        Edit
      </button>

      {open
        ? createPortal(
          <Modal title={'Edit Handover #' + row.id} onClose={() => setOpen(false)}>
            <form action={adjustHandover} className="space-y-4">
              <input type="hidden" name="id" value={row.id} />

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label htmlFor={'ho_date_' + row.id} className="block text-xs font-medium text-gray-400">
                    Date
                  </label>
                  <input
                    id={'ho_date_' + row.id}
                    name="date"
                    type="date"
                    required
                    defaultValue={row.date}
                    className={input + ' [color-scheme:dark]'}
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor={'ho_time_' + row.id} className="block text-xs font-medium text-gray-400">
                    Time
                  </label>
                  <input
                    id={'ho_time_' + row.id}
                    name="time"
                    type="time"
                    required
                    defaultValue={row.time}
                    className={input + ' [color-scheme:dark]'}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label htmlFor={'ho_agent_' + row.id} className="block text-xs font-medium text-gray-400">
                  Handed over by
                </label>
                <select
                  id={'ho_agent_' + row.id}
                  name="agent_id"
                  defaultValue={row.agentId ?? ''}
                  disabled={row.isAllAgents}
                  className={input}
                >
                  {/* A legacy row may name someone who is not a user here. Keeping
                      the name as recorded is the blank option. */}
                  <option value="">
                    {row.agentId === null ? 'Keep “' + row.agentName + '”' : 'Keep as recorded'}
                  </option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
                {row.isAllAgents ? (
                  <p className="text-[11px] text-gray-600">
                    This is the all-agents summary, not one person.
                  </p>
                ) : null}
              </div>

              <div className="space-y-1.5">
                <label htmlFor={'ho_recv_' + row.id} className="block text-xs font-medium text-gray-400">
                  Received by
                </label>
                <select
                  id={'ho_recv_' + row.id}
                  name="received_by"
                  defaultValue={row.receivedById ?? ''}
                  className={input}
                >
                  <option value="">{row.receivedById === null ? 'Not recorded' : 'Keep as recorded'}</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </div>

              <div className={'grid gap-3 ' + (row.migrated ? 'grid-cols-1' : 'grid-cols-2')}>
                <div className="space-y-1.5">
                  <label htmlFor={'ho_amt_' + row.id} className="block text-xs font-medium text-gray-400">
                    Amount handed over
                  </label>
                  <input
                    id={'ho_amt_' + row.id}
                    name="amount_received"
                    type="number"
                    step="0.01"
                    min="0"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    disabled={row.amountReceived === null}
                    placeholder={row.amountReceived === null ? 'on summary row' : ''}
                    className={input}
                  />
                </div>
                {row.migrated ? null : (
                  <div className="space-y-1.5">
                    <label htmlFor={'ho_sys_' + row.id} className="block text-xs font-medium text-gray-400">
                      System total
                    </label>
                    <input
                      id={'ho_sys_' + row.id}
                      name="system_total"
                      type="number"
                      step="0.01"
                      min="0"
                      value={system}
                      onChange={(e) => setSystem(e.target.value)}
                      className={input}
                    />
                  </div>
                )}
              </div>

              {showDiff ? (
                <p className="text-xs text-gray-500">
                  Difference:{' '}
                  <span className={diff === 0 ? 'text-gray-400' : diff < 0 ? 'text-red-400' : 'text-amber-400'}>
                    {diff > 0 ? '+' : ''}{money(diff)}
                  </span>{' '}
                  — worked out from the two amounts, not typed.
                </p>
              ) : row.migrated ? (
                <p className="text-[11px] text-gray-600">
                  A migrated handover has no system total or difference; only the amount can be restated.
                </p>
              ) : null}

              <div className="space-y-1.5">
                <label htmlFor={'ho_reason_' + row.id} className="block text-xs font-medium text-gray-400">
                  Reason <span className="text-gray-600">(required)</span>
                </label>
                <textarea
                  id={'ho_reason_' + row.id}
                  name="reason"
                  required
                  rows={3}
                  maxLength={500}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Handed over on the 3rd but entered on the 5th."
                  className={input + ' resize-y'}
                />
                <p className="text-xs text-gray-500">
                  Recorded in the log with your name, the time, and every old and new value.
                </p>
              </div>

              <p className="rounded-lg border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-300/80">
                This changes the handover record only. The payments it cleared keep their own
                check-off time and person, and what is outstanding is not affected.
              </p>

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-semibold text-gray-300 transition hover:bg-gray-700"
                >
                  Cancel
                </button>
                <span className={ready ? '' : 'pointer-events-none opacity-60'}>
                  <ConfirmButton />
                </span>
              </div>
            </form>
          </Modal>,
          document.body
        )
        : null}
    </>
  )
}
