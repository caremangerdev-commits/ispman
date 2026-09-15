/**
 * Channels and routes — the vocabulary the whole messaging module shares.
 *
 * CLIENT-SAFE ON PURPOSE. The settings form, the composer and the batch page
 * all need these names and labels, so this file imports nothing from the
 * server side. The adapter interface, which does, lives in ./adapter.ts.
 */

export type Channel = 'sms' | 'email'

/** In the order the UI lists them and the dispatcher drains them. */
export const CHANNELS: Channel[] = ['sms', 'email']

export const CHANNEL_LABELS: Record<Channel, string> = {
  sms: 'SMS',
  email: 'Email',
}

/**
 * Which channel a message kind goes by, and what to do when a customer could
 * be reached both ways. THE COMPANY'S DECISION, stored per kind in settings
 * (migration 0022) and resolved in one place, lib/messaging/route.ts.
 */
export type Route = 'sms' | 'email' | 'email_then_sms' | 'sms_then_email' | 'both'

export const ROUTES: Route[] = ['sms', 'email', 'email_then_sms', 'sms_then_email', 'both']

export const ROUTE_LABELS: Record<Route, string> = {
  sms: 'SMS only',
  email: 'Email only',
  email_then_sms: 'Email, or SMS if they have no email',
  sms_then_email: 'SMS, or email if they have no number',
  both: 'Both, whichever they have',
}

const VALID_ROUTES = new Set<string>(ROUTES)

/** Coerces a stored value to a Route. Anything unrecognised reads as SMS, the pre-0022 behaviour. */
export function toRoute(value: string | null | undefined): Route {
  return VALID_ROUTES.has(value ?? '') ? (value as Route) : 'sms'
}

/** The channels a route can use, in the order it prefers them. */
export function channelsOf(route: Route): Channel[] {
  switch (route) {
    case 'sms': return ['sms']
    case 'email': return ['email']
    case 'email_then_sms': return ['email', 'sms']
    case 'sms_then_email': return ['sms', 'email']
    case 'both': return ['email', 'sms']
  }
}

/** True for the routes that stop at the first channel that works. */
export function isFallbackRoute(route: Route): boolean {
  return route === 'email_then_sms' || route === 'sms_then_email'
}

/** Whether a route can reach a given channel at all. */
export function routeUses(route: Route, channel: Channel): boolean {
  return channelsOf(route).includes(channel)
}
