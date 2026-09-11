import type { Metadata } from 'next'
import Link from 'next/link'

import { Composer } from '@/components/messages/Composer'
import { listMiscCategories, listServicePlans } from '@/lib/data/catalog'
import { loadEnrichedCustomers } from '@/lib/data/customers'
import { canSend, getSmsDevice, getSmsSettings, listSmsBatches } from '@/lib/data/sms'
import { timeAgo } from '@/lib/format'
import { getSchemaCapabilities } from '@/lib/schema'
import { requirePermission } from '@/lib/session'
import { relayConfigured } from '@/lib/sms/relay'

export const metadata: Metadata = { title: 'Send a Message · ISPMan' }

export default async function MessagesPage() {
  // MANAGER AND ABOVE. The route is gated, not just the nav entry — a cashier
  // typing this URL is redirected exactly as one who clicked a hidden link
  // would be.
  const { company } = await requirePermission('send_bulk_sms')

  const caps = await getSchemaCapabilities()
  if (!caps.sms) {
    return (
      <div className="max-w-3xl space-y-4">
        <div className="rounded-xl border border-amber-900/50 bg-amber-950/30 px-4 py-3">
          <p className="text-sm font-semibold text-amber-300">Migration required</p>
          <p className="mt-1 text-xs leading-relaxed text-amber-300/80">
            Messaging needs migration 0021. Ask your administrator to apply it.
          </p>
        </div>
      </div>
    )
  }

  const [settings, device, customers, categories, plans, batches] = await Promise.all([
    getSmsSettings(company.id),
    getSmsDevice(company.id),
    loadEnrichedCustomers(company.id),
    listMiscCategories(company.id).catch(() => []),
    listServicePlans(company.id).catch(() => []),
    listSmsBatches(company.id, 25),
  ])

  const addresses = [
    ...new Set(customers.map((c) => (c.address ?? '').trim()).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b))

  const accessPoints = [
    ...new Set(customers.map((c) => (c.access_point ?? '').trim()).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b))

  const cutOffDates = [
    ...new Set(customers.map((c) => c.cut_off_date).filter((d): d is number => typeof d === 'number')),
  ].sort((a, b) => a - b)

  const hasBothConnectionTypes =
    new Set(customers.map((c) => c.connection_type).filter(Boolean)).size > 1

  // Why sending is not possible, in the order the operator would fix them.
  const blockedReason = !relayConfigured()
    ? 'This server has no SMS relay configured. Ask your administrator.'
    : !settings.enabled
      ? 'SMS is switched off for this company. Turn it on under Settings → SMS Notifications.'
      : !device
        ? 'No phone is paired. Pair one under Settings → SMS Notifications.'
        : null

  return (
    <div className="max-w-4xl space-y-5">
      <p className="text-sm text-gray-500">
        Compose a message, choose who receives it, and see exactly who it will reach
        before anything is sent.
      </p>

      <Composer
        miscCategories={categories.map((c) => ({ id: c.id, name: c.name }))}
        servicePlans={plans.map((p) => ({ id: p.id, name: p.name }))}
        addresses={addresses}
        accessPoints={accessPoints}
        cutOffDates={cutOffDates}
        hasBothConnectionTypes={hasBothConnectionTypes}
        templates={settings.templates}
        canSendNow={canSend(settings, device)}
        blockedReason={blockedReason}
      />

      {/* The record. A batch is who sent it, when, what it said, and how it
          went — reachable long after the messages themselves are gone. */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-gray-200">Recent batches</h2>

        {batches.length === 0 ? (
          <p className="rounded-xl border border-gray-800 bg-gray-900 px-4 py-8 text-center text-sm text-gray-600">
            Nothing has been sent yet.
          </p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead>
                  <tr className="border-b border-gray-800 text-[11px] uppercase tracking-wider text-gray-500">
                    <th scope="col" className="px-4 py-2.5 font-semibold">Sent</th>
                    <th scope="col" className="px-4 py-2.5 font-semibold">By</th>
                    <th scope="col" className="px-4 py-2.5 font-semibold">Message</th>
                    <th scope="col" className="px-4 py-2.5 text-right font-semibold">Sent</th>
                    <th scope="col" className="px-4 py-2.5 text-right font-semibold">Failed</th>
                    <th scope="col" className="px-4 py-2.5 text-right font-semibold">Skipped</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {batches.map((b) => (
                    <tr key={b.id} className="transition hover:bg-gray-800/40">
                      <td className="whitespace-nowrap px-4 py-2.5 text-gray-400">
                        <Link
                          href={'/dashboard/messages/' + b.id}
                          className="transition hover:text-blue-400"
                        >
                          {timeAgo(b.createdAt)}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-gray-400">
                        {b.sentByName}
                      </td>
                      <td className="max-w-[22rem] px-4 py-2.5">
                        <span className="block truncate text-gray-300" title={b.body}>
                          {b.body}
                        </span>
                        {b.audience ? (
                          <span className="mt-0.5 block truncate text-[11px] text-gray-600">
                            {b.audience}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2.5 text-right font-medium text-green-400">
                        {b.sent}
                        <span className="text-gray-600"> / {b.total}</span>
                      </td>
                      <td className="px-4 py-2.5 text-right text-gray-400">
                        {b.failed > 0 ? (
                          <span className="text-red-400">{b.failed}</span>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-right text-gray-500">
                        {b.skipped || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
