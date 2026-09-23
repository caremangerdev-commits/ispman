import { redirect } from 'next/navigation'

import { landingPathFor, safeReturnPath } from '@/lib/home'
import { getSession } from '@/lib/session'

// The root path has no content of its own; it exists to route each role to its
// own home. Unauthenticated visitors are bounced to /login by proxy.ts before
// they ever reach this, and getSession() redirects there too as a backstop.
//
// ?redirectTo= is the page a lapsed session was on, carried here by the login
// form. Whether it is honoured depends on the role — see lib/home.ts
// #landingPathFor — which is why the form does not follow it itself.
export default async function Home({ searchParams }: PageProps<'/'>) {
  const [{ profile, actingAs }, sp] = await Promise.all([getSession(), searchParams])
  redirect(landingPathFor(profile, actingAs !== null, safeReturnPath(sp.redirectTo)))
}
