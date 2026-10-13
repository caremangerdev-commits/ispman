/**
 * Router tunnels: the address plan, the names, and the config blocks ISPMan
 * hands out.
 *
 * THE SINGLE DEFINITION. docs/wireguard-tunnels.md quotes these values for the
 * server side; if one changes, both change.
 *
 * Each tenant router builds a WireGuard tunnel to the server and sends RADIUS
 * through it from a fixed inside address. That address gets its own permanent
 * nas row and its own secret, so the router no longer depends on a public IP
 * its ISP changes about daily, nor on the shared 0.0.0.0/0 catch-all it falls
 * onto when its nas row goes stale.
 *
 * THE PRIVATE KEY NEVER COMES THROUGH HERE. The router generates its own key
 * pair (step 1) and the owner pastes back only the public half; nothing in
 * ISPMan ever sees, stores or prints a private key.
 *
 * Pure: no I/O and no Node APIs, so the settings card can import the labels.
 */

/**
 * 10.250.0.0/16. Picked because nothing a tenant uses overlaps it: 90 days of
 * radacct (13 Oct 2026) showed customer pools and NAS addresses in 10.5, 10.9,
 * 10.10, 10.11, 10.30, 10.99, 100.100, 172.16, 172.30, 172.168 and 192.168, and
 * the EC2 default VPC is 172.31. A router whose own LAN overlapped the tunnel
 * could not route to it.
 *
 * WIDENED FROM /24 (owner, 13 Oct 2026), once three addresses had been handed
 * out: addresses are never reused, and company admins now add their own
 * routers. Nothing already issued moves. The server stays 10.250.0.1, and a
 * router's address is a /32 point-to-point link to it, so the prefix length
 * never appears in a router's config — only on the server's interface.
 *
 * The root job on the server keeps its OWN copy of this range
 * (deploy/wireguard/ispman-wg-sync) and refuses any peer outside it. That is
 * deliberate rather than drift: the side with root decides what is allowed,
 * and does not take the range from the app it is guarding against.
 */
export const TUNNEL_NETWORK = '10.250.0.0/16'
const NETWORK_PREFIX = '10.250.'
export const TUNNEL_SERVER_IP = '10.250.0.1'

/**
 * Routers take 10.250.0.2 upwards, in order. The .0 and .255 of each /24
 * inside the /16 are skipped: valid host addresses in a /16, but enough
 * equipment treats them as network or broadcast addresses that they are not
 * worth the confusion. That leaves 65,023 router addresses.
 */
const LAST_THIRD = 255
const FIRST_FOURTH = 1
const LAST_FOURTH = 254

/**
 * The most routers one company may hold at once, and the most addresses it may
 * ever be handed — revoked ones count, since an address is never reused. A
 * company admin adding their own routers cannot use up the network for every
 * other tenant, by mistake or by an add-and-revoke loop. The platform operator
 * is not held to them (app/actions/tunnels.ts), so a company that genuinely
 * needs more asks.
 */
export const MAX_LIVE_ROUTERS_PER_COMPANY = 25
export const MAX_ADDRESSES_PER_COMPANY = 100

/**
 * The server's interface. Not wg0: something already gives WCN's router
 * 10.99.99.110 (seen from 10 Oct 2026), and if that is a wg0 on the box this
 * must not land on top of it.
 */
export const SERVER_INTERFACE = 'wg-routers'
export const SERVER_CONFIG_FILE = '/etc/wireguard/' + SERVER_INTERFACE + '.conf'
export const DEFAULT_SERVER_PORT = 51820

/** The router's interface, and the comments every block finds its own rows by. */
const ROUTER_INTERFACE = 'wg-ispman'
const COMMENT_INTERFACE = 'ISPMan RADIUS tunnel'
const COMMENT_PEER = 'ISPMan server'
const COMMENT_RADIUS = 'ISPMan via tunnel'

/**
 * Not RouterOS's default 13231: a router already running WireGuard has that
 * one, and a second interface on it fails. The value barely matters — it is
 * only for incoming handshakes, and the router always dials out.
 */
const ROUTER_LISTEN_PORT = 13239

