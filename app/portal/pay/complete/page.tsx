import { notFound } from 'next/navigation'

import { AutoRefresh } from '@/components/portal/AutoRefresh'
import { BrandRule, primaryButtonClass, PortalWordmark } from '@/components/portal/Brand'
import { getGatewayPaymentStatus } from '@/lib/data/payment-gateways'
import { getPortalAccount } from '@/lib/data/portal'
import { formatCurrency } from '@/lib/format'
import { getPortalBrand } from '@/lib/portal/brand'
import { getPortalCompany } from '@/lib/portal/context'
import { getPortalSession } from '@/lib/portal/session'

/**
 * Where Fygaro's Return URL brings a customer back to after paying.
 *
 * Fygaro redirects here on a SUCCESSFUL payment, appending `reference` (its
 * payment id) and `customReference` (the companyId:customerId we signed into
 * the checkout). That redirect almost always arrives BEFORE the server-to-server
 * webhook has finished recording the payment — so a not-yet-recorded payment is
 * shown as "confirming", never as failed. The page re-checks until the webhook
 * lands, then shows the up-to-date account.
 *
 * Arriving with no `reference` means the customer came back WITHOUT completing
 * the payment (closed Fygaro, or cancelled) — shown as "not completed", with a
 * way back to try again.
 *
 * The Return URL to paste into the Fygaro button is shown on the Online Payments
 * settings page. It is the same button for the account and reconnection flows,
 * so this one page serves both.
 */
export const dynamic = 'force-dynamic'

const PROVIDER = 'fygaro'
/** Re-checks (~4s apart) before we stop auto-refreshing and ask them to wait. */
const MAX_TRIES = 5

const str = (v: string | string[] | undefined) => (typeof v === 'string' ? v : '')

/** "companyId:customerId" as signed into the checkout, or null. */
function parseRef(raw: string): { companyId: number; customerId: number } | null {
  const m = /^(\d+):(\d+)$/.exec(raw.trim())
  return m ? { companyId: Number(m[1]), customerId: Number(m[2]) } : null
}

export default async function PayCompletePage(props: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const company = await getPortalCompany()
  if (!company) notFound()

  const [brand, sp] = await Promise.all([getPortalBrand(company.id, company.name), props.searchParams])
  const reference = str(sp.reference).trim()
  // Fygaro's docs spell it camelCase on the return URL; accept snake_case too.
  const customRef = (str(sp.customReference) || str(sp.custom_reference)).trim()
  const tries = Math.max(0, Math.floor(Number(str(sp.t)) || 0))

  const header = (
    <header className="flex flex-col gap-3">
      <PortalWordmark brand={brand} />
      <BrandRule brand={brand} />
    </header>
  )

  // No reference → they came back without paying (cancelled or closed Fygaro).
  if (!reference) {
    return (
      <div className="flex flex-col gap-5">
        {header}
        <section className="rounded-2xl border border-neutral-200 p-6 text-center">
          <p className="text-xl font-semibold">Payment not completed</p>
          <p className="mt-2 text-sm text-neutral-600">
            It looks like you came back before the payment went through. Nothing has been charged.
          </p>
        </section>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- '/' is rewritten to /portal by proxy.ts */}
        <a
          href="/"
          className={primaryButtonClass + ' text-center'}
          style={{ backgroundColor: brand.palette.accent, color: brand.palette.onAccent }}
        >
          Back to my account
        </a>
      </div>
    )
  }

  const session = await getPortalSession(company.id)
  const parsed = parseRef(customRef)
  // Personalise ONLY for the signed-in owner of this payment — the URL params
  // are not proof of identity, the session cookie is.
  const mine =
    Boolean(session) && Boolean(parsed) &&
    parsed!.companyId === company.id && parsed!.customerId === session!.customerId

  const status = await getGatewayPaymentStatus(company.id, PROVIDER, reference)
  const settled = status === 'recorded'
  const account = settled && mine && session ? await getPortalAccount(company.id, session.customerId) : null

  // --- Confirmed: the webhook has recorded it. -----------------------------
  if (settled) {
    const owes = account ? account.balance > 0.005 : false
    const days = account?.daysUntilExpiry ?? null
    return (
      <div className="flex flex-col gap-5">
        {header}
        <section
          className="rounded-2xl p-6 text-center"
          style={{ backgroundColor: brand.palette.accent, color: brand.palette.onAccent }}
        >
          <p className="text-2xl font-bold">Payment received</p>
          <p className="mt-1 text-sm opacity-90">Thank you — your payment is confirmed.</p>
        </section>

        {account ? (
          <section className="rounded-2xl border border-neutral-200 p-5 text-center">
            {days !== null && days >= 0 ? (
              <>
                <p className="text-sm text-neutral-500">Your service is active</p>
                <p className="mt-1 text-lg font-semibold">
                  {days === 0 ? 'through today' : days + (days === 1 ? ' more day' : ' more days')}
                </p>
              </>
            ) : null}
            <p className="mt-2 text-sm text-neutral-600">
              {owes ? 'Balance: ' + formatCurrency(account.balance) : "You're all paid up."}
            </p>
          </section>
        ) : (
          <section className="rounded-2xl border border-neutral-200 p-5 text-center">
            <p className="text-sm text-neutral-600">
              Your service is being brought back online — this can take a moment.
            </p>
          </section>
        )}

        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- '/' is rewritten to /portal by proxy.ts */}
        <a
          href="/"
          className={primaryButtonClass + ' text-center'}
          style={{ backgroundColor: brand.palette.accent, color: brand.palette.onAccent }}
        >
          Back to my account
        </a>
      </div>
    )
  }

  // --- Not yet recorded: the webhook is still in flight (or needs staff). ---
  // Fygaro only redirects here on success, so the money HAS gone through; we are
  // only waiting to reconcile it. Never call this a failure.
  const keepTrying = status !== 'failed' && tries < MAX_TRIES
  const refreshTo =
    '/pay/complete?reference=' + encodeURIComponent(reference) +
    '&customReference=' + encodeURIComponent(customRef) +
    '&t=' + (tries + 1)

  return (
    <div className="flex flex-col gap-5">
      {header}
      <section className="rounded-2xl border border-neutral-200 bg-neutral-50 p-6 text-center">
        <p className="text-2xl font-bold">Payment received</p>
        {keepTrying ? (
          <>
            <p className="mt-2 text-sm text-neutral-600">
              We’re confirming it with your account now. This usually takes a few seconds…
            </p>
            <p className="mt-3 text-xs text-neutral-400">This page updates on its own.</p>
            <AutoRefresh to={refreshTo} seconds={4} />
          </>
        ) : (
          <p className="mt-2 text-sm text-neutral-600">
            Your payment went through and is safe. It’s taking a little longer than usual to show on
            your account. Check back shortly — if it hasn’t updated, contact {company.name}.
          </p>
        )}
      </section>

      {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- '/' is rewritten to /portal by proxy.ts */}
      <a
        href="/"
        className="rounded-xl border border-neutral-300 px-4 py-4 text-center text-lg font-medium active:bg-neutral-50"
      >
        Back to my account
      </a>
    </div>
  )
}
