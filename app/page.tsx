import { redirect } from 'next/navigation'

import { homePathFor } from '@/lib/home'
import { getSession } from '@/lib/session'

// The root path has no content of its own; it exists to route each role to its
// own home. Unauthenticated visitors are bounced to /login by proxy.ts before
// they ever reach this, and getSession() redirects there too as a backstop.
export default async function Home() {
  const { profile } = await getSession()
  redirect(homePathFor(profile))
}