/**
 * Holds the router's NAT mapping open between RADIUS requests. Several tenants
 * sit behind carrier-grade NAT (100.82.x and 100.86.x WAN addresses), where an
 * idle UDP mapping is dropped within a minute or two.
 */
const KEEPALIVE = '25s'

/** Which /radius services the tunnel entry carries. DHCP is what the tenants on this server use today. */
export const ROUTER_SERVICES = [
  { value: 'dhcp', label: 'DHCP' },
  { value: 'hotspot', label: 'Hotspot' },
  { value: 'ppp', label: 'PPPoE' },
] as const

export type RouterService = (typeof ROUTER_SERVICES)[number]['value']

/** The valid services from a list, in the canonical order, once each. */
export function parseServices(values: readonly string[]): RouterService[] {
  const wanted = new Set(values.map((v) => v.trim().toLowerCase()))
  return ROUTER_SERVICES.map((s) => s.value).filter((v) => wanted.has(v))
}

/** The last two octets of a router address, or null when it is not one. */
function routerOctets(ip: string | null | undefined): [number, number] | null {
  const bare = String(ip ?? '').trim().replace(/\/32$/, '')
  if (!bare.startsWith(NETWORK_PREFIX)) return null
  const parts = bare.slice(NETWORK_PREFIX.length).split('.')
  if (parts.length !== 2 || !parts.every((p) => /^[0-9]{1,3}$/.test(p))) return null
  const [third, fourth] = parts.map(Number)
  if (third > LAST_THIRD || fourth < FIRST_FOURTH || fourth > LAST_FOURTH) return null
  // .0.1 is the server.
  if (third === 0 && fourth === 1) return null
  return [third, fourth]
}

/**
 * A router's tunnel address as ISPMan writes it ("10.250.0.12"), or null if it
 * is not one. Postgres hands an inet back without a prefix for a host address,
 * but a "/32" is tolerated so the check cannot be defeated by formatting.
 */
export function normaliseTunnelIp(ip: string | null | undefined): string | null {
  const octets = routerOctets(ip)
  return octets ? NETWORK_PREFIX + octets[0] + '.' + octets[1] : null
}

/**
 * The lowest router address not yet handed out, or null when the network is
 * full. `used` must include revoked rows: an address is never reused, so a
 * revoked router's leftover config can never collide with a new router's.
 */
export function nextTunnelIp(used: Iterable<string>): string | null {
  const taken = new Set<string>()
  for (const ip of used) {
    const n = normaliseTunnelIp(ip)
    if (n) taken.add(n)
  }
  for (let third = 0; third <= LAST_THIRD; third++) {
    for (let fourth = FIRST_FOURTH; fourth <= LAST_FOURTH; fourth++) {
      const ip = NETWORK_PREFIX + third + '.' + fourth
      if (normaliseTunnelIp(ip) === ip && !taken.has(ip)) return ip
    }
  }
  return null
}

/**
 * A WireGuard public key as pasted, or null if it is not one.
 *
 * A key is 32 bytes in base64: 43 characters and one '='. The 43rd character
 * carries the last 4 bits of the key plus 2 bits that must be zero, so only
 * 16 characters can stand there — that one rule rejects a truncated or
 * mistyped key that would otherwise look right. Quotes and spaces from a
 * terminal copy are stripped first.
 */
