'use client'

import { createContext, useContext, useMemo, type ReactNode } from 'react'

import { CURRENCY_SYMBOL, formatCurrency, formatCurrencyExact } from '@/lib/format'

/**
 * The company's money symbol, for CLIENT components.
 *
 * A client component cannot read settings, and threading a symbol through
 * every modal and form would mean touching every caller of every caller. So
 * the dashboard layout — which already knows the company — puts the symbol
 * here once, and anything under it asks for it.
 *
 * The default is the J$ fallback from lib/format.ts, so a component rendered
 * outside the provider (a test, a page not yet wired) prints what it printed
 * before rather than an empty prefix.
 */
const CurrencyContext = createContext<string>(CURRENCY_SYMBOL)

export function CurrencyProvider({
  symbol, children,
}: {
  symbol: string
  children: ReactNode
}) {
  return <CurrencyContext.Provider value={symbol}>{children}</CurrencyContext.Provider>
}

/**
 * `const { money, moneyExact, symbol } = useMoney()`.
 *
 * The two formatters are the ones the server uses (lib/format.ts), bound to
 * this company's symbol — not a second implementation. `symbol` on its own is
 * for input prefixes and column headings.
 */
export function useMoney() {
  const symbol = useContext(CurrencyContext)
  return useMemo(
    () => ({
      symbol,
      money: (value: number | string | null | undefined) => formatCurrency(value, symbol),
      moneyExact: (value: number | string | null | undefined) =>
        formatCurrencyExact(value, symbol),
    }),
    [symbol]
  )
}
