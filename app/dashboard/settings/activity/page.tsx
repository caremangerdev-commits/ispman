import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { ACTIVITY_GROUPS, listActivity, typeLabel, type ActivityGroup } from '@/lib/data/activity'
import { getGeneralSettings } from '@/lib/data/company'
import { formatDateTime, humaniseLogDetail } from '@/lib/format'
import { getSession } from '@/lib/session'
import { canOpenSetting } from '@/lib/settings-nav'

export const metadata: Metadata = { title: 'Activity Log · ISPMan' }

const YMD = /^\d{4}-\d{2}-\d{2}$/

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''

/**
 * Everything staff (and ISPMan's own background jobs) did in this company,
 * newest first: one list across every customer, payment, OLT and setting.
 * Filters are plain links and a GET form, so a filtered view can be bookmarked
 * or sent to someone.
 */
export default async function ActivityPage({ searchParams }: PageProps<'/dashboard/settings/activity'>) {
  const session = await getSession()
  if (!canOpenSetting(session.profile.role, 'activity')) redirect('/dashboard?denied=manage_users')
  const { company } = session

  const sp = await searchParams
  const groupRaw = one(sp.group)
  const group = ACTIVITY_GROUPS.some((g) => g.key === groupRaw) ? (groupRaw as ActivityGroup) : null
  const userId = Number(one(sp.user)) || null
  const from = YMD.test(one(sp.from)) ? one(sp.from) : null
  const to = YMD.test(one(sp.to)) ? one(sp.to) : null
  const q = one(sp.q).trim().slice(0, 80)
  const page = Math.max(0, Math.min(200, Number(one(sp.page)) || 0))

  const [{ rows, more, staff }, settings] = await Promise.all([
    listActivity(company.id, { userId, group, from, to, q, page }),
    getGeneralSettings(company.id),
  ])

  const link = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams()
    const cur: Record<string, string | null> = {
      group, user: userId ? String(userId) : null, from, to, q: q || null, page: null, ...patch,
    }
    for (const [k, v] of Object.entries(cur)) if (v) p.set(k, v)
    const s = p.toString()
    return '/dashboard/settings/activity' + (s ? '?' + s : '')
  }

  const field = 'rounded-lg border border-gray-700 bg-gray-950 px-3 py-1.5 text-sm text-gray-100'
  const chip = (active: boolean) =>
    'rounded-full px-3 py-1 text-xs font-medium transition ' +
    (active ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700')

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-400">
        Everything done in {company.name}, newest first: by staff, and by ISPMan&apos;s own automatic jobs.
      </p>

      <div className="flex flex-wrap gap-2">
        <Link href={link({ group: null })} className={chip(group === null)}>Everything</Link>
        {ACTIVITY_GROUPS.map((g) => (
          <Link key={g.key} href={link({ group: g.key })} className={chip(group === g.key)}>{g.label}</Link>
        ))}
      </div>

      <form method="get" className="flex flex-wrap items-end gap-2 rounded-xl border border-gray-800 bg-gray-900 p-3">
        {group ? <input type="hidden" name="group" value={group} /> : null}
        <label className="text-xs text-gray-400">
          Who
          <select name="user" defaultValue={userId ?? ''} className={field + ' mt-1 block'}>
            <option value="">Anyone</option>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="text-xs text-gray-400">
          From
          <input type="date" name="from" defaultValue={from ?? ''} className={field + ' mt-1 block'} />
        </label>
        <label className="text-xs text-gray-400">
          To
          <input type="date" name="to" defaultValue={to ?? ''} className={field + ' mt-1 block'} />
        </label>
        <label className="min-w-[12rem] flex-1 text-xs text-gray-400">
          Containing
          <input name="q" defaultValue={q} placeholder="A name, an amount, a MAC…" className={field + ' mt-1 block w-full'} />
        </label>
        <button type="submit" className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-blue-500">Show</button>
        {userId || from || to || q ? (
          <Link href={link({ user: null, from: null, to: null, q: null })} className="px-2 py-1.5 text-sm text-gray-400 hover:text-gray-200">Clear</Link>
        ) : null}
      </form>

      <div className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
        {rows.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-gray-500">Nothing matches these filters.</p>
        ) : (
          <ul className="divide-y divide-gray-800">
            {rows.map((r) => (
              <li key={r.id} className="grid gap-1 px-5 py-3 sm:grid-cols-[11rem_1fr]">
                <div className="text-xs text-gray-500">
                  <p>{formatDateTime(r.at, settings.timezone)}</p>
                  <p className="mt-0.5 text-gray-400">{r.userName ?? 'ISPMan (automatic)'}</p>
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-100">
                    {typeLabel(r.type)}
                    {r.customer ? (
                      <>
                        {' · '}
                        <Link href={'/dashboard/customers/' + r.customer.id} className="text-blue-400 hover:underline">
                          {r.customer.name}
                        </Link>
                      </>
                    ) : null}
                  </p>
                  <p className="mt-0.5 break-words text-sm text-gray-400">{humaniseLogDetail(r.details)}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex justify-between text-sm">
        {page > 0 ? <Link href={link({ page: String(page - 1) })} className="text-blue-400 hover:underline">Newer</Link> : <span />}
        {more ? <Link href={link({ page: String(page + 1) })} className="text-blue-400 hover:underline">Older</Link> : null}
      </div>
    </div>
  )
}
