'use client'

import { CheckCircle2, X, XCircle } from 'lucide-react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'

/**
 * Toast driven by the URL.
 *
 * Success paths here end in a server-side `redirect()`, which discards any
 * client state — so the message travels as a `?toast=` param and this strips it
 * from the URL once shown, leaving a clean link and preventing the toast from
 * reappearing on refresh or back-navigation.
 */
export function Toast() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  const message = params.get('toast')
  const urlKind = params.get('toastKind') === 'error' ? 'error' : 'success'

  const [visible, setVisible] = useState(false)
  const [shown, setShown] = useState<string | null>(null)
  // The kind is latched alongside the message: the effect below strips both
  // params from the URL, so re-reading toastKind afterwards would always come
  // back null and render an error toast as a success one.
  const [shownKind, setShownKind] = useState<'error' | 'success'>('success')

  // Adjust during render rather than in an effect (see react-hooks/set-state-in-effect).
  if (message && message !== shown) {
    setShown(message)
    setShownKind(urlKind)
    setVisible(true)
  }

  useEffect(() => {
    if (!message) return

    // Drop the params immediately so a refresh does not replay the toast.
    const next = new URLSearchParams(params.toString())
    next.delete('toast')
    next.delete('toastKind')
    const qs = next.toString()
    router.replace(pathname + (qs ? '?' + qs : ''), { scroll: false })

    const timer = setTimeout(() => setVisible(false), 4000)
    return () => clearTimeout(timer)
  }, [message, params, pathname, router])

  if (!visible || !shown) return null

  const Icon = shownKind === 'error' ? XCircle : CheckCircle2

  return (
    <div
      role="status"
      aria-live="polite"
      className={
        'fixed bottom-6 right-6 z-50 flex items-start gap-2.5 rounded-xl border px-4 py-3 shadow-2xl shadow-black/50 ' +
        (shownKind === 'error'
          ? 'border-red-900/60 bg-red-950/90 text-red-200'
          : 'border-green-900/60 bg-green-950/90 text-green-200')
      }
    >
      <Icon
        className={'mt-0.5 h-4 w-4 shrink-0 ' + (shownKind === 'error' ? 'text-red-400' : 'text-green-400')}
        aria-hidden
      />
      <p className="max-w-xs text-sm">{shown}</p>
      <button
        type="button"
        onClick={() => setVisible(false)}
        aria-label="Dismiss"
        className="ml-1 rounded p-0.5 text-current/60 transition hover:text-current"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  )
}
