import 'server-only'

import { externalHost } from '@/lib/portal/config'

/**
 * The address a gateway sends word of a payment to, for one company.
 *
 * THE ONE DEFINITION. The settings page shows this address and the save action
 * registers it with Dime; if those two ever disagreed, the operator would be
 * looking at one URL while payments were being delivered to another, and the
 * only symptom would be payments that never arrive. Both call this.
 *
 * HTTPS UNLESS WE ARE PLAINLY IN DEV. X-Forwarded-Proto arrives as "http" from
 * this Apache even on the TLS vhost, so trusting it printed an http:// address
 * for an operator to paste into their gateway. Dime refuses a non-HTTPS
 * endpoint outright and Fygaro would be posting payment notices in clear. The
 * scheme a gateway must call us on is a property of the deployment, not of
 * whatever header survived the proxy, so only a local host gets http.
 */
export function webhookUrlFor(
  headerList: Headers,
  provider: string,
  companyId: number
): string {
  const host = externalHost(headerList) ?? 'your-domain'
  const local = /^(localhost|127\.0\.0\.1)(:|$)/.test(host)
  const proto = local ? (headerList.get('x-forwarded-proto') ?? 'http') : 'https'
  return proto + '://' + host + '/api/payments/' + provider + '/' + companyId + '/webhook'
}
