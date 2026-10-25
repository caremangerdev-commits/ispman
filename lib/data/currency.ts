import 'server-only'

import { cache } from 'react'

import { getBillSettings } from '@/lib/data/bill-settings'

/**
 * The money symbol a company's STAFF SCREENS print.
 *
 * ONE RESOLUTION, NOT A SECOND ONE. This reads the same value the company's
 * bills and its customer portal have always used — getBillSettings, which
 * takes settings.currency_symbol and falls back to the code (JMD -> J$). A
 * separate lookup here is how a company ends up with US$ on its invoice and
 * J$ on the dashboard that raised it.
 *
 * WHY THIS EXISTS (25 October 2026). lib/format.ts held `const SYMBOL = 'J$'`
 * and 63 call sites printed it, so every tenant's screens said J$ whatever
 * their currency was set to. The bills were already right; only the app was
 * wrong. Found while preparing screenshots of a demo tenant set to USD, which
 * still rendered J$3,500.
 *
 * Cached per request, so a page that formats money in a dozen places still
 * reads settings once.
 */
export const companySymbol = cache(async (companyId: number): Promise<string> => {
  return (await getBillSettings(companyId)).currencySymbol
})
