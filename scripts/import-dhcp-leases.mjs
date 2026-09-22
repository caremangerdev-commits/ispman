#!/usr/bin/env node
/**
 * ONE-OFF: stub customers from a MikroTik DHCP lease export.
 *
 * DISPOSABLE. Written for JMEDIA Wireless (company 30), whose only customer
 * list is the router's lease table. Delete once the owner has filled the
 * records in. Nothing in the app imports it.
 *
 *   node scripts/import-dhcp-leases.mjs <lease-file> <company_id> [--exported=YYYY-MM-DD] [--apply]
 *
 *   node scripts/import-dhcp-leases.mjs leases.txt 30 --exported=2026-09-16
 *
 * A DRY RUN PRINTS EVERY LEASE AND STOPS. It is the default; nothing is
 * written without --apply.
 *
 * WHAT A LEASE BECOMES
 *   A stub: the whole hostname as the first name, a blank last name, the MAC
 *   address, the company's cut-off day stated explicitly, and nothing else.
 *   No phone, address, rate or plan exists anywhere to import, so none is
 *   invented. The owner fills the rest in. Until they do, the stub is inert:
 *   the bill run skips a zero rate and an unprovisioned MAC, the list shows
 *   "unprovisioned" because radcheck has no row, and no expiry is derived
 *   because last_bill_date is null.
 *
 * HOW A LEASE IS SORTED — customer, infrastructure, device, or held
 *   The table mixes subscriber CPEs with the ISP's own backhauls and with
 *   whatever laptops and phones happened to ask for an address. The rules,
 *   in order, with the reason printed beside every row:
 *
 *   infrastructure  hostname starts with the company prefix (JMEDIA-), or the
 *                   client class is "Switch". Never a customer.
 *   device          a randomised MAC (locally administered bit set) — phones
 *                   and tablets rotate these, so the row is not a stable
 *                   identity; or a hostname of the LAPTOP-/DESKTOP-/-Tab-
 *                   shape, or an Android DHCP class. Someone's gadget behind
 *                   a CPE, not the CPE.
 *   held            a factory default hostname (Nexxt_XXXXXX, NCM-X1800,
 *                   IP3442ML) or no hostname at all on a real MAC. Could be
 *                   a subscriber's own router or an unrenamed CPE. Neither
 *                   call is safe from the file, so these are listed for the
 *                   owner and not imported.
 *   customer        everything else with a hostname.
 *
 *   The rules are printed, not hidden: every row says which one fired.
 *
 * THE GUARDRAILS FROM migrate-legacy-company.mjs, kept on purpose
 *   - mac_address and date_added are ALWAYS present and explicit. Both have
 *     column defaults (00:00:00:00:00:00 and CURRENT_DATE) that would win
 *     silently if the key were left out.
 *   - date_added is the EXPORT DATE, passed in, not the run date and not the
 *     lease age. No signup date exists; the export date is the one honest
 *     fact, and it is stated in the notes so nobody later reads it as a
 *     signup.
 *   - account numbers are allocated here from the company counter, and the
 *     counter is moved past them, because a plain insert never calls the
 *     app's allocator.
 *   - NO LOG ROWS and NO radcheck writes. The app's create path logs
 *     customer_added and provisions the MAC; this path does neither, so these
 *     never read as new signups and nobody gets network access from a
 *     lease table.
 *   - Idempotent on MAC: a lease whose MAC already belongs to a customer in
 *     the company is skipped, so a re-run adds nothing twice.
 */

import { readFileSync } from 'node:fs'
import process from 'node:process'

import { createClient } from '@supabase/supabase-js'

// --- arguments -----------------------------------------------------------------

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--') && !a.includes('=')))
const opts = Object.fromEntries(
  argv.filter((a) => a.startsWith('--') && a.includes('='))
    .map((a) => [a.slice(2, a.indexOf('=')), a.slice(a.indexOf('=') + 1)])
)
const positional = argv.filter((a) => !a.startsWith('--'))
const FILE = positional[0]
const COMPANY_ID = Number(positional[1])
const APPLY = flags.has('--apply')
const EXPORTED = opts.exported ?? null

