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
    // The customer's thread: internal notes are not in it.
    messages: await listTicketMessages(companyId, id, 'customer'),
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

/** What a photo of any other image type is saved as. */
const FALLBACK_EXT = 'bin'

/** Largest photo either side accepts. */
const MAX_PHOTO_BYTES = 4_000_000

/**
 * The optional `photo` field of a ticket form: none, one acceptable photo, or
 * why not. The one check for both sides of a ticket — the portal's customer
 * and staff on the ticket page — so they accept the same files.
 */
export function readTicketPhoto(formData: FormData): { file: File | null; error?: string } {
  const photo = formData.get('photo')
  if (!(photo instanceof File) || photo.size === 0) return { file: null }
  if (!photo.type.startsWith('image/')) return { file: null, error: 'The attachment must be a photo.' }
  if (photo.size > MAX_PHOTO_BYTES) return { file: null, error: 'That photo is too large — try one under 4 MB.' }
  return { file: photo }
}

/** Uploads one photo for a ticket, returns its storage path. Throws on failure. */
export async function uploadTicketPhoto(
  companyId: number,
  ticketId: number,
  file: File
): Promise<string> {
  const ext = EXT[file.type] ?? FALLBACK_EXT
  const path = 'tickets/' + companyId + '/' + ticketId + '/' + randomUUID() + '.' + ext
  const bytes = new Uint8Array(await file.arrayBuffer())
  const { error } = await tenantClient()
    .storage.from(BUCKET)
    .upload(path, bytes, { contentType: file.type || 'application/octet-stream', upsert: false })
  if (error) throw new Error('Photo upload failed: ' + error.message)
  return path
}

/**
 * The one reader of a ticket photo path: exactly what uploadTicketPhoto writes,
 * tickets/<companyId>/<ticketId>/<uuid>.<ext>, and nothing else. Null for
 * anything that is not that shape.
 *
 * WHY IT IS STRICT. Both serving routes used to check only that the path
 * STARTED with tickets/<their company>/ and then handed the rest to storage
 * with the service role. A path is joined into the storage URL, and URL
 * parsing resolves "..", so tickets/5/12/../../../7/logo.png passed the prefix
 * check and fetched another company's file — or, with more "..", an object in
 * any bucket. Parsing the whole path means the prefix the routes check is the
 * prefix that is read.
 */
export function parseTicketPhotoPath(path: string): { companyId: number; ticketId: number } | null {
  const parts = path.split('/')
  if (parts.length !== 4 || parts[0] !== 'tickets') return null
  const [, company, ticket, file] = parts
  if (!/^[0-9]{1,15}$/.test(company) || !/^[0-9]{1,15}$/.test(ticket)) return null

  const dot = file.lastIndexOf('.')
  if (dot < 0) return null
  const name = file.slice(0, dot)
  const ext = file.slice(dot + 1)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name)) return null
  if (ext !== FALLBACK_EXT && !Object.values(EXT).includes(ext)) return null

  return { companyId: Number(company), ticketId: Number(ticket) }
}

/**
 * Downloads a ticket photo (service role), for a scoped serving route. Refuses
 * any path parseTicketPhotoPath does not accept, so a route that forgets to
 * parse still cannot be walked out of the ticket folder.
 */
export async function downloadTicketPhoto(
  path: string
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  if (!parseTicketPhotoPath(path)) return null
  const { data, error } = await tenantClient().storage.from(BUCKET).download(path)
  if (error || !data) return null
  const type = Object.entries(EXT).find(([, e]) => path.endsWith('.' + e))?.[0] ?? 'application/octet-stream'
  return { bytes: new Uint8Array(await data.arrayBuffer()), contentType: type }
}
