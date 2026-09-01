import type { Metadata } from 'next'
import Link from 'next/link'
import {
  Building2, Gauge, Package, Tags, UserCog, Users, type LucideIcon,
} from 'lucide-react'

import { CATALOG_HINT, getSchemaCapabilities } from '@/lib/schema'
import { getSession } from '@/lib/session'
import { tenantClient } from '@/lib/supabase/tenant'
import { visibleSettings, type SettingsIcon } from '@/lib/settings-nav'

export const metadata: Metadata = { title: 'Settings · ISPMan' }

const ICONS: Record<SettingsIcon, LucideIcon> = {
  building: Building2,
  gauge: Gauge,
  package: Package,
  tags: Tags,
  users: Users,
  userCog: UserCog,
}

/**
 * Row counts for the cards.
 *
 * Tables from migration 0005 may not exist yet, so each count is attempted
 * independently and a missing table yields null (rendered as a dash) instead
 * of failing the page.
 */
async function counts(companyId: number, hasCatalog: boolean) {
  const db = tenantClient()

  const countOf = async (table: string) => {
    const { count, error } = await db
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
    return error ? null : (count ?? 0)
  }

  const [users, plans, addons, misc] = await Promise.all([
    countOf('users'),
    hasCatalog ? countOf('service_plans') : Promise.resolve(null),
    hasCatalog ? countOf('additional_services') : Promise.resolve(null),
    hasCatalog ? countOf('misc_categories') : Promise.resolve(null),
  ])

  return {
    users,
    'service-plans': plans,
    'additional-services': addons,
    'misc-categories': misc,
    company: null as number | null,
  } as Record<string, number | null>
}

export default async function SettingsPage() {
  const { profile, company } = await getSession()
  const caps = await getSchemaCapabilities()
  const sections = visibleSettings(profile.role)
  const totals = await counts(company.id, caps.catalog)

  return (
    <div className="space-y-4">
      {/* No page heading here: the title lives in the header bar (PageTitle),
          and repeating it was the same word twice on one screen. */}
      <p className="text-sm text-gray-500">
        Configure {company.name}.
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

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {sections.map((s) => {
          const Icon = ICONS[s.icon]
          const count = totals[s.key]
          const blocked = s.needsCatalog && !caps.catalog

          return (
            <Link
              key={s.key}
              href={s.href}
              className="group rounded-xl border border-gray-800 bg-gray-900 p-5 transition hover:border-gray-700 hover:bg-gray-800/60"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-500/10 text-blue-400">
                  <Icon className="h-4.5 w-4.5" aria-hidden />
                </span>
                {blocked ? (
                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-400">
                    Needs 0005
                  </span>
                ) : count !== null ? (
                  <span className="rounded bg-gray-800 px-2 py-0.5 text-[11px] font-semibold text-gray-300">
                    {count}
                  </span>
                ) : null}
              </div>

              <p className="mt-3 text-sm font-semibold text-white group-hover:text-blue-400">
                {s.label}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-gray-500">{s.description}</p>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
