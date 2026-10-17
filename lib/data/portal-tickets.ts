import 'server-only'

import { randomUUID } from 'node:crypto'

import { listTicketMessages, type TicketMessage } from '@/lib/data/tickets'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * The customer side of support tickets. Everything is scoped to the signed-in
 * customer: they see and reply to only their own tickets. Photos go in the
 * existing private company-assets bucket under tickets/<company>/<ticket>/.
 */

const BUCKET = 'company-assets'
const MISSING = new Set(['PGRST205', '42P01'])

export type PortalTicketRow = { id: number; title: string; status: string; createdAt: string }
export type PortalTicketDetail = {
  id: number
  title: string
  status: string
  description: string | null
  createdAt: string
  messages: TicketMessage[]
}

export async function listPortalTickets(companyId: number, customerId: number): Promise<PortalTicketRow[]> {
  const { data, error } = await tenantClient()
    .from('support_tickets')
    .select('id, title, status, created_at')
    .eq('company_id', companyId)
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) {
    if (MISSING.has(error.code ?? '')) return []
    throw new Error('Failed to load tickets: ' + error.message)
  }
  return ((data ?? []) as { id: number; title: string; status: string | null; created_at: string }[]).map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status ?? 'open',
    createdAt: t.created_at,
  }))
}

export async function getPortalTicket(
  companyId: number,
  customerId: number,
  id: number
): Promise<PortalTicketDetail | null> {
  const { data, error } = await tenantClient()
    .from('support_tickets')
    .select('id, title, status, description, created_at')
    .eq('company_id', companyId)
    .eq('customer_id', customerId)
    .eq('id', id)
    .maybeSingle()
  if (error) {
    if (MISSING.has(error.code ?? '')) return null
    throw new Error('Failed to load ticket: ' + error.message)
  }
  if (!data) return null
  const row = data as { id: number; title: string; status: string | null; description: string | null; created_at: string }
  return {
    id: row.id,
    title: row.title,
    status: row.status ?? 'open',
    description: row.description,
    createdAt: row.created_at,
    messages: await listTicketMessages(companyId, id),
  }
}

/**
 * Opens a ticket from the portal, returning its id. The caller adds the first
 * message (with any photo) once it has the id — the photo path needs it.
 */
export async function createPortalTicket(input: {
  companyId: number
  customerId: number
  subject: string
  description: string
}): Promise<number> {
  const { data, error } = await tenantClient()
    .from('support_tickets')
    .insert({
      company_id: input.companyId,
      customer_id: input.customerId,
      title: input.subject,
      description: input.description,
      status: 'open',
      priority: 'medium',
      source: 'portal',
    })
    .select('id')
    .single()
  if (error) throw new Error('Could not open ticket: ' + error.message)
  return (data as { id: number }).id
}

/** True when the ticket is this customer's — the guard for serving its photo. */
export async function ticketBelongsToCustomer(
  companyId: number,
  customerId: number,
  ticketId: number
): Promise<boolean> {
  const { data } = await tenantClient()
    .from('support_tickets')
    .select('id')
    .eq('company_id', companyId)
    .eq('customer_id', customerId)
    .eq('id', ticketId)
    .maybeSingle()
  return Boolean(data)
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
}

/** Uploads one photo for a ticket, returns its storage path. Throws on failure. */
export async function uploadTicketPhoto(
  companyId: number,
  ticketId: number,
  file: File
): Promise<string> {
  const ext = EXT[file.type] ?? 'bin'
  const path = 'tickets/' + companyId + '/' + ticketId + '/' + randomUUID() + '.' + ext
  const bytes = new Uint8Array(await file.arrayBuffer())
  const { error } = await tenantClient()
    .storage.from(BUCKET)
    .upload(path, bytes, { contentType: file.type || 'application/octet-stream', upsert: false })
  if (error) throw new Error('Photo upload failed: ' + error.message)
  return path
}

/** Downloads a ticket photo (service role), for a scoped serving route. */
export async function downloadTicketPhoto(
  path: string
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const { data, error } = await tenantClient().storage.from(BUCKET).download(path)
  if (error || !data) return null
  const type = Object.entries(EXT).find(([, e]) => path.endsWith('.' + e))?.[0] ?? 'application/octet-stream'
  return { bytes: new Uint8Array(await data.arrayBuffer()), contentType: type }
}
