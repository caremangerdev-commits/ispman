import type { Metadata } from 'next'
import Link from 'next/link'
import {
  Building2, CreditCard, FileText, Gauge, History, MessageSquare, Network, Package, Receipt, Tags, UserCog,
  Users, type LucideIcon,
} from 'lucide-react'

import { CATALOG_HINT, getSchemaCapabilities } from '@/lib/schema'
import { getSession } from '@/lib/session'
import { settingsStatus, type StatusTone } from '@/lib/data/settings-status'
import { SETTINGS_GROUPS, visibleSettings, type SettingsIcon } from '@/lib/settings-nav'

export const metadata: Metadata = { title: 'Settings · ISPMan' }

const ICONS: Record<SettingsIcon, LucideIcon> = {
  receipt: Receipt,
  building: Building2,
  gauge: Gauge,
  package: Package,
  tags: Tags,
  users: Users,
  userCog: UserCog,
  messageSquare: MessageSquare,
  network: Network,
  creditCard: CreditCard,
  fileText: FileText,
  history: History,
}

const TONE: Record<StatusTone, { dot: string; text: string }> = {
  ok: { dot: 'bg-emerald-400', text: 'text-emerald-300' },
  attention: { dot: 'bg-amber-400', text: 'text-amber-300' },
  off: { dot: 'bg-gray-600', text: 'text-gray-400' },
}

export default async function SettingsPage() {
  const { profile, company } = await getSession()
  const caps = await getSchemaCapabilities()
  const sections = visibleSettings(profile.role)
  const status = await settingsStatus(company.id)

  return (
    <div className="space-y-8">
      {/* No page heading here: the title lives in the header bar (PageTitle),
          and repeating it was the same word twice on one screen. */}
      <p className="text-sm text-gray-400">
        Configure {company.name}. Each card says how that part stands right now.
      </p>

      {!caps.catalog ? (
        <div className="rounded-xl border border-amber-900/50 bg-amber-950/30 px-4 py-3">
          <p className="text-sm font-semibold text-amber-300">Migration 0005 not applied</p>
          <p className="mt-1 text-xs leading-relaxed text-amber-300/80">
            Service Plans, Additional Services and Misc Categories need their tables.{' '}
            {CATALOG_HINT}
          </p>
        </div>
      ) : null}

      {SETTINGS_GROUPS.map((g) => {
        const inGroup = sections.filter((s) => s.group === g.key)
        if (inGroup.length === 0) return null
        return (
          <section key={g.key} aria-labelledby={'settings-' + g.key}>
            <h2 id={'settings-' + g.key} className="mb-3 text-base font-semibold text-white">{g.label}</h2>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {inGroup.map((s) => {
                const Icon = ICONS[s.icon]
                const blocked =
                  (s.needsCatalog && !caps.catalog) || (s.needsSms && !caps.sms) ||
                  (s.needsTunnels && !caps.routerTunnels) ||
                  (s.needsGateways && !caps.paymentGateways)
                const blockedBy =
                  s.needsSms && !caps.sms ? '0021'
                    : s.needsTunnels && !caps.routerTunnels ? '0033'
                      : s.needsGateways && !caps.paymentGateways ? '0034'
                        : '0005'
                const st = blocked ? null : status[s.key]

                return (
                  <Link
                    key={s.key}
                    href={s.href}
                    className="group flex flex-col rounded-xl border border-gray-800 bg-gray-900 p-5 transition hover:border-blue-500/40 hover:bg-gray-800/60"
                  >
                    <div className="flex items-center gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-400">
                        <Icon className="h-4.5 w-4.5" aria-hidden />
                      </span>
                      <p className="text-[15px] font-semibold text-white group-hover:text-blue-300">{s.label}</p>
                    </div>
                    <p className="mt-3 text-sm leading-relaxed text-gray-400">{s.description}</p>
                    <div className="mt-auto pt-4">
                      {blocked ? (
                        <p className="flex items-center gap-2 text-sm text-amber-300">
                          <span className="h-2 w-2 shrink-0 rounded-full bg-amber-400" aria-hidden />
                          Needs migration {blockedBy}
                        </p>
                      ) : st ? (
                        <p className={'flex items-center gap-2 text-sm ' + TONE[st.tone].text}>
                          <span className={'h-2 w-2 shrink-0 rounded-full ' + TONE[st.tone].dot} aria-hidden />
                          {st.text}
                        </p>
                      ) : null}
                    </div>
                  </Link>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}
