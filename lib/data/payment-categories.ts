import { getSchemaCapabilities } from '@/lib/schema'
import { tenantClient } from '@/lib/supabase/tenant'

export type PaymentCategory = { id: number; name: string }

/**
 * The longest category name that can be typed at the till.
 *
 * Matches payment_categories.name VARCHAR(60) in migration 0013, so a name the
 * form accepts can never be rejected by the column.
 */
export const CATEGORY_NAME_MAX = 60

/**
 * The "Purpose" list for one company, ordered by name.
 *
 * Deliberately NOT misc_categories. That table is the customer *segment* list
 * (School, Government, Hotel, Church) shown on the customer form and in
 * Settings; a purpose added at the till must not turn up there as a segment a
 * customer can be filed under. See migration 0013.
 */
export async function listPaymentCategories(companyId: number): Promise<PaymentCategory[]> {
  const caps = await getSchemaCapabilities()
  if (!caps.otherPayments) return []

  const db = tenantClient()
  const { data, error } = await db
    .from('payment_categories')
    .select('id, name')
    .eq('company_id', companyId)
    .order('name', { ascending: true })

  if (error) throw new Error('Failed to load payment categories: ' + error.message)
  return (data ?? []) as unknown as PaymentCategory[]
}

/**
 * Finds or creates a category by name for one company.
 *
 * Matching is case-insensitive and runs before the insert, so a cashier typing
 * "installation" against an existing "Installation" reuses it instead of
 * creating a near-duplicate that would then sit in the dropdown twice. The
 * unique index in 0013 is the backstop for the race between the two.
 */
export async function findOrCreatePaymentCategory(
  companyId: number,
  rawName: string
): Promise<{ ok: true; category: PaymentCategory } | { ok: false; error: string }> {
  const name = rawName.trim().replace(/\s+/g, ' ')

  if (!name) return { ok: false, error: 'Enter a name for the new category.' }
  if (name.length > CATEGORY_NAME_MAX) {
    return { ok: false, error: `Category name must be ${CATEGORY_NAME_MAX} characters or fewer.` }
  }

  const db = tenantClient()

  const { data: existing, error: findError } = await db
    .from('payment_categories')
    .select('id, name')
    .eq('company_id', companyId)
    .ilike('name', name)
    .maybeSingle()

  if (findError) return { ok: false, error: 'Could not check categories: ' + findError.message }
  if (existing) return { ok: true, category: existing as unknown as PaymentCategory }

  const { data, error } = await db
    .from('payment_categories')
    .insert({ company_id: companyId, name })
    .select('id, name')
    .single()

  if (error) {
    // 23505 = the unique index fired, so another request created the same
    // category between the lookup above and this insert. Read theirs.
    if (error.code === '23505') {
      const { data: raced } = await db
        .from('payment_categories')
        .select('id, name')
        .eq('company_id', companyId)
        .ilike('name', name)
        .maybeSingle()

      if (raced) return { ok: true, category: raced as unknown as PaymentCategory }
    }
    return { ok: false, error: 'Could not add the category: ' + error.message }
  }

  return { ok: true, category: data as unknown as PaymentCategory }
}
