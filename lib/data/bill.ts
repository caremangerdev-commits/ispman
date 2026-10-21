import 'server-only'

import { effectiveBillDay, ymd } from '@/lib/billing'
import {
  addMonthsYmd, buildBillDocument, type BillChargeRow, type BillDocument, type BillInput,
  type BillPaymentRow,
} from '@/lib/bill/document'
import type { BillTemplate } from '@/lib/bill/settings'
import { brandFor, loadLetterhead } from '@/lib/data/brand'
import { getBillSettings } from '@/lib/data/bill-settings'
import { PAYMENT_METHOD_LABELS, toPaymentMethod } from '@/lib/data/checkoff'
import { getEnabledGateway } from '@/lib/data/payment-gateways'
import { portalUrlForCompany } from '@/lib/data/portal'
import { expiryOf } from '@/lib/domain'
import { instantToDateOnly } from '@/lib/format'
import { getRadiusStatus, radiusConfigured } from '@/lib/radius-db'
import { getSchemaCapabilities } from '@/lib/schema'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * Reads what a bill is made from, for one customer of one company, and hands
 * it to lib/bill/document.ts#buildBillDocument.
 *
 * COMPANY-SCOPED THROUGH THE SERVICE ROLE, like the rest of lib/data: the
 * caller resolves the company from a session (staff, or the portal's customer)
 * and never from the request.
 *
 * Every column is read only once the migration that adds it is applied, so a
 * bill renders against any shape of the schema: before 0011 there are no
 * balances to reconcile and the bill is the plan and the payments.
 */

const MISSING = new Set(['PGRST205', '42P01', '42703'])

/** "Card, online" for a gateway payment, "Cash" for cash, and so on. */
function methodLabel(method: string | null | undefined, agent: string | null | undefined): string | null {
  if (agent && /^online payment/i.test(agent)) return 'Card, online'
  if (!method) return null
  const m = toPaymentMethod(method)
  return m === 'other' ? null : PAYMENT_METHOD_LABELS[m]
}

export async function loadBill(
  companyId: number,
  customerId: number,
  opts: { template?: BillTemplate; month?: string | null; paymentId?: number | null } = {}
): Promise<BillDocument | null> {
  const caps = await getSchemaCapabilities()
  const db = tenantClient()

  let cols = 'id, first_name, last_name, address, phone, monthly_rate, last_bill_date, mac_address'
  if (caps.connectionTypes) cols += ', customer_type, pppoe_username'
  if (caps.billing) cols += ', carried_balance, account_credit, bill_date'
  if (caps.accountNumbers) cols += ', account_number'
  if (caps.catalog) {
    cols += ', service_plans!customers_service_plan_id_fkey(name, speed_down_mbps, speed_up_mbps)'
  }

  const [customerRes, settingsRes, companyRes, settings, brand, letterhead] = await Promise.all([
    db.from('customers').select(cols).eq('company_id', companyId).eq('id', customerId).maybeSingle(),
    db.from('settings').select('bill_date, timezone').eq('company_id', companyId).maybeSingle(),
    db.from('companies').select('name, phone, email').eq('id', companyId).maybeSingle(),
    getBillSettings(companyId),
    brandFor(companyId),
    loadLetterhead(companyId),
  ])
  if (customerRes.error) throw new Error('Bill: customer load failed: ' + customerRes.error.message)
  if (!customerRes.data) return null

  const c = customerRes.data as unknown as {
    id: number
    first_name: string | null
    last_name: string | null
    address: string | null
    phone: string | null
    monthly_rate: number | string | null
    last_bill_date: string | null
    mac_address: string | null
    customer_type?: string | null
    pppoe_username?: string | null
    carried_balance?: number | string | null
    account_credit?: number | string | null
    bill_date?: number | null
    account_number?: string | null
    service_plans?: { name: string | null; speed_down_mbps: number | null; speed_up_mbps: number | null } | null
  }
  const s = settingsRes.data as { bill_date: number | null; timezone: string | null } | null
  const company = companyRes.data as { name: string | null; phone: string | null; email: string | null } | null
  const tz = s?.timezone || 'America/Jamaica'
  const today = instantToDateOnly(new Date(), tz)

  // --- What a month costs: the rate plus every add-on, as the till prices it.
  let addons = 0
  if (caps.billing && caps.catalog) {
    const { data: links } = await db
      .from('customer_additional_services')
      .select('additional_services(monthly_price)')
      .eq('customer_id', c.id)
    addons = ((links ?? []) as unknown as { additional_services: { monthly_price: number | string | null } | null }[])
      .reduce((t, l) => t + Number(l.additional_services?.monthly_price ?? 0), 0)
  }

  // --- Where service runs to: the network's word, else the bill date's.
  const identity = caps.connectionTypes && c.customer_type === 'pppoe' ? c.pppoe_username : c.mac_address
  const network = identity && radiusConfigured() ? await getRadiusStatus(identity).catch(() => null) : null
  const derived = expiryOf({ last_bill_date: c.last_bill_date })
  const expiry = network?.expiry ? ymd(network.expiry) : derived ? ymd(derived) : null

  // --- The service payments -------------------------------------------------
  let payCols = 'id, amount, payment_date, months_paid, agent'
  if (caps.checkoff) payCols += ', payment_method'
  if (caps.billing) payCols += ', carried_balance_before, carried_balance_after, access_granted_until'
  if (caps.otherPayments) payCols += ', payment_kind, paid_on, service_active_until'
  const { data: payData, error: payError } = await db
    .from('payments')
    .select(payCols)
    .eq('company_id', companyId)
    .eq('customer_id', customerId)
    .order('payment_date', { ascending: true })
    .limit(2000)
  if (payError) throw new Error('Bill: payments load failed: ' + payError.message)

  const payments: BillPaymentRow[] = ((payData ?? []) as unknown as {
    id: number
    amount: number | string
    payment_date: string
    months_paid: number | null
    agent: string | null
    payment_method?: string | null
    carried_balance_before?: number | string | null
    carried_balance_after?: number | string | null
    access_granted_until?: string | null
    payment_kind?: string | null
    paid_on?: string | null
    service_active_until?: string | null
  }[])
    // Service payments only: a one-off charge or a reconnection fee is paid
    // against its own charge and never moves the carried balance.
    .filter((p) => p.payment_kind !== 'other')
    .filter((p) => Number(p.amount) > 0)
    .map((p) => {
      const when = new Date(p.payment_date)
      const date = p.paid_on ?? (Number.isFinite(when.getTime()) ? instantToDateOnly(when, tz) : p.payment_date.slice(0, 10))
      const num = (v: number | string | null | undefined) => (v === null || v === undefined ? null : Number(v))
      return {
        id: p.id,
        date,
        amount: Number(p.amount),
        method: methodLabel(p.payment_method, p.agent),
        monthsPaid: Number(p.months_paid ?? 0),
        carriedBefore: num(p.carried_balance_before),
        carriedAfter: num(p.carried_balance_after),
        runsTo: (p.service_active_until ?? p.access_granted_until ?? null)?.slice(0, 10) ?? null,
      }
    })

  // --- The engine's charges (0024) -----------------------------------------
  let charges: BillChargeRow[] = []
  if (caps.billingEngine) {
    const { data, error } = await db
      .from('bill_charges')
      .select('period_start, period_end, charged_on, amount, credit_applied, carried_balance_before, carried_balance_after')
      .eq('company_id', companyId)
      .eq('customer_id', customerId)
      .order('charged_on', { ascending: true })
      .limit(2000)
    if (error && !MISSING.has(error.code ?? '')) throw new Error('Bill: charges load failed: ' + error.message)
    charges = ((data ?? []) as {
      period_start: string
      period_end: string
      charged_on: string
      amount: number | string
      credit_applied: number | string | null
      carried_balance_before: number | string
      carried_balance_after: number | string
    }[])
      .filter((r) => Number(r.amount) > 0)
      .map((r) => ({
        date: r.charged_on,
        periodStart: r.period_start,
        periodEnd: r.period_end,
        amount: Number(r.amount),
        creditApplied: Number(r.credit_applied ?? 0),
        carriedBefore: Number(r.carried_balance_before),
        carriedAfter: Number(r.carried_balance_after),
      }))
  }

  // --- How to pay: in person, by bank, and online when a gateway is on.
  const [gateway, portalUrl] = await Promise.all([
    caps.paymentGateways ? getEnabledGateway(companyId).catch(() => null) : Promise.resolve(null),
    portalUrlForCompany(companyId).catch(() => null),
  ])
  const online = gateway && portalUrl ? portalUrl.replace(/^https?:\/\//, '').replace(/\/$/, '') : null

  const plan = caps.catalog && c.service_plans?.name
    ? {
        name: c.service_plans.name,
        downMbps: Number(c.service_plans.speed_down_mbps ?? 0),
        upMbps: Number(c.service_plans.speed_up_mbps ?? 0),
      }
    : null

  const input: BillInput = {
    template: opts.template ?? settings.template,
    today,
    company: {
      name: (company?.name ?? brand.name).trim(),
      phone: company?.phone?.trim() || null,
      email: company?.email?.trim() || null,
    },
    settings,
    brand,
    letterhead,
    customer: {
      id: c.id,
      name: [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Account #' + c.id,
      address: c.address,
      phone: c.phone?.trim() || null,
      accountNumber: caps.accountNumbers ? (c.account_number ?? null) : null,
      plan,
      monthlyCharge: Number(c.monthly_rate ?? 0) + addons,
      carried: caps.billing ? Number(c.carried_balance ?? 0) : 0,
      credit: caps.billing ? Number(c.account_credit ?? 0) : 0,
      expiry,
      billDay: effectiveBillDay(c.bill_date, s?.bill_date),
    },
    payments,
    charges,
    howToPay: { inPerson: settings.paymentNote, bank: settings.bankDetails, online },
    month: opts.month ?? null,
    paymentId: opts.paymentId ?? null,
  }
  return buildBillDocument(input)
}

/**
 * A bill for a customer nobody has, in the company's own settings, brand and
 * letterhead — so Settings > Bill Design can show each template before it goes out.
 * The rows are the reference's: three months of a 3,500 plan, paid each month.
 */
export async function sampleBill(companyId: number, template: BillTemplate): Promise<BillDocument> {
  const [settings, brand, letterhead, companyRes, settingsRes, gateway, portalUrl] = await Promise.all([
    getBillSettings(companyId),
    brandFor(companyId),
    loadLetterhead(companyId),
    tenantClient().from('companies').select('name, phone, email').eq('id', companyId).maybeSingle(),
    tenantClient().from('settings').select('bill_date, timezone').eq('company_id', companyId).maybeSingle(),
    getEnabledGateway(companyId).catch(() => null),
    portalUrlForCompany(companyId).catch(() => null),
  ])
  const company = companyRes.data as { name: string | null; phone: string | null; email: string | null } | null
  const s = settingsRes.data as { bill_date: number | null; timezone: string | null } | null
  const today = instantToDateOnly(new Date(), s?.timezone || 'America/Jamaica')
  const billDay = effectiveBillDay(null, s?.bill_date ?? 5)

  // Bill days for the last three months, and a payment nine to twelve days
  // after each, the last one leaving the account clear.
  const day = (monthsBack: number, d: number) => {
    const base = addMonthsYmd(today.slice(0, 7) + '-01', -monthsBack)
    return base.slice(0, 8) + String(Math.min(d, 28)).padStart(2, '0')
  }
  const rate = 3500
  const charged = [2, 1, 0].map((back) => day(back, billDay)).filter((d) => d <= today)
  const payments: BillPaymentRow[] = charged.map((d, i) => {
    const paid = d.slice(0, 8) + String(Math.min(28, Number(d.slice(8)) + 9)).padStart(2, '0')
    return {
      id: 17418 + i,
      date: paid <= today ? paid : today,
      amount: rate,
      method: i === charged.length - 1 && gateway ? 'Card, online' : 'Cash',
      monthsPaid: 1,
      carriedBefore: rate,
      carriedAfter: 0,
      runsTo: addMonthsYmd(d, 1),
    }
  })
  const expiry = charged.length ? addMonthsYmd(charged[charged.length - 1], 1) : addMonthsYmd(today, 1)

  return buildBillDocument({
    template,
    today,
    company: {
      name: (company?.name ?? brand.name).trim() || 'Your company',
      phone: company?.phone?.trim() || null,
      email: company?.email?.trim() || null,
    },
    settings,
    brand,
    letterhead,
    customer: {
      id: 10140,
      name: 'Shelley Mitchell',
      address: 'Barnstaple District\nSt Elizabeth',
      phone: '876 555 5555',
      accountNumber: '10140',
      plan: { name: 'MAX P', downMbps: 10, upMbps: 10 },
      monthlyCharge: rate,
      carried: 0,
      credit: 0,
      expiry,
      billDay,
    },
    payments,
    charges: [],
    howToPay: {
      inPerson: settings.paymentNote,
      bank: settings.bankDetails,
      online: gateway && portalUrl ? portalUrl.replace(/^https?:\/\//, '').replace(/\/$/, '') : null,
    },
  })
}