if (!FILE || !Number.isInteger(COMPANY_ID)) {
  console.error('Usage: node scripts/import-dhcp-leases.mjs <lease-file> <company_id> [--exported=YYYY-MM-DD] [--apply]')
  process.exit(1)
}
for (const f of flags) if (f !== '--apply') { console.error('Unknown flag ' + f); process.exit(1) }
for (const k of Object.keys(opts)) if (k !== 'exported') { console.error('Unknown option --' + k); process.exit(1) }

// --- environment -----------------------------------------------------------------

function loadEnv(file = '.env.local') {
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
}
loadEnv()
const need = (n) => {
  const v = process.env[n]
  if (!v) { console.error('Missing ' + n); process.exit(1) }
  return v
}
const supabase = createClient(need('NEXT_PUBLIC_SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
})

/** Mirrors lib/account-number.ts#ACCOUNT_SEQ_BASE, as migrate-legacy-company.mjs does. */
const ACCOUNT_SEQ_BASE = 10000

// --- the lease export ----------------------------------------------------------------
//
// RouterOS "/ip dhcp-server lease print detail" output. One lease per line:
// an index, optional flags (D = dynamic), then key=value pairs. VALUES MAY
// CONTAIN SPACES ("host-name=Miss patty class-id=udhcp 1.19.4"), so a split
// on whitespace is wrong. Keys are found by their shape and each value runs
// to the start of the next key.

const KEY = /(?:^|\s)([a-z][a-z0-9-]*)=/g

function parseLease(line) {
  const m = /^\s*(\d+)\s+([A-Z ]*?)\s*(address=.*)$/.exec(line)
  if (!m) return null
  const [, index, flags, rest] = m
  const fields = {}
  const hits = [...rest.matchAll(KEY)]
  hits.forEach((h, i) => {
    const start = h.index + h[0].length
    const end = i + 1 < hits.length ? hits[i + 1].index : rest.length
    fields[h[1]] = rest.slice(start, end).trim()
  })
  return { index: Number(index), dynamic: flags.includes('D'), fields, raw: line }
}

function parseFile(path) {
  const header = []
  const leases = []
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    if (line.startsWith('#')) { header.push(line); continue }
    const lease = parseLease(line)
    if (lease) leases.push(lease)
    else console.error('unparsed line: ' + line.slice(0, 80))
  }
  return { header, leases }
}

/** The export date, from the RouterOS header comment unless --exported says otherwise. */
function exportDate(header) {
  if (EXPORTED) return EXPORTED
  for (const h of header) {
    const m = /^#\s*(\d{4}-\d{2}-\d{2})\s/.exec(h)
    if (m) return m[1]
  }
  return null
}

// --- sorting -------------------------------------------------------------------------

/** Same rule as migrate-legacy-company.mjs#normaliseMac. */
function normaliseMac(raw) {
  const hex = (raw ?? '').toString().trim().replace(/[\s:.-]/g, '')
  if (!/^[0-9a-fA-F]{12}$/.test(hex)) return null
  const mac = hex.toUpperCase().match(/.{2}/g).join(':')
  return mac === '00:00:00:00:00:00' ? null : mac
}

/** Bit 1 of the first octet: a locally administered (randomised) address. */
function isLocallyAdministered(mac) {
  return (parseInt(mac.slice(0, 2), 16) & 0x02) !== 0
}

const OWN_PREFIX = /^JMEDIA-/i
const DEVICE_HOST = /^(LAPTOP|DESKTOP)-|-Tab-|^iPhone|^Galaxy|^android/i
const DEFAULT_HOST = /^(Nexxt_[0-9A-F]{6}|NCM-X\d+|IP\d{4}[A-Z]*)$/i

