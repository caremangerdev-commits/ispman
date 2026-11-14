'use server'

import { revalidatePath } from 'next/cache'

import { logEvent } from '@/lib/audit'
import {
  cardFeeShare, getEnabledGateway, getGatewaySettings, saveGatewayCredentials, setCardFeeShare,
} from '@/lib/data/payment-gateways'
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

/**
 * A number field: null when blank (the operator does not know this), undefined
 * never — a cleared box must actually clear the stored value, unlike the
 * write-only secrets. NaN is reported rather than silently stored as null.
 */
function numberField(
  formData: FormData,
  key: string,
  min: number,
  max: number
): number | null | 'bad' {
  const raw = field(formData, key)
  if (raw === null) return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n < min || n > max) return 'bad'
  return n
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

  const feeRate = numberField(formData, 'fee_rate', 0, 20)
  if (feeRate === 'bad') {
    return { ok: false, error: 'The percentage fee should be a number between 0 and 20.' }
  }
  const feeFixed = numberField(formData, 'fee_fixed', 0, 10_000)
  if (feeFixed === 'bad') {
    return { ok: false, error: 'The fixed fee should be a number, and not a negative one.' }
  }

  const before = await getGatewaySettings(company.id, provider)

  const saved = await saveGatewayCredentials({
    companyId: company.id,
    provider,
    publicKey,
    checkoutUrl,
    secretKey: typedSecret ?? undefined,
    webhookSecret: typedWebhookSecret ?? undefined,
    feeRate,
    feeFixed,
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
  if ((before?.feeRate ?? null) !== feeRate) changes.push('fee rate ' + (feeRate ?? 'cleared'))
  if ((before?.feeFixed ?? null) !== feeFixed) changes.push('fixed fee ' + (feeFixed ?? 'cleared'))

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

/**
 * How much of the card fee this company's customers carry.
 *
 * SEPARATE FROM THE GATEWAY SAVE because it is a different kind of decision:
 * the rate is a fact about an agreement, this is a policy about customers, and
 * it survives switching provider.
 *
 * REFUSED ABOVE ZERO WITHOUT A RATE ON RECORD. Otherwise an operator sets 50%,
 * sees a cheerful "Saved", and charges nobody anything — the worst outcome,
 * because they would believe it was working.
 */
export async function saveCardFeeShare(
  _prev: GatewayFormResult | null,
  formData: FormData
): Promise<GatewayFormResult> {
  const { company } = await guard()
  if (!(await getSchemaCapabilities()).paymentGateways) return { ok: false, error: NOT_APPLIED }

  const share = numberField(formData, 'card_fee_customer_share', 0, 100)
  if (share === 'bad') {
    return { ok: false, error: 'The share should be a whole number between 0 and 100.' }
  }
  const next = Math.round(share ?? 0)

  if (next > 0) {
    const live = await getEnabledGateway(company.id).catch(() => null)
    if (!live) {
      return {
        ok: false,
        error: 'Turn on a payment gateway before asking customers to carry part of its fee.',
      }
    }
    if (live.feeRate === null) {
      const label = gatewayFor(live.provider)?.label ?? live.provider
      return {
        ok: false,
        error:
          'Enter ' + label + "'s percentage fee above first. Without it there is nothing to " +
          'work a share out from, and customers would be charged nothing extra.',
      }
    }
  }

  const before = await cardFeeShare(company.id)
  const saved = await setCardFeeShare(company.id, next)
  if (!saved.ok) return { ok: false, error: saved.error }

  // Logged like the connection month and the engine mode: it changes what
  // every customer of this company is asked to pay.
  if (before !== next) {
    await logEvent({
      type: 'card_fee_share_changed',
      details:
        'Customers now carry ' + next + '% of the card fee (was ' + before + '%).',
      tag: '[payments]',
    })
  }

  revalidatePath('/dashboard/settings/payments')
  return {
    ok: true,
    message:
      next === 0
        ? 'Saved. You absorb the card fee — customers pay only their bill.'
        : 'Saved. Customers are asked to carry ' + next + '% of the card fee, and must agree before paying.',
  }
}
