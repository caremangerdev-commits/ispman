'use server'

import { revalidatePath } from 'next/cache'

import { MONEY_NOTIFICATION_TYPES } from '@/lib/data/dashboard'
import { can } from '@/lib/permissions'
import { getSession } from '@/lib/session'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * Marks every pending notification for the caller's company as sent.
 *
 * The company id comes from the session, never from the client, so one tenant
 * cannot clear another tenant's queue.
 *
 * Only what the caller's bell SHOWS: a role without
 * view_customer_billing_history is not shown the online-payment alerts
 * (lib/data/dashboard.ts#getNotifications), so it must not be the one that
 * marks them read before anyone who can see them has.
 */
export async function markAllNotificationsRead() {
  const { company, profile } = await getSession()
  const supabase = tenantClient()

  let update = supabase
    .from('notifications_queue')
    .update({ status: 'sent', sent_at: new Date().toISOString() })
    .eq('company_id', company.id)
    .eq('status', 'pending')
  if (!can(profile.role, 'view_customer_billing_history')) {
    update = update.not('type', 'in', '(' + MONEY_NOTIFICATION_TYPES.join(',') + ')')
  }

  const { error } = await update

  if (error) throw new Error('Could not mark notifications read: ' + error.message)

  revalidatePath('/dashboard')
}
