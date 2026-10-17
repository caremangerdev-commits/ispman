'use client'

import { useEffect } from 'react'

/**
 * Reloads to `to` after `seconds`. Used by the payment-return page while the
 * webhook is still in flight: the page re-checks the payment's status until it
 * is confirmed, then stops (the parent only renders this while there are tries
 * left, so it cannot loop forever). JS-light — one timeout, no polling library.
 */
export function AutoRefresh({ to, seconds }: { to: string; seconds: number }) {
  useEffect(() => {
    const id = setTimeout(() => {
      window.location.href = to
    }, seconds * 1000)
    return () => clearTimeout(id)
  }, [to, seconds])
  return null
}
