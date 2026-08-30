'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, LogOut, Settings } from 'lucide-react'

import { signOut } from '@/app/actions/auth'

export function UserMenu({
  name,
  email,
  role,
  initials,
}: {
  name: string
  email: string
  role: string
  initials: string
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

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

  const linkClass =
    'flex items-center gap-2.5 px-4 py-2 text-sm text-gray-300 transition hover:bg-gray-800 hover:text-white'

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-2 rounded-lg py-1 pl-1 pr-2 transition hover:bg-gray-800"
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-600 text-xs font-semibold text-white">
          {initials}
        </span>
        <ChevronDown className="h-4 w-4 text-gray-500" aria-hidden />
        <span className="sr-only">Account menu for {name}</span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-11 z-50 w-56 overflow-hidden rounded-xl border border-gray-800 bg-gray-900 py-1 shadow-2xl shadow-black/50"
        >
          <div className="border-b border-gray-800 px-4 py-3">
            <p className="truncate text-sm font-medium text-white">{name}</p>
            <p className="truncate text-xs text-gray-500">{email}</p>
            <span className="mt-1.5 inline-block rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-400">
              {role}
            </span>
          </div>

          {/* No Profile entry: /dashboard/profile has not been built. */}
          <Link href="/dashboard/settings" className={linkClass} onClick={() => setOpen(false)}>
            <Settings className="h-4 w-4" aria-hidden />
            Settings
          </Link>

          <div className="my-1 border-t border-gray-800" />

          <form action={signOut}>
            <button
              type="submit"
              className={linkClass + ' w-full hover:text-red-400'}
            >
              <LogOut className="h-4 w-4" aria-hidden />
              Log out
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
