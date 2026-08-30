import type { AccessDecision, BillingType } from '@/lib/billing'
import type { CustomerStatus } from '@/lib/status'

/** Row shapes for the tables this dashboard reads. Mirrors the Supabase schema. */

/**
 * Permissive schema generic for the Supabase client.
 *
 * Without a generic, supabase-js resolves write payloads to `never` and every
 * `.update()` fails to typecheck. Replace this with the real generated types
 * (`supabase gen types typescript`) once the CLI is set up — the row types
 * below are hand-maintained in the meantime.
 */
export type LooseDatabase = {
  public: {
    Tables: Record<
      string,
      {
        Row: Record<string, unknown>
        Insert: Record<string, unknown>
        Update: Record<string, unknown>
        Relationships: []
      }
    >
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}

export type Company = {
  id: number
  name: string
  email: string | null
  phone: string | null
  plan: string | null
  status: string | null
}

export type AppUser = {
  id: number
  company_id: number
  first_name: string | null
  last_name: string | null
  email: string
  role: string | null
}

export type Customer = {
  id: number
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  mac_address: string | null
  monthly_rate: number | string | null
  balance: number | string | null
  last_bill_date: string | null
  date_added: string | null
  /**
   * Migration 0011. Declared as plain numbers rather than the `number | string`
   * union used by the older money columns: PostgREST returns these `numeric`
   * columns as JSON numbers, which the 0011 rollout confirmed.
   *
   * Reads still have to cope with the columns being absent — until 0011 is
   * applied they are not selected at all — so the data layer defaults
   * `billing_type` to prepaid and the balances to 0.
   */
  billing_type: BillingType
  carried_balance: number
  account_credit: number
  /** Day of month postpaid billing is generated. Null for prepaid. */
  bill_date: number | null
  last_billed_date: string | null
}

/**
 * A row of `payments`, including the billing columns added by migration 0011.
 *
 * Every 0011 field is nullable: rows written before the migration have none of
 * them, and a prepaid payment leaves the billing-period pair empty because it
 * does not bill for a period already used.
 */
export type Payment = {
  id: number
  amount: number | string
  months_paid: number | null
  payment_type: string | null
  payment_method?: string | null
  payment_date: string
  agent: string | null
  notes: string | null
  /** migration 0011 */
  billing_period_start: string | null
  billing_period_end: string | null
  access_granted_until: string | null
  carried_balance_before: number | null
  carried_balance_after: number | null
  /** Null when the payment cleared the full amount due. */
  access_decision: AccessDecision | null
}

export type PaymentRow = {
  id: number
  amount: number | string
  payment_type: string | null
  payment_date: string
  agent: string | null
  customers: Pick<Customer, 'first_name' | 'last_name'> | null
}

export type TicketRow = {
  id: number
  title: string
  status: string | null
  priority: string | null
  created_at: string
  customers: Pick<Customer, 'first_name' | 'last_name'> | null
}

export type LogRow = {
  id: number
  type: string | null
  details: string | null
  created_at: string
}

export type NotificationRow = {
  id: number
  type: string | null
  message: string | null
  status: string | null
  created_at: string
}

/** Connection provisioning type — `customers.customer_type` (migration 0003). */
export type CustomerType = 'dhcp' | 'pppoe' | 'hotspot'

export const CUSTOMER_TYPES: CustomerType[] = ['dhcp', 'pppoe', 'hotspot']

export const CUSTOMER_TYPE_LABELS: Record<CustomerType, string> = {
  dhcp: 'DHCP',
  pppoe: 'PPPoE',
  hotspot: 'Hotspot',
}

export function toCustomerType(value: string | null | undefined): CustomerType {
  return CUSTOMER_TYPES.includes(value as CustomerType) ? (value as CustomerType) : 'dhcp'
}

/** Physical link type — `customers.connection_type` (migration 0005). */
export type ConnectionType = 'wired' | 'wireless'
export const CONNECTION_TYPES: ConnectionType[] = ['wired', 'wireless']
export const CONNECTION_TYPE_LABELS: Record<ConnectionType, string> = {
  wired: 'Wired',
  wireless: 'Wireless',
}
export function toConnectionType(v: string | null | undefined): ConnectionType {
  return CONNECTION_TYPES.includes(v as ConnectionType) ? (v as ConnectionType) : 'wireless'
}

/** Account classification — `customers.customer_category` (migration 0005). */
export type CustomerCategory = 'residential' | 'business'
export const CUSTOMER_CATEGORIES: CustomerCategory[] = ['residential', 'business']
export const CUSTOMER_CATEGORY_LABELS: Record<CustomerCategory, string> = {
  residential: 'Residential',
  business: 'Business',
}
export function toCustomerCategory(v: string | null | undefined): CustomerCategory {
  return CUSTOMER_CATEGORIES.includes(v as CustomerCategory)
    ? (v as CustomerCategory)
    : 'residential'
}

export type ServicePlan = {
  id: number
  name: string
  speed_down_mbps: number
  speed_up_mbps: number
  monthly_price: number | string
  description: string | null
  status: string | null
}

export type AdditionalService = {
  id: number
  name: string
  monthly_price: number | string
  description: string | null
  status: string | null
}

export type MiscCategory = {
  id: number
  name: string
}

/** "Premium · 50↓ 20↑ Mbps" */
export function describePlan(p: Pick<ServicePlan, 'name' | 'speed_down_mbps' | 'speed_up_mbps'>) {
  return p.name + ' · ' + p.speed_down_mbps + '↓ ' + p.speed_up_mbps + '↑ Mbps'
}

/** How a renewal is anchored — `customers.expiry_mode` (migration 0004). */
export type ExpiryMode = 'from_expiry' | 'from_payment'

export const EXPIRY_MODES: ExpiryMode[] = ['from_expiry', 'from_payment']

export const EXPIRY_MODE_LABELS: Record<ExpiryMode, string> = {
  from_expiry: 'From Expiry Date',
  from_payment: 'From Payment Date',
}

export const EXPIRY_MODE_HELP: Record<ExpiryMode, string> = {
  from_expiry: 'Renews from the current expiry, so unused days are not lost.',
  from_payment: 'Renews from the payment date, restarting the cycle today.',
}

export function toExpiryMode(value: string | null | undefined): ExpiryMode {
  return EXPIRY_MODES.includes(value as ExpiryMode) ? (value as ExpiryMode) : 'from_expiry'
}

/**
 * A customer enriched with derived facts the UI needs.
 *
 * `expiresAt` here is the BILLING expiry (last_bill_date + 1 month) and drives
 * invoicing only. Whether the customer can actually get online is
 * `radiusStatus`, which is filled in after a network-registry lookup — see
 * lib/status.ts. The two are deliberately separate.
 */
export type CustomerWithExpiry = Customer & {
  expiresAt: Date | null
  daysUntilExpiry: number | null
  /** Set by the caller after batchGetRadiusStatus(); absent until then. */
  radiusStatus?: CustomerStatus
  /** Network expiry, as stored. */
  radiusExpiry?: Date | null
}

/**
 * Re-exported so the billing vocabulary is reachable from the same module as
 * the row types it describes, matching how ExpiryMode and CustomerType are
 * already used across the app. lib/billing.ts stays the definition site.
 */
export {
  BILLING_TYPES, BILLING_TYPE_HELP, BILLING_TYPE_LABELS, toBillingType,
} from '@/lib/billing'
export type { AccessDecision, BillingType } from '@/lib/billing'
