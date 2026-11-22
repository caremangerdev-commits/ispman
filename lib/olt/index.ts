import 'server-only'

import type { OltDriver } from '@/lib/olt/types'
import { cdata } from '@/lib/olt/cdata'
import { gcom } from '@/lib/olt/gcom'
import { huawei } from '@/lib/olt/huawei'
import { vsol } from '@/lib/olt/vsol'
import { zte } from '@/lib/olt/zte'

/** Every brand ISPMan can talk to. A new brand is one more entry here. */
const DRIVERS: Record<string, OltDriver> = { zte, huawei, vsol, cdata, gcom }

export function oltDriver(brand: string): OltDriver | null {
  return DRIVERS[brand] ?? null
}

export const OLT_BRANDS = Object.values(DRIVERS).map((d) => ({ brand: d.brand, label: d.label }))
