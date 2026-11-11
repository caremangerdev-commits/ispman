import type { Metadata } from 'next'

/**
 * Where to send somebody who wants to pay, or empty for no button.
 *
 * THIS IS PILOT SCAFFOLDING AND NOT THE ANSWER. The page cannot tell which
 * company the reader belongs to — their traffic is masqueraded out of their
 * router's WAN, so the server sees only the router's public address — and one
 * server serves ten tenants, so a single URL here is right for at most one of
 * them.
 *
 * It exists because the first version pointed at the portal's own apex,
 * `pay.ispman.online`, which turned out to HAVE NO DNS RECORD AT ALL: only the
 * wildcard `*.pay.ispman.online` is published, so `wcnet.pay.ispman.online`
 * resolves and the bare name never has, for anyone. A cut-off customer who
 * tapped the button got "Server Not Found" — a dead link offered to exactly
 * the people least able to work around it.
 *
 * The real fix is one of the two already written down in
 * deploy/freeradius/suspended-router-setup.md: give each company's routers
 * their own redirect target so the page knows whose customer this is, or carry
 * the customer's real address over the tunnel. Until one of those exists, this
 * is set per installation or left unset, and unset means no button rather than
 * a broken one.
 */
const payUrl = (process.env.SUSPENDED_PORTAL_URL ?? '').trim()

export const metadata: Metadata = {
  title: 'Internet service suspended',
  // A redirected customer is not a page anybody should find in a search index.
  robots: { index: false, follow: false },
}

/**
 * What a cut-off customer sees instead of the site they asked for.
 *
 * HOW THEY GET HERE. Their expiry passed, so FreeRADIUS put them in the
 * restricted pool rather than turning them away (deploy/freeradius/
 * ispman-walled-garden), and their router rewrites their web traffic to this
 * server (deploy/freeradius/suspended-router-setup.md). The request still asks
 * for whatever they typed, so proxy.ts sees a host that is not ours and serves
 * this.
 *
 * IT DOES NOT KNOW WHO THEY ARE, AND SAYS NOTHING THAT PRETENDS OTHERWISE.
 * Their traffic is masqueraded out of their router's WAN, so all this server
 * sees is the router's public address — shared by every customer behind it.
 * There is no name, no balance and no company here, and inventing any of them
 * would be worse than leaving them out.
 *
 * That is also what Splynx ships: a static page per block reason, not per
 * customer, with the customer sent to a portal to sign in. Identifying them
 * needs their own address to survive the trip, which means routing this
 * traffic over the WireGuard tunnel instead of out of the WAN — a later
 * decision, and the tunnel is currently closed to everything but RADIUS.
 *
 * NO FRAMEWORK, NO CLIENT JAVASCRIPT, NO FONTS. Everything a browser needs is
 * in this file. A reader of this page has no internet beyond this server, so
 * anything fetched from elsewhere is a spinner that never resolves.
 *
 * PLAIN HTTP ONLY, and nothing here may assume otherwise. The redirect catches
 * port 80; a customer who opened an HTTPS site sees their browser's own error
 * instead of this. That is the known ceiling, and it is why the page has to
 * read sensibly to somebody who reached it by accident.
 */
export default function SuspendedPage() {
  return (
    <main className="card">
      <style>{`
        body {
          margin: 0; min-height: 100vh;
          display: flex; align-items: center; justify-content: center;
          padding: 24px; background: #0b1220; color: #e8edf6;
          font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
                Helvetica, Arial, sans-serif;
        }
        .card {
          width: 100%; max-width: 30rem; box-sizing: border-box;
          background: #141d2e; border: 1px solid #243049;
          border-radius: 14px; padding: 28px 24px;
        }
        .mark {
          width: 42px; height: 42px; border-radius: 11px; background: #f59e0b;
          display: flex; align-items: center; justify-content: center;
          font-size: 24px; font-weight: 700; color: #1a1205; margin-bottom: 18px;
        }
        .card h1 { margin: 0 0 10px; font-size: 1.4rem; line-height: 1.3; }
        .card p { margin: 0 0 14px; color: #b9c4d6; }
        .steps { margin: 0; padding-left: 20px; color: #b9c4d6; }
        .steps li { margin-bottom: 6px; }
        a.cta {
          display: block; margin-top: 20px; padding: 14px 18px;
          border-radius: 11px; background: #2563eb; color: #fff;
          font-weight: 600; text-align: center; text-decoration: none;
        }
        .call {
          margin-top: 20px; padding: 14px 18px; border-radius: 11px;
          background: #1b2740; border: 1px solid #2c3a57;
          text-align: center; font-weight: 600; color: #e8edf6 !important;
        }
        .note {
          margin: 18px 0 0; padding-top: 16px; border-top: 1px solid #243049;
          font-size: 0.8rem; color: #7f8da4;
        }
        @media (min-width: 540px) { .card { padding: 34px 32px; } }
      `}</style>

      <div className="mark" aria-hidden>!</div>

      <h1>Your internet service is suspended</h1>

      <p>
        You are still connected to your provider&rsquo;s network, but your
        account needs to be settled before the internet is switched back on.
      </p>

      <p>This is usually because a payment is outstanding.</p>

      <ol className="steps">
        <li>Pay your outstanding balance.</li>
        <li>
          Your service comes back on its own within a couple of minutes — you do
          not need to restart anything.
        </li>
        <li>If it does not, call your provider.</li>
      </ol>

      {payUrl ? (
        <a className="cta" href={payUrl}>Sign in to pay</a>
      ) : (
        <p className="call">Call your provider to pay and get back online.</p>
      )}

      <p className="note">
        You reached this page because your provider redirected you here. Your
        connection is working — only access to the internet is paused. If you
        have already paid, give it a few minutes and then try again.
      </p>
    </main>
  )
}
