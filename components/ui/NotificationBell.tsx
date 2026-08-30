'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import {
  AlertCircle, Bell, CreditCard, LifeBuoy, UserPlus, type LucideIcon,
} from 'lucide-react'

import { markAllNotificationsRead } from '@/app/actions/notifications'
import { timeAgo } from '@/lib/format'
import type { NotificationRow } from '@/lib/types'

const ICONS: Record<string, { icon: LucideIcon; tone: string }> = {
  expiry: { icon: AlertCircle, tone: 'bg-red-500/15 text-red-400' },
  payment: { icon: CreditCard, tone: 'bg-amber-500/15 text-amber-400' },
  ticket: { icon: LifeBuoy, tone: 'bg-blue-500/15 text-blue-400' },
  customer: { icon: UserPlus, tone: 'bg-emerald-500/15 text-emerald-400' },
}

export function NotificationBell({
  items,
  unread,
}: {
  items: NotificationRow[]
  unread: number
}) {
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const wrapRef = useRef<HTMLDivElement>(null)

  // Close on outside click and on Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={'Notifications' + (unread ? ' (' + unread + ' unread)' : '')}
        className="relative flex h-9 w-9 items-center justify-center rounded-lg text-gray-400 transition hover:bg-gray-800 hover:text-gray-200"
      >
        <Bell className="h-5 w-5" aria-hidden />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-11 z-50 w-80 overflow-hidden rounded-xl border border-gray-800 bg-gray-900 shadow-2xl shadow-black/50"
        >
          <div className="flex items-center justify-between border-b border-gray-800 px-4 py-3">
            <p className="text-sm font-semibold text-white">Notifications</p>
            {unread > 0 && (
              <button
                type="button"
                disabled={pending}
                onClick={() => startTransition(() => markAllNotificationsRead())}
                className="text-xs font-medium text-blue-400 transition hover:text-blue-300 disabled:opacity-50"
              >
                {pending ? 'Marking…' : 'Mark all as read'}
              </button>
            )}
          </div>

          <ul className="max-h-96 divide-y divide-gray-800 overflow-y-auto">
            {items.length === 0 && (
              <li className="px-4 py-8 text-center text-sm text-gray-500">
                Nothing to show.
              </li>
            )}
            {items.map((n) => {
              const meta = ICONS[n.type ?? ''] ?? {
                icon: Bell,
                tone: 'bg-gray-700/40 text-gray-400',
              }
              const isUnread = n.status === 'pending'
              return (
                <li
                  key={n.id}
                  className={'flex gap-3 px-4 py-3 ' + (isUnread ? 'bg-blue-500/[0.04]' : '')}
                >
                  <span
                    className={
                      'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ' +
                      meta.tone
                    }
                  >
                    <meta.icon className="h-3.5 w-3.5" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm leading-snug text-gray-200">
                      {n.message}
                    </span>
                    <span className="mt-0.5 block text-xs text-gray-500">
                      {timeAgo(n.created_at)}
                    </span>
                  </span>
                  {isUnread && (
                    <span
                      className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-blue-500"
                      aria-label="Unread"
                    />
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
