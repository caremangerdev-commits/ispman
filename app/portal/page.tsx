import { notFound } from 'next/navigation'

import { AccountView } from '@/components/portal/AccountView'
import type { PortalBrand } from '@/components/portal/Brand'
import { LoginForm } from '@/components/portal/LoginForm'
import { footerLine, PortalShell } from '@/components/portal/PortalShell'
import { getBillSettings } from '@/lib/data/bill-settings'
import { getCustomerPayments } from '@/lib/data/customers'
import { activeIncidentForCustomer } from '@/lib/data/incidents'
import { getEnabledGateway } from '@/lib/data/payment-gateways'
import { firstNameOf, getPortalAccount, type PortalCompany } from '@/lib/data/portal'
import { getPortalBrand } from '@/lib/portal/brand'
import { getPortalCompany } from '@/lib/portal/context'
import { getPortalSession } from '@/lib/portal/session'
import { getSchemaCapabilities } from '@/lib/schema'

/** Reads cookies and the subdomain header, so it is always per-request. */
export const dynamic = 'force-dynamic'

export default async function PortalHome(props: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const company = await getPortalCompany()
  if (!company) notFound()

  const [brand, session] = await Promise.all([
    getPortalBrand(company.id, company.name),
    getPortalSession(company.id),
  ])
  if (!session) return <SignIn brand={brand} company={company} />

  const account = await getPortalAccount(company.id, session.customerId)
  // The session points at an account that is no longer here. Don't clear the
  // cookie in a render (only actions may); just fall back to the sign-in.
  if (!account) return <SignIn brand={brand} company={company} />

  const [payments, gateway, incident, caps, bill, sp] = await Promise.all([
    getCustomerPayments(company.id, session.customerId),
    getEnabledGateway(company.id),
    activeIncidentForCustomer(company.id, account.accessPoint),
    getSchemaCapabilities(),
    getBillSettings(company.id),
    props.searchParams,
  ])
  const error = typeof sp.e === 'string' ? sp.e : null

  return (
    <PortalShell
      brand={brand}
      signedIn
      firstName={firstNameOf(account.name)}
      width="wide"
      footer={footerLine(company.name, company.phone)}
    >
      <AccountView
        company={company.name}
        account={account}
        payments={payments}
        canPay={gateway !== null}
        incident={incident}
        supportAvailable={caps.portalTier2}
        symbol={bill.currencySymbol}
        paymentNote={bill.paymentNote ?? account.paymentNote}
        bankDetails={bill.bankDetails}
        error={error}
      />
    </PortalShell>
  )
}

function SignIn({ brand, company }: { brand: PortalBrand; company: PortalCompany }) {
  return (
    <PortalShell brand={brand} footer={footerLine(company.name, company.phone)}>
      <LoginForm companyName={company.name} />
    </PortalShell>
  )
}
