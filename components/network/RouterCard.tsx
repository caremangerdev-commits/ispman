import { RouterLive } from '@/components/network/RouterLive'
import type { NetworkRouter } from '@/lib/data/network'
import { formatBytes } from '@/lib/radius/format'

/**
 * One router on the Network page.
 *
 * THE DOT IS THE TUNNEL AND NOTHING ELSE. It says whether the router is
 * answering us right now. What it has been doing for customers is reported
 * separately below it, because the two can disagree and the disagreement is
 * the interesting part — a router holding its tunnel with no customer
 * connecting for six hours is a tower down behind a healthy router, and a
 * single blended verdict would show that as green.
 */

const DOT: Record<NetworkRouter['status'], string> = {
  up: 'bg-green-400',
  down: 'bg-red-500',
  never: 'bg-red-500',
  waiting: 'bg-gray-500',
  not_on_server: 'bg-amber-400',
  unknown: 'bg-gray-600',
}

/** Oldest hour on the left, the hour we are in on the right. */
function HourBar({ hours }: { hours: boolean[] }) {
  return (
    <div className="flex gap-[2px]" aria-hidden="true">
      {hours.map((on, i) => (
        <span
          key={i}
          className={
            'h-5 flex-1 rounded-[2px] ' + (on ? 'bg-blue-500/70' : 'bg-gray-800')
          }
        />
      ))}
    </div>
  )
}

export function RouterCard({ router, accounting }: { router: NetworkRouter; accounting: boolean }) {
  const a = router.activity

  return (
    <section
      className={
        'rounded-xl border bg-gray-900 p-4 ' +
        (router.revoked ? 'border-gray-800 opacity-60' : 'border-gray-800')
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-white">{router.name}</h3>
          <p className="mt-0.5 font-mono text-[11px] text-gray-500">{router.tunnelIp}</p>
        </div>
        <span className="flex shrink-0 items-center gap-1.5">
          <span className={'h-2 w-2 rounded-full ' + DOT[router.status]} aria-hidden="true" />
          <span className="text-[11px] text-gray-400">
            {router.revoked ? 'Revoked' : router.statusText}
          </span>
        </span>
      </div>

      {!router.revoked && router.hasLogin ? (
        <>
          {router.usage ? (
            <dl className="mt-4 grid grid-cols-2 gap-3">
              <div>
                <dt className="text-[10px] uppercase tracking-wider text-gray-500">Data today</dt>
                <dd className="mt-0.5 text-lg font-semibold tabular-nums text-white">
                  {formatBytes(router.usage.todayDown + router.usage.todayUp)}
                </dd>
                <dd className="text-[11px] tabular-nums text-gray-500">
                  {formatBytes(router.usage.todayDown)} down · {formatBytes(router.usage.todayUp)} up
                </dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-wider text-gray-500">This month</dt>
                <dd className="mt-0.5 text-lg font-semibold tabular-nums text-white">
                  {formatBytes(router.usage.monthDown + router.usage.monthUp)}
                </dd>
                <dd className="text-[11px] tabular-nums text-gray-500">
                  {router.usage.customers} customers measured
                </dd>
              </div>
            </dl>
          ) : (
            <p className="mt-4 text-[11px] text-gray-500">
              No data usage recorded yet. The first figures appear about ten minutes after setup.
            </p>
          )}

          {/* Only asked while its tunnel is up: a router that is down cannot
              answer, and asking it every five seconds would just time out. */}
          {router.status === 'up' ? <RouterLive tunnelId={router.id} /> : null}
        </>
      ) : !router.revoked ? (
        <p className="mt-4 rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-2 text-[11px] leading-relaxed text-gray-400">
          Run the setup command on this router to see its traffic, health and data used. Get it
          under Settings → Router Tunnels.
        </p>
      ) : null}

      {accounting && !router.revoked ? (
        <>
          <dl className="mt-4 grid grid-cols-3 gap-3">
            <div>
              <dt className="text-[10px] uppercase tracking-wider text-gray-500">Customers, 24 h</dt>
              <dd className="mt-0.5 text-lg font-semibold tabular-nums text-white">
                {a.customersDay}
              </dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-wider text-gray-500">New, last hour</dt>
              <dd className="mt-0.5 text-lg font-semibold tabular-nums text-white">
                {a.sessionsHour}
              </dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-wider text-gray-500">Last connection</dt>
              <dd className="mt-0.5 text-sm text-gray-300">
                {router.lastConnectionAgo ?? '\u2014'}
              </dd>
            </div>
          </dl>

          <div className="mt-4">
            <p className="mb-1.5 text-[10px] uppercase tracking-wider text-gray-500">
              Customers connecting, last 24 hours
            </p>
            <HourBar hours={a.hours} />
            <div className="mt-1 flex justify-between text-[10px] text-gray-600">
              <span>24 h ago</span>
              <span>now</span>
            </div>
          </div>

          {router.silent ? (
            <p className="mt-3 text-[11px] text-amber-300/80">
              No customer has connected through this router in 24 hours.
            </p>
          ) : null}

          {!a.interim && !router.silent ? (
            <p className="mt-3 text-[11px] text-gray-500">
              A live count of who is online needs <strong className="font-medium text-gray-400">
              Interim Update</strong> switched on in this router&apos;s RADIUS accounting. Until then
              these figures count connections over the last day.
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  )
}
