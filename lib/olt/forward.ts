import 'server-only'

import type { PollTarget } from '@/lib/data/router-logins'
import { withRouter, type RouterOsSession } from '@/lib/routeros/api'
import { ROUTER_INTERFACE_NAME } from '@/lib/tunnels/wireguard'

/**
 * The rules on a company's router that let ISPMan reach an OLT behind it.
 *
 * THREE RULES, ALL CARRYING ONE COMMENT, "ISPMan OLT #<id>":
 *
 *   dst-nat     a port on the router's tunnel address leads to the OLT
 *   masquerade  the OLT sees the connection as coming from the router, so its
 *               reply comes back the same way whatever its own gateway is
 *   forward     the router's firewall lets that one connection through
 *
 * Each is limited to the tunnel interface, the OLT's address and the one
 * port. Nothing else on the company's network becomes reachable.
 *
 * SAFE TO RUN TWICE. Anything already carrying the comment is removed first,
 * so changing an OLT's address replaces its rules rather than adding more.
 */

export function oltRuleComment(oltId: number): string {
  return 'ISPMan OLT #' + oltId
}

/** The port on the router's tunnel address set aside for an OLT. */
export function oltForwardPort(oltId: number): number {
  return 23000 + (oltId % 20000)
}

async function removeRules(session: RouterOsSession, comment: string): Promise<void> {
  for (const menu of ['/ip/firewall/nat', '/ip/firewall/filter']) {
    const rows = await session.command(menu + '/print', '?comment=' + comment, '=.proplist=.id')
    for (const row of rows) {
      if (row['.id']) await session.command(menu + '/remove', '=.id=' + row['.id'])
    }
  }
}

function target(router: PollTarget) {
  return {
    host: router.tunnelIp,
    port: router.login.port,
    user: router.login.user,
    password: router.login.password,
  }
}

export async function addOltForward(
  router: PollTarget,
  olt: { id: number; mgmtIp: string; cliPort: number }
): Promise<void> {
  const comment = oltRuleComment(olt.id)
  const port = String(oltForwardPort(olt.id))
  await withRouter(target(router), async (session) => {
    // THE ROUTER'S OWN ADDRESS IS NOT AN OLT. Typed by mistake — the gateway
    // of the OLT's network is the address people know — it sends every login
    // to the router itself, which answers nothing and leaves only "did not
    // respond". Said plainly instead, before any rule is written.
    const own = await session.command('/ip/address/print', '=.proplist=address,interface')
    const mine = own.find((a) => (a.address ?? '').split('/')[0] === olt.mgmtIp)
    if (mine) {
      throw new Error(
        olt.mgmtIp + ' is ' + router.name + "'s own address (on " + (mine.interface ?? 'one of its ports') +
          "), not the OLT's. Enter the OLT's own management address: on a ZTE, show ip interface brief on " +
          'its console lists it.'
      )
    }

    // ALREADY IN PLACE AND STILL RIGHT: leave them alone. Removing and
    // re-adding the rules on every check opens a moment in which the port
    // leads nowhere, and the login that follows straight away is refused.
    const nat = await session.command(
      '/ip/firewall/nat/print',
      '?comment=' + comment,
      '=.proplist=chain,dst-port,to-addresses,to-ports,dst-address'
    )
    const filter = await session.command(
      '/ip/firewall/filter/print',
      '?comment=' + comment,
      '=.proplist=dst-address,dst-port'
    )
    const dst = nat.find((r) => r.chain === 'dstnat')
    const src = nat.find((r) => r.chain === 'srcnat')
    const current =
      nat.length === 2 &&
      filter.length === 1 &&
      dst?.['dst-port'] === port &&
      dst?.['to-addresses'] === olt.mgmtIp &&
      dst?.['to-ports'] === String(olt.cliPort) &&
      src?.['dst-address'] === olt.mgmtIp &&
      filter[0]['dst-address'] === olt.mgmtIp &&
      filter[0]['dst-port'] === String(olt.cliPort)
    if (current) return

    await removeRules(session, comment)

    await session.command(
      '/ip/firewall/nat/add',
      '=chain=dstnat',
      '=in-interface=' + ROUTER_INTERFACE_NAME,
      '=protocol=tcp',
      '=dst-port=' + port,
      '=action=dst-nat',
      '=to-addresses=' + olt.mgmtIp,
      '=to-ports=' + olt.cliPort,
      '=comment=' + comment
    )
    await session.command(
      '/ip/firewall/nat/add',
      '=chain=srcnat',
      '=protocol=tcp',
      '=dst-address=' + olt.mgmtIp,
      '=dst-port=' + olt.cliPort,
      '=src-address=10.250.0.1',
      '=action=masquerade',
      '=comment=' + comment
    )

    // Above every other forward rule, or a router that drops forwarded traffic
    // by default would drop this too. With no rules at all there is nothing to
    // go above, and "place-before" would fail.
    const existing = await session.command('/ip/firewall/filter/print', '=.proplist=.id')
    const words = [
      '/ip/firewall/filter/add',
      '=chain=forward',
      '=in-interface=' + ROUTER_INTERFACE_NAME,
      '=protocol=tcp',
      '=dst-address=' + olt.mgmtIp,
      '=dst-port=' + olt.cliPort,
      '=action=accept',
      '=comment=' + comment,
    ]
    if (existing.length && existing[0]['.id']) words.push('=place-before=' + existing[0]['.id'])
    await session.command(...words)
  })
}

export async function removeOltForward(router: PollTarget, oltId: number): Promise<void> {
  await withRouter(target(router), (session) => removeRules(session, oltRuleComment(oltId)))
}
