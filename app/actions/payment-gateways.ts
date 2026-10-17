'use server'

import { revalidatePath } from 'next/cache'

import { logEvent } from '@/lib/audit'
import { getGatewaySettings, saveGatewayCredentials } from '@/lib/data/payment-gateways'
import { can } from '@/lib/permissions'
import { getSchemaCapabilities } from '@/lib/schema'
import { getSession } from '@/lib/session'

/**
 * Saving a company's online-payment gateway credentials.
 *
 * One provider for now — Fygaro — so the action names it rather than taking it
 * from the form. Same gate as the rest of settings (company_admin). The company
 * id is the session's, never the form's.
 *
 * THE SECRET IS WRITE-ONLY. The page never renders it; a blank secret field
 * means "leave it as it is" (see lib/data/payment-gateways.ts#saveGatewayCredentials),
 * so a save that only toggles the switch keeps the stored secret.
 */

const PROVIDER = 'fygaro'

export type GatewayFormResult = { ok: true; message: string } | { ok: false; error: string }

const NOT_APPLIED =
  'Online payments are not set up on this system yet. Ask your administrator to apply migration 0034.'

async function guard() {
  const session = await getSession()
  if (!can(session.profile.role, 'manage_company_settings')) {
    throw new Error('Forbidden: role "' + session.profile.role + '" cannot edit company settings.')
  }
  return session
}

/** A trimmed string field, or null when empty. */
function field(formData: FormData, key: string): string | null {
  const raw = formData.get(key)
  const v = typeof raw === 'string' ? raw.trim() : ''
  return v ? v : null
}

export async function saveFygaroGateway(
  _prev: GatewayFormResult | null,
  formData: FormData
): Promise<GatewayFormResult> {
  const { company } = await guard()
  if (!(await getSchemaCapabilities()).paymentGateways) return { ok: false, error: NOT_APPLIED }

  const publicKey = field(formData, 'public_key')
  const checkoutUrl = field(formData, 'checkout_url')
  // Blank means "keep the stored secret"; a value replaces it.
  const typedSecret = field(formData, 'secret_key')
  const enabled = formData.get('enabled') === 'on'

  if (checkoutUrl && !/^https?:\/\//i.test(checkoutUrl)) {
    return { ok: false, error: 'The checkout URL should start with https://' }
  }

  const before = await getGatewaySettings(company.id, PROVIDER)

  const saved = await saveGatewayCredentials({
    companyId: company.id,
    provider: PROVIDER,
    publicKey,
    checkoutUrl,
    secretKey: typedSecret ?? undefined,
    enabled,
  })
  if (!saved.ok) return { ok: false, error: saved.error }

  // What changed, without ever naming the secret's value — only that it moved.
  const changes: string[] = []
  if ((before?.enabled ?? false) !== enabled) changes.push(enabled ? 'enabled' : 'disabled')
  if ((before?.publicKey ?? null) !== publicKey) changes.push('public key changed')
  if ((before?.checkoutUrl ?? null) !== checkoutUrl) changes.push('checkout URL changed')
  if (typedSecret) changes.push('secret replaced')

  await logEvent({
    type: 'payment_gateway_updated',
    details:
      'Fygaro gateway ' + (changes.length ? changes.join(', ') : 'saved (no change)') + '.',
    tag: '[payments]',
  })

  revalidatePath('/dashboard/settings/payments')
  return {
    ok: true,
    message: enabled
      ? 'Saved. Online payments are on — customers can pay from the portal.'
      : 'Saved. Online payments are off.',
  }
}
