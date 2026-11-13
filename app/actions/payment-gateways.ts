'use server'

import { revalidatePath } from 'next/cache'

import { logEvent } from '@/lib/audit'
import { getGatewaySettings, saveGatewayCredentials } from '@/lib/data/payment-gateways'
import { gatewayFor } from '@/lib/payments/gateways'
import { can } from '@/lib/permissions'
import { getSchemaCapabilities } from '@/lib/schema'
import { getSession } from '@/lib/session'

/**
 * Saving a company's online-payment gateway credentials.
 *
 * ONE ACTION, ANY PROVIDER. The provider arrives in the form and is checked
 * against the registry (lib/payments/gateways) — an unknown one is refused, so
 * the form cannot invent a provider row. The company id is always the
 * session's, never the form's. Same gate as the rest of settings
 * (company_admin).
 *
 * BOTH SECRETS ARE WRITE-ONLY. The page never renders either; a blank field
 * means "leave it as it is" (lib/data/payment-gateways.ts#saveGatewayCredentials),
 * so a save that only toggles the switch keeps what is stored.
 *
 * TURNING ONE ON TURNS THE OTHER OFF. A company pays through one gateway at a
 * time; the exclusivity is enforced in saveGatewayCredentials, not here, so it
 * holds for every caller.
 */

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

export async function saveGateway(
  _prev: GatewayFormResult | null,
  formData: FormData
): Promise<GatewayFormResult> {
  const { company } = await guard()
  if (!(await getSchemaCapabilities()).paymentGateways) return { ok: false, error: NOT_APPLIED }

  const provider = field(formData, 'provider') ?? ''
  const gateway = gatewayFor(provider)
  if (!gateway) return { ok: false, error: 'Unknown payment gateway.' }

  const publicKey = field(formData, 'public_key')
  const checkoutUrl = field(formData, 'checkout_url')
  // Blank means "keep the stored secret"; a value replaces it.
  const typedSecret = field(formData, 'secret_key')
  const typedWebhookSecret = field(formData, 'webhook_secret')
  const enabled = formData.get('enabled') === 'on'

  if (checkoutUrl && !/^https?:\/\//i.test(checkoutUrl)) {
    return { ok: false, error: 'The URL should start with https://' }
  }

  const before = await getGatewaySettings(company.id, provider)

  const saved = await saveGatewayCredentials({
    companyId: company.id,
    provider,
    publicKey,
    checkoutUrl,
    secretKey: typedSecret ?? undefined,
    webhookSecret: typedWebhookSecret ?? undefined,
    enabled,
  })
  if (!saved.ok) return { ok: false, error: saved.error }

  // What changed, without ever naming a secret's value — only that it moved.
  const changes: string[] = []
  if ((before?.enabled ?? false) !== enabled) changes.push(enabled ? 'enabled' : 'disabled')
  if ((before?.publicKey ?? null) !== publicKey) changes.push('public key changed')
  if ((before?.checkoutUrl ?? null) !== checkoutUrl) changes.push('URL changed')
  if (typedSecret) changes.push('secret replaced')
  if (typedWebhookSecret) changes.push('webhook secret replaced')

  await logEvent({
    type: 'payment_gateway_updated',
    details:
      gateway.label + ' gateway ' + (changes.length ? changes.join(', ') : 'saved (no change)') + '.',
    tag: '[payments]',
  })

  revalidatePath('/dashboard/settings/payments')
  return {
    ok: true,
    message: enabled
      ? 'Saved. ' + gateway.label + ' is on — customers can pay from the portal.'
      : 'Saved. ' + gateway.label + ' is off.',
  }
}