function classify(lease) {
  const host = (lease.fields['host-name'] ?? '').trim()
  const cls = (lease.fields['class-id'] ?? '').trim()
  const mac = normaliseMac(lease.fields['mac-address'])
  if (!mac) return { kind: 'held', why: 'no usable MAC' }
  if (OWN_PREFIX.test(host)) return { kind: 'infrastructure', why: 'hostname carries the company prefix (backhaul)' }
  if (/^switch$/i.test(cls)) return { kind: 'infrastructure', why: 'client class "Switch"' }
  if (isLocallyAdministered(mac)) return { kind: 'device', why: 'randomised (locally administered) MAC — a phone or tablet, not a stable identity' }
  if (DEVICE_HOST.test(host)) return { kind: 'device', why: 'hostname is a laptop/desktop/tablet name' }
  if (/^android-dhcp/i.test(cls)) return { kind: 'device', why: 'Android DHCP client' }
  if (!host) return { kind: 'held', why: 'no hostname — nothing to name a customer from' }
  if (DEFAULT_HOST.test(host)) return { kind: 'held', why: 'factory default hostname — could be a subscriber\'s own router or an unrenamed CPE' }
  return { kind: 'customer', why: 'named CPE' }
}

/**
 * Hostname -> name. THE WHOLE HOSTNAME IS THE FIRST NAME AND THE LAST NAME
 * IS BLANK. No splitting on spaces, no honorific handling, no title-casing:
 * "Miss patty" is not a first name and a surname, and neither is "Rent13 Mr
 * Fix It! Nanny Bar", and a rule that guesses gets some of them wrong in a
 * way that looks deliberate. The owner corrects each one; until then the
 * name reads exactly as the installer typed it, with runs of whitespace
 * collapsed. The raw hostname is kept in notes as well.
 */
function splitName(host) {
  return { first: host.trim().replace(/\s+/g, ' '), last: '' }
}

// --- main ------------------------------------------------------------------------------

