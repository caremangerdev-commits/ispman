'use server'

import { revalidatePath } from 'next/cache'

import { getSession } from '@/lib/session'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * Marks every pending notification for the caller's company as sent.
 *
 * The company id comes from the session, never from the client, so one tenant
 * cannot clear another tenant's queue.
 */
export async function markAllNotificationsRead() {
  const { company } = await getSession()
  const supabase = tenantClient()

  const { error } = await supabase
    .from('notifications_queue')
    .update({ status: 'sent', sent_at: new Date().toISOString() })
    .eq('company_id', company.id)
    .eq('status', 'pending')

  if (error) throw new Error('Could not mark notifications read: ' + error.message)

  revalidatePath('/dashboard')
}
