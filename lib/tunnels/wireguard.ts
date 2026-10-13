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
 * 10.250.0.0/24. Picked because nothing a tenant uses overlaps it: 90 days of
 * radacct (13 Oct 2026) showed customer pools and NAS addresses in 10.5, 10.9,
 * 10.10, 10.11, 10.30, 10.99, 100.100, 172.16, 172.30, 172.168 and 192.168, and
 * the EC2 default VPC is 172.31. A router whose own LAN overlapped the tunnel
 * could not route to it.
 */
export const TUNNEL_NETWORK = '10.250.0.0/24'
const TUNNEL_PREFIX = '10.250.0.'
export const TUNNEL_SERVER_IP = TUNNEL_PREFIX + '1'
/** Routers take .2 to .254; .1 is the server. */
const FIRST_HOST = 2
const LAST_HOST = 254

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

/**
 * A tunnel address as ISPMan writes it ("10.250.0.12"), or null if it is not
 * one. Postgres hands an inet back without a prefix for a host address, but a
 * "/32" is tolerated so the check cannot be defeated by formatting.
 */
export function normaliseTunnelIp(ip: string | null | undefined): string | null {
  const bare = String(ip ?? '').trim().replace(/\/32$/, '')
  if (!bare.startsWith(TUNNEL_PREFIX)) return null
  const host = bare.slice(TUNNEL_PREFIX.length)
  if (!/^[0-9]{1,3}$/.test(host)) return null
  const n = Number(host)
  return n >= FIRST_HOST && n <= LAST_HOST ? TUNNEL_PREFIX + n : null
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
  for (let host = FIRST_HOST; host <= LAST_HOST; host++) {
    const ip = TUNNEL_PREFIX + host
    if (!taken.has(ip)) return ip
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
 * The nas.shortname (varchar 32). FreeRADIUS names a client by this in its
 * log, so it has to say whose router it is at a glance: "wg12-west-central-n-main".
 */
export function nasShortname(tunnelIp: string, companyName: string, routerName: string): string {
  const host = tunnelIp.slice(TUNNEL_PREFIX.length)
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
// Config blocks
// ---------------------------------------------------------------------------

export type ConfigBlock = {
  title: string
  /** Where it is pasted: a router's terminal, or a root shell on the server. */
  where: 'router' | 'server'
  text: string
}

export type TunnelLabel = { companyName: string; routerName: string }

function heading(label: TunnelLabel): string {
  return oneLine(label.companyName) + ' / ' + oneLine(label.routerName)
}

/**
 * Step 1, on the router: two checks, then the interface. The router generates
 * its key pair here and prints only the public half for the owner to paste
 * back. Contains nothing secret, so it can be shown again at any time.
 */
export function routerStepOne(label: TunnelLabel): ConfigBlock {
  return {
    title: 'Router, step 1 of 2',
    where: 'router',
    text: [
      '# ISPMan RADIUS tunnel - ' + heading(label) + ' - STEP 1 OF 2',
      "# Paste into the router's terminal. RouterOS 7 only.",
      '#',
      '# Two checks first. The version must start with 7. NTP must say true:',
      '# after a reboot WireGuard will not reconnect until the clock is right.',
      ':put ("RouterOS " . [/system resource get version])',
      ':put ("NTP client enabled: " . [/system ntp client get enabled])',
      '#',
      '# The tunnel interface. The router generates its own private key here,',
      '# and the private key never leaves the router.',
      '/interface wireguard add name=' + ROUTER_INTERFACE + ' listen-port=' + ROUTER_LISTEN_PORT +
        ' comment="' + COMMENT_INTERFACE + '"',
      '#',
      "# The router's PUBLIC key. Paste the line this prints back into ISPMan.",
      ':put [/interface wireguard get [find name=' + ROUTER_INTERFACE + '] public-key]',
    ].join('\n'),
  }
}

export type StepTwoInput = TunnelLabel & {
  tunnelIp: string
  serverPublicKey: string
  serverEndpoint: string
  serverPort: number
  /** The router's RADIUS secret, from its nas row. Letters and digits only, so it needs no quoting. */
  secret: string
  services: readonly RouterService[]
}

/**
 * Step 2, on the router: the peer, the address, and the /radius entry.
 *
 * ADDS ONLY. The router's existing public /radius entry stays, below the new
 * one, as the fallback for the move. Removing it is the cutover, done by hand
 * per router once the tunnel has run clean (docs/wireguard-tunnels.md).
 */
export function routerStepTwo(input: StepTwoInput): ConfigBlock {
  const ip = input.tunnelIp
  return {
    title: 'Router, step 2 of 2',
    where: 'router',
    text: [
      '# ISPMan RADIUS tunnel - ' + heading(input) + ' - STEP 2 OF 2',
      "# This router's tunnel address is " + ip + '. RouterOS 7 only.',
      '#',
      '# The server end of the tunnel. The keepalive holds the router\'s NAT open',
      '# so the tunnel stays up between RADIUS requests.',
      '/interface wireguard peers add interface=' + ROUTER_INTERFACE +
        ' public-key="' + input.serverPublicKey + '"' +
        ' endpoint-address=' + input.serverEndpoint +
        ' endpoint-port=' + input.serverPort +
        ' allowed-address=' + TUNNEL_SERVER_IP + '/32' +
        ' persistent-keepalive=' + KEEPALIVE +
        ' comment="' + COMMENT_PEER + '"',
      '#',
      "# The router's fixed tunnel address. Point-to-point, so it brings its own",
      '# route to ' + TUNNEL_SERVER_IP + ' and no /ip route is needed.',
      '/ip address add address=' + ip + '/32 network=' + TUNNEL_SERVER_IP +
        ' interface=' + ROUTER_INTERFACE + ' comment="' + COMMENT_INTERFACE + '"',
      '#',
      '# RADIUS through the tunnel, sent from the tunnel address, then moved to',
      '# the top of the list so it is asked first. KEEP the existing public entry',
      '# below it: it is the fallback until this router is cut over.',
      '/radius add address=' + TUNNEL_SERVER_IP + ' src-address=' + ip +
        ' secret="' + input.secret + '" service=' + input.services.join(',') +
        ' timeout=1s comment="' + COMMENT_RADIUS + '"',
      ':do { /radius move [find comment="' + COMMENT_RADIUS + '"] destination=[:pick [/radius find] 0] } on-error={ :put "tunnel entry already first" }',
      '#',
      '# Check: last-handshake should appear within a minute, and the tunnel',
      '# entry should be first in the list.',
      '/interface wireguard peers print detail where comment="' + COMMENT_PEER + '"',
      '/radius print',
    ].join('\n'),
  }
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
    where: 'server',
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
    where: 'server',
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
    where: 'server',
    text: [
      '# On the ISPMan server, as root - remove ' + heading(input) + ' (' + input.tunnelIp + ')',
      'wg set ' + SERVER_INTERFACE + ' peer ' + input.publicKey + ' remove',
      '# Then delete the [Peer] block headed "' + peerMarker(input.tunnelId) + '" from',
      '# ' + SERVER_CONFIG_FILE + ', or the peer comes back on the next restart.',
    ].join('\n'),
  }
}

/** On the router: take the tunnel out again. */
export function routerRemove(label: TunnelLabel): ConfigBlock {
  return {
    title: 'Router',
    where: 'router',
    text: [
      '# ISPMan RADIUS tunnel - ' + heading(label) + ' - REMOVE',
      '# Only if the router still has its public /radius entry, or is being',
      '# retired: without one it has no RADIUS at all.',
      '/radius remove [find comment="' + COMMENT_RADIUS + '"]',
      '/ip address remove [find comment="' + COMMENT_INTERFACE + '"]',
      '/interface wireguard peers remove [find comment="' + COMMENT_PEER + '"]',
      '/interface wireguard remove [find name=' + ROUTER_INTERFACE + ']',
    ].join('\n'),
  }
}