async function main() {
  const { header, leases } = parseFile(FILE)
  const exported = exportDate(header)
  if (!exported) {
    console.error('Could not read the export date from the file header; pass --exported=YYYY-MM-DD')
    process.exit(1)
  }

  const { data: company } = await supabase.from('companies').select('id, name').eq('id', COMPANY_ID).maybeSingle()
  if (!company) throw new Error('No ISPMan company #' + COMPANY_ID)
  const { data: settings } = await supabase
    .from('settings')
    .select('account_number_prefix, default_expiry_mode, default_billing_type, bill_date, cut_off_date')
    .eq('company_id', COMPANY_ID).maybeSingle()
  const cutOffDay = Number(settings?.cut_off_date)
  if (!Number.isInteger(cutOffDay) || cutOffDay < 1 || cutOffDay > 28) {
    throw new Error('Company ' + COMPANY_ID + ' has no usable cut-off day in settings (' + settings?.cut_off_date + '); refusing to guess one.')
  }

  console.log('='.repeat(74))
  console.log('DHCP LEASE IMPORT' + (APPLY ? '  [LIVE]' : '  [DRY RUN — nothing will be written]'))
  console.log('='.repeat(74))
  console.log('  company      : ' + COMPANY_ID + ' ' + company.name)
  console.log('  file         : ' + FILE + ' (' + leases.length + ' leases, exported ' + exported + ')')
  console.log('  cut-off day  : ' + cutOffDay + ' (company setting, stated on every stub)')

  // --- sort ---------------------------------------------------------------------------
  const sorted = leases.map((l) => ({ ...l, mac: normaliseMac(l.fields['mac-address']), host: (l.fields['host-name'] ?? '').trim(), ...classify(l) }))

  // --- duplicates -----------------------------------------------------------------------
  const byMac = new Map()
  for (const l of sorted) byMac.set(l.mac, [...(byMac.get(l.mac) ?? []), l])
  const dupMacs = [...byMac.entries()].filter(([, v]) => v.length > 1)
  const byHost = new Map()
  for (const l of sorted) {
    if (!l.host) continue
    const k = l.host.toLowerCase().replace(/\s+/g, ' ')
    byHost.set(k, [...(byHost.get(k) ?? []), l])
  }
  const dupHosts = [...byHost.entries()].filter(([, v]) => v.length > 1)
  // Same first word among customer rows: possibly one household with two CPEs,
  // or two people. Reported, and both imported — different MACs are different
  // radios, and the owner can merge.
  const byFirst = new Map()
  for (const l of sorted.filter((x) => x.kind === 'customer')) {
    const k = l.host.toLowerCase().split(/\s+/)[0]
    byFirst.set(k, [...(byFirst.get(k) ?? []), l])
  }
  const nearDups = [...byFirst.entries()].filter(([, v]) => v.length > 1)

  // --- already in ISPMan --------------------------------------------------------------
  const { data: existing } = await supabase
    .from('customers').select('id, first_name, last_name, mac_address').eq('company_id', COMPANY_ID)
  const existingByMac = new Map((existing ?? []).filter((c) => c.mac_address).map((c) => [c.mac_address.toUpperCase(), c]))

  // --- account numbers, as the migration does it --------------------------------------
  const prefix = String(settings?.account_number_prefix ?? '').toUpperCase().replace(/[^A-Z]/g, '')
  const { data: counter } = await supabase
    .from('account_counters').select('next_value').eq('company_id', COMPANY_ID).maybeSingle()
  const accountBase = Number(counter?.next_value ?? ACCOUNT_SEQ_BASE + 1)

  // --- the rows -------------------------------------------------------------------------
  const candidates = []
  const skippedExisting = []
  for (const l of sorted.filter((x) => x.kind === 'customer')) {
    const hit = existingByMac.get(l.mac)
    if (hit) { skippedExisting.push({ lease: l, customer: hit }); continue }
    candidates.push(l)
  }
  candidates.forEach((l, i) => {
    const digits = String(Math.max(ACCOUNT_SEQ_BASE + 1, accountBase + i))
    l.account_number = prefix ? prefix + '-' + digits : digits
    const { first, last } = splitName(l.host)
    l.payload = {
      company_id: COMPANY_ID,
      first_name: first,
      last_name: last,
      phone: null,
      address: null,
      gps: null,
      notes: 'Stub from DHCP lease export ' + exported + ' | host-name=' + l.host.replace(/\|/g, '/') +
        ' | ip=' + (l.fields.address ?? '') + ' | date_added is the export date, not a signup date',
      customer_type: 'dhcp',
      pppoe_username: null,
      // ALWAYS PRESENT AND EXPLICIT — see the header.
      mac_address: l.mac,
      date_added: exported,
      account_number: l.account_number,
      monthly_rate: 0,
      balance: 0,
      carried_balance: 0,
      account_credit: 0,
      // Nothing branches on billing_type (lib/billing.ts) but the column is
      // NOT NULL, so it is stated rather than left to chance.
      billing_type: settings?.default_billing_type ?? 'prepaid',
      // THE THIRD SILENT DEFAULT. cut_off_date defaults to 5 in the schema, so
      // leaving the key out would give every stub a cut-off day nobody chose.
      // It is the company's cut-off day, STATED, not inherited: no customer on
      // the platform has a null cut-off day and a live company is not the
      // place to find out what one breaks.
      cut_off_date: cutOffDay,
      last_bill_date: null,
      ...(settings?.bill_date != null ? { bill_date: settings.bill_date } : {}),
      ...(settings?.default_expiry_mode ? { expiry_mode: settings.default_expiry_mode } : {}),
    }
  })

  // --- report, every row --------------------------------------------------------------
  const tally = {}
  for (const l of sorted) tally[l.kind] = (tally[l.kind] ?? 0) + 1
  console.log('  sorted       : ' + Object.entries(tally).map(([k, n]) => k + '=' + n).join(', '))
  console.log('  already here : ' + skippedExisting.length + '   to create: ' + candidates.length)
  console.log('  account nos. : ' + (candidates.length ? candidates[0].account_number + ' .. ' + candidates.at(-1).account_number : 'none') + (prefix ? '  (prefix ' + prefix + ')' : ''))

  console.log('\nEVERY LEASE')
  console.log('  idx | mac | ip | last-seen | hostname | class | -> kind | why | would create')
  for (const l of sorted) {
    const create = l.payload
      ? l.account_number + ' first="' + l.payload.first_name + '" last="' + l.payload.last_name + '" cut-off=' + l.payload.cut_off_date
      : existingByMac.get(l.mac) && l.kind === 'customer' ? 'SKIP, already customer #' + existingByMac.get(l.mac).id : '-'
    console.log('  ' + [
      String(l.index).padStart(2), l.mac ?? '(bad)', l.fields.address ?? '', l.fields['last-seen'] ?? '',
      l.host || '(none)', l.fields['class-id'] || '(none)', l.kind.toUpperCase(), l.why, create,
    ].join(' | '))
  }

  console.log('\nDUPLICATES')
  console.log('  same MAC      : ' + (dupMacs.length ? dupMacs.map(([m, v]) => m + ' x' + v.length).join(', ') : 'none'))
  console.log('  same hostname : ' + (dupHosts.length ? dupHosts.map(([h, v]) => '"' + h + '" x' + v.length + ' (' + v.map((x) => x.mac + ' ' + x.kind).join(', ') + ')').join('; ') : 'none'))
  console.log('  same first word among customers: ' + (nearDups.length
    ? nearDups.map(([w, v]) => '"' + w + '": ' + v.map((x) => '"' + x.host + '" ' + x.mac).join(' vs ')).join('; ')
    : 'none') + '  — both imported; the owner merges if they are one household')

  if (!APPLY) {
    if (candidates.length) {
      console.log('\n  sample payload (first customer, not written):')
      console.log('    ' + JSON.stringify(candidates[0].payload, null, 2).replace(/\n/g, '\n    '))
    }
    console.log('\n  DRY RUN: would create ' + candidates.length + ' stub customer(s), move the account counter to ' +
      (accountBase + candidates.length) + ', write no log rows and touch no radcheck. Nothing written.')
    return
  }

  // --- apply --------------------------------------------------------------------------------
  let inserted = 0
  const failed = []
  const { error } = await supabase.from('customers').insert(candidates.map((l) => l.payload))
  if (error) {
    for (const l of candidates) {
      const { error: e } = await supabase.from('customers').insert(l.payload)
      if (e) failed.push({ l, why: e.message }); else inserted += 1
    }
  } else {
    inserted = candidates.length
  }
  console.log('\n  inserted : ' + inserted + (failed.length ? '   FAILED ' + failed.length : ''))
  for (const f of failed) console.log('    ' + f.l.mac + ' "' + f.l.host + '": ' + f.why)

  // Move the counter past what was used, so the app's next customer continues the run.
  if (inserted > 0) {
    const nextValue = accountBase + candidates.length
    const { error: counterErr } = await supabase
      .from('account_counters')
      .update({ next_value: nextValue, updated_at: new Date().toISOString() })
      .eq('company_id', COMPANY_ID)
    if (counterErr) console.log('  !! account counter not moved: ' + counterErr.message + ' — set next_value to ' + nextValue + ' by hand')
    else console.log('  account counter -> ' + nextValue)
  }
  console.log('  log rows : none written   radcheck : not touched')
}

main().catch((err) => {
  console.error('\nFAILED: ' + err.message)
  process.exit(1)
})