export function parseWireGuardKey(raw: string | null | undefined): string | null {
  const key = String(raw ?? '').trim().replace(/^["']+|["']+$/g, '').trim()
  return /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(key) ? key : null
}

/** Enough of a key to tell two apart in a list or a log line. */
export function shortKey(key: string): string {
  return key.slice(0, 8) + '…'
}

/** Control characters out, whitespace collapsed: text that lands in a config comment must stay on one line. */
function oneLine(text: string): string {
  return Array.from(text)
    .map((c) => {
      const code = c.charCodeAt(0)
      return code < 32 || code === 127 ? ' ' : c
    })
    .join('')
    .replace(/ {2,}/g, ' ')
    .trim()
}

/**
 * Why a router name is refused, or null if it is fine.
 *
 * No '|': the audit log's `| name=value` convention would split on it. One
 * line only: the name is printed into comment lines of pasted config, and a
 * line break there would turn the rest of the name into a command.
 */
export function routerNameProblem(name: string): string | null {
  if (!name) return 'Give the router a name, e.g. "Main CCR".'
  if (name.length > 40) return 'Keep the router name to 40 characters.'
  if (name.includes('|')) return 'The router name cannot contain "|".'
  if (oneLine(name) !== name) return 'The router name must be a single line of plain text.'
  return null
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/**
 * The nas.shortname (varchar 32). The RADIUS server names a client by this in
 * its log, so it has to say whose router it is at a glance:
 * "wg12-west-central-n-main". The number is the address's place in the /16
 * (third octet x 256 + fourth), which for 10.250.0.x is the same number the
 * /24 gave, so shortnames written before the widening still read the same way.
 */
export function nasShortname(tunnelIp: string, companyName: string, routerName: string): string {
  const octets = routerOctets(tunnelIp)
  const host = octets ? String(octets[0] * 256 + octets[1]) : 'x'
  return ('wg' + host + '-' + slug(companyName).slice(0, 14) + '-' + slug(routerName))
    .slice(0, 32)
    .replace(/-+$/, '')
}

/** The nas.description (varchar 200), ASCII only so the RADIUS database's charset cannot refuse it. */
export function nasDescription(tunnelId: number, companyName: string, routerName: string): string {
  const ascii = (s: string) =>
    oneLine(Array.from(oneLine(s)).filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) < 127).join(''))
  return ('ISPMan router tunnel #' + tunnelId + ': ' + ascii(companyName) + ' / ' + ascii(routerName)).slice(0, 200)
}

// ---------------------------------------------------------------------------
// What gets pasted
// ---------------------------------------------------------------------------
//
// ON A ROUTER: ONE COMMAND AT A TIME. Pasting several lines into Winbox's
// terminal runs them joined together, or several times over (owner, 13 Oct
// 2026, doing it by hand). So nothing here hands a router a block: every
// command is a single line with its own copy button, pasted and entered on
// its own. What the blocks used to explain in # comments, the settings page
// explains beside each command.
//
// No company or router name goes into any router command, so nothing a tenant
// types can reach a router's command line.
//
// ON THE SERVER: blocks, as before. They go into a root shell over SSH, where
// a multi-line paste is fine and the heredoc needs its lines together.

/** One RouterOS command: one line, copied by its own button, pasted on its own. */
export type RouterCommand = {
  /** What it does, in a few words, shown beside the copy button. */
  label: string
  line: string
}

/** A root-shell block for the server. Only the platform operator is shown one. */
export type ConfigBlock = { title: string; text: string }

export type TunnelLabel = { companyName: string; routerName: string }

function heading(label: TunnelLabel): string {
  return oneLine(label.companyName) + ' / ' + oneLine(label.routerName)
}

/**
 * The one word the check prints on its last line, which the guide asks the
 * owner to read back before it shows anything else. Nobody reads a version
 * number or a "false" in the middle of output; asked for one word, they do.
 */
export const CHECK_VERDICTS = { ready: 'READY', ntpOff: 'NTP IS OFF', tooOld: 'TOO OLD' } as const

/**
 * The first thing pasted on a router, and the gate before anything else.
 *
 * NTP matters because WireGuard refuses a handshake timestamped older than the
 * last one it saw, and a MikroTik without a battery clock boots in the past:
 * with NTP off, the tunnel does not come back after a reboot until someone
 * sets the clock by hand.
 */
export const ROUTER_CHECK: RouterCommand = {
  label: 'Check the router',
  line:
    ':put ("RouterOS " . [/system resource get version]); ' +
    ':if ([:pick [/system resource get version] 0 1] != "7") do={ :put "' + CHECK_VERDICTS.tooOld +
    ' - this router needs RouterOS 7" } else={ :if ([/system ntp client get enabled]) do={ :put "' +
    CHECK_VERDICTS.ready + '" } else={ :put "' + CHECK_VERDICTS.ntpOff + ' - turn it on before going further" } }',
}

/**
 * Turns the NTP client on. Offered only once the check has said it is off, so
 * the servers it sets replace nothing that was in use.
 */
export const ROUTER_NTP_ON: RouterCommand = {
  label: 'Turn clock sync (NTP) on',
  line: '/system ntp client set enabled=yes servers=time.cloudflare.com,pool.ntp.org',
}

/**
 * RouterOS 6 to 7: the last 6.49 first, then the upgrade channel. Each install
 * reboots the router. Shown only when the check said TOO OLD.
 */
export const ROUTER_UPGRADE: RouterCommand[] = [
  { label: 'Back up the router', line: '/system backup save name=pre-v7' },
  { label: 'Save its config as text too', line: '/export file=pre-v7' },
  { label: 'Choose the last RouterOS 6', line: '/system package update set channel=long-term' },
  { label: 'Look for it', line: '/system package update check-for-updates' },
  { label: 'Install it (the router reboots)', line: '/system package update install' },
  { label: 'After the reboot: choose RouterOS 7', line: '/system package update set channel=upgrade' },
  { label: 'Look for it', line: '/system package update check-for-updates' },
  { label: 'Install it (the router reboots onto 7)', line: '/system package update install' },
]

/**
 * Step 2, after the check: the tunnel interface, then its public key.
 *
 * The router generates its own key pair here, and the private key never leaves
 * it. The create command checks NTP itself and stops with a plain message when
 * it is off, so skipping the check cannot leave a router that will not come
 * back after a reboot.
 */
export const ROUTER_CREATE: RouterCommand[] = [
  {
    label: 'Create the tunnel',
    line:
      ':if (![/system ntp client get enabled]) do={ :error "NTP is off - turn it on first (ISPMan, step 2)" }; ' +
      '/interface wireguard add name=' + ROUTER_INTERFACE + ' listen-port=' + ROUTER_LISTEN_PORT +
      ' comment="' + COMMENT_INTERFACE + '"',
  },
  {
    label: "Print the router's public key",
    line: ':put [/interface wireguard get [find name=' + ROUTER_INTERFACE + '] public-key]',
  },
]

export type ConnectInput = {
  tunnelIp: string
  serverPublicKey: string
  serverEndpoint: string
  serverPort: number
  /** The router's RADIUS secret, from its nas row. Letters and digits only, so it needs no quoting. */
  secret: string
  services: readonly RouterService[]
}

/**
 * Step 4, on the router: the server end of the tunnel, the router's fixed
 * address (point-to-point, so it brings its own route and no /ip route is
 * needed), and the RADIUS entry, moved to the top of the list.
 *
 * ADDS ONLY. The router's existing public RADIUS entry stays below the new one
 * as the fallback for the move. Removing it is the cutover, done by hand per
 * router once the tunnel has run clean (docs/wireguard-tunnels.md).
 */
export function routerConnect(input: ConnectInput): RouterCommand[] {
  const ip = input.tunnelIp
  return [
    {
      label: 'Point the tunnel at the server',
      line:
        '/interface wireguard peers add interface=' + ROUTER_INTERFACE +
        ' public-key="' + input.serverPublicKey + '"' +
        ' endpoint-address=' + input.serverEndpoint +
        ' endpoint-port=' + input.serverPort +
        ' allowed-address=' + TUNNEL_SERVER_IP + '/32' +
        ' persistent-keepalive=' + KEEPALIVE +
        ' comment="' + COMMENT_PEER + '"',
    },
    {
      label: "Give the router its tunnel address",
      line:
        '/ip address add address=' + ip + '/32 network=' + TUNNEL_SERVER_IP +
        ' interface=' + ROUTER_INTERFACE + ' comment="' + COMMENT_INTERFACE + '"',
    },
    {
      label: 'Send RADIUS through the tunnel',
      line:
        '/radius add address=' + TUNNEL_SERVER_IP + ' src-address=' + ip +
        ' secret="' + input.secret + '" service=' + input.services.join(',') +
        ' timeout=1s comment="' + COMMENT_RADIUS + '"',
    },
    {
      label: 'Make it the first RADIUS entry',
      line:
        ':do { /radius move [find comment="' + COMMENT_RADIUS + '"] destination=[:pick [/radius find] 0] } ' +
        'on-error={ :put "already first" }',
    },
  ]
}

/** From the router's side: last-handshake should be within the last few minutes. */
export const ROUTER_CHECK_TUNNEL: RouterCommand = {
  label: 'See the tunnel from the router',
  line: '/interface wireguard peers print detail where comment="' + COMMENT_PEER + '"',
}

type PeerInput = TunnelLabel & { tunnelId: number; tunnelIp: string; publicKey: string }

function peerMarker(tunnelId: number): string {
  return 'ISPMan router tunnel #' + tunnelId
}

/**
 * On the server: the peer, live and in the config file, then the RADIUS
 * server restart that loads the router's new nas row.
 *
 * Operator only (apply_router_tunnels_on_server). Its comments still say "the
 * RADIUS server", like everything else on screen; only the service command
 * itself has to name the software, because that is what gets typed.
 */
export function serverAddPeer(input: PeerInput): ConfigBlock {
  return {
    title: 'Server (root)',
    text: [
      '# On the ISPMan server, as root - add ' + heading(input) + ' (' + input.tunnelIp + ')',
      'wg set ' + SERVER_INTERFACE + ' peer ' + input.publicKey + ' allowed-ips ' + input.tunnelIp + '/32',
      'cat >> ' + SERVER_CONFIG_FILE + " <<'EOF'",
      '',
      '# ' + peerMarker(input.tunnelId) + ' - ' + heading(input),
      '[Peer]',
      'PublicKey = ' + input.publicKey,
      'AllowedIPs = ' + input.tunnelIp + '/32',
      'EOF',
      '#',
      '# The RADIUS server reads its client list only when it starts, so it must',
      '# restart to know this router. The config check runs first; if it fails,',
      '# nothing restarts.',
      '# Adding several routers? Run this once, after the last one.',
      'freeradius -C && systemctl restart freeradius',
    ].join('\n'),
  }
}

/** On the server: swap a router's key. The nas row is keyed on the tunnel address, which has not moved, so the RADIUS server needs no restart. */
export function serverReplacePeer(input: PeerInput & { oldPublicKey: string }): ConfigBlock {
  return {
    title: 'Server (root)',
    text: [
      '# On the ISPMan server, as root - new key for ' + heading(input) + ' (' + input.tunnelIp + ')',
      'wg set ' + SERVER_INTERFACE + ' peer ' + input.oldPublicKey + ' remove',
      'wg set ' + SERVER_INTERFACE + ' peer ' + input.publicKey + ' allowed-ips ' + input.tunnelIp + '/32',
      "sed -i 's|" + input.oldPublicKey + '|' + input.publicKey + "|' " + SERVER_CONFIG_FILE,
      '# No RADIUS server restart: the tunnel address and its client entry are unchanged.',
    ].join('\n'),
  }
}

/** On the server: drop a revoked router's peer. */
export function serverRemovePeer(input: PeerInput): ConfigBlock {
  return {
    title: 'Server (root)',
    text: [
      '# On the ISPMan server, as root - remove ' + heading(input) + ' (' + input.tunnelIp + ')',
      'wg set ' + SERVER_INTERFACE + ' peer ' + input.publicKey + ' remove',
      '# Then delete the [Peer] block headed "' + peerMarker(input.tunnelId) + '" from',
      '# ' + SERVER_CONFIG_FILE + ', or the peer comes back on the next restart.',
    ].join('\n'),
  }
}

/**
 * On the router: take the tunnel off again. Only if the router still has its
 * public RADIUS entry, or is being retired: without one it has no RADIUS at all.
 */
export const ROUTER_REMOVE: RouterCommand[] = [
  { label: 'Remove the tunnel RADIUS entry', line: '/radius remove [find comment="' + COMMENT_RADIUS + '"]' },
  { label: 'Remove the tunnel address', line: '/ip address remove [find comment="' + COMMENT_INTERFACE + '"]' },
  { label: 'Remove the server end', line: '/interface wireguard peers remove [find comment="' + COMMENT_PEER + '"]' },
  { label: 'Remove the tunnel', line: '/interface wireguard remove [find name=' + ROUTER_INTERFACE + ']' },
]
