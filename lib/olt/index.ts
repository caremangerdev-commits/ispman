import 'server-only'

import type { OltDriver } from '@/lib/olt/types'
import { zte } from '@/lib/olt/zte'

/** Every brand ISPMan can talk to. A new brand is one more entry here. */
const DRIVERS: Record<string, OltDriver> = { zte }

export function oltDriver(brand: string): OltDriver | null {
  return DRIVERS[brand] ?? null
}

export const OLT_BRANDS = Object.values(DRIVERS).map((d) => ({ brand: d.brand, label: d.label }))
