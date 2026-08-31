/**
 * Seeds the ISPMan demo dataset.
 *
 * Idempotent by design: if the `companies` table already has rows the script
 * exits without touching anything. Pass --force to wipe and reseed.
 *
 *   node scripts/seed.mjs [--force]
 */
import { readFileSync } from 'node:fs'

// --- env -------------------------------------------------------------------
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}
const BASE = process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!BASE || !KEY) throw new Error('Missing Supabase env vars in .env.local')

const ADMIN_EMAIL = 'haydn@ispman.com'

/** Password given to every seeded staff account except the original admin. */
const STAFF_PASSWORD = 'Admin1234!'

/**
 * One account per role.
 *
 * The original admin was seeded with role 'admin', which is not a value
 * lib/permissions.ts knows about — it is corrected to 'company_admin' here.
 */
const TEAM = [
  { first: 'Haydn', last: 'Samuels', email: ADMIN_EMAIL, role: 'company_admin', auth: false },
  // Not in the original spec's user list, but /superadmin is unreachable —
  // and therefore untestable — without an account holding this role.
  { first: 'Platform', last: 'Owner', email: 'superadmin@ispman.com', role: 'super_admin', auth: true },
  { first: 'Marlon', last: 'Service', email: 'manager@demoisp.com', role: 'manager', auth: true },
  { first: 'Kayla', last: 'Reid', email: 'csr@demoisp.com', role: 'csr', auth: true },
  { first: 'Denise', last: 'Palmer', email: 'cashier@demoisp.com', role: 'cashier', auth: true },
  { first: 'Trevor', last: 'Case', email: 'tech@demoisp.com', role: 'technician', auth: true },
]

// --- tiny PostgREST client -------------------------------------------------
const H = {
  apikey: KEY,
  Authorization: 'Bearer ' + KEY,
  'Content-Type': 'application/json',
}

async function insert(table, rows) {
  // PostgREST rejects a bulk insert whose objects have differing key sets
  // ("All object keys must match"), so pad every row to the union of keys.
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))]
  const padded = rows.map((r) =>
    Object.fromEntries(keys.map((k) => [k, r[k] === undefined ? null : r[k]]))
  )

  const res = await fetch(BASE + '/rest/v1/' + table, {
    method: 'POST',
    headers: { ...H, Prefer: 'return=representation' },
    body: JSON.stringify(padded),
  })
  if (!res.ok) {
    throw new Error('insert ' + table + ' -> ' + res.status + ' ' + (await res.text()))
  }
  return res.json()
}

async function count(table) {
  const res = await fetch(BASE + '/rest/v1/' + table + '?select=id', {
    headers: { ...H, Prefer: 'count=exact', Range: '0-0' },
  })
  return Number((res.headers.get('content-range') || '/0').split('/')[1])
}

/** True when migration 0005 has been applied. */
async function hasCatalog() {
  const res = await fetch(BASE + '/rest/v1/service_plans?select=id&limit=1', { headers: H })
  return res.ok
}

async function wipe(table) {
  const res = await fetch(BASE + '/rest/v1/' + table + '?id=gt.0', {
    method: 'DELETE',
    headers: H,
  })
  // A table that no longer exists is fine — customer_groups is dropped by
  // migration 0007, and the seed must work either side of that.
  if (res.status === 404) return
  // Anything else must surface: silently ignoring this once hid a foreign-key
  // violation on companies.
  if (!res.ok) {
    throw new Error('wipe ' + table + ' -> ' + res.status + ' ' + (await res.text()))
  }
}

/**
 * Creates the Supabase auth account for a staff member, or resets its password
 * if it already exists.
 *
 * `auth.users` and the application `users` table are separate stores joined
 * only by email, so both halves must exist before someone can sign in and
 * resolve a profile.
 */
async function ensureAuthUser(email, password) {
  const create = await fetch(BASE + '/auth/v1/admin/users', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ email, password, email_confirm: true }),
  })

  if (create.ok) return 'created'

  const body = await create.text()
  const alreadyExists =
    create.status === 422 || /already|exists|registered/i.test(body)
  if (!alreadyExists) {
    throw new Error('auth create ' + email + ' -> ' + create.status + ' ' + body)
  }

  // Already present: find its id and reset the password so the documented
  // credentials always work after a reseed.
  const list = await fetch(
    BASE + '/auth/v1/admin/users?page=1&per_page=200',
    { headers: H }
  )
  if (!list.ok) throw new Error('auth list -> ' + list.status)

  const { users = [] } = await list.json()
  const found = users.find((u) => (u.email || '').toLowerCase() === email.toLowerCase())
  if (!found) throw new Error('auth user ' + email + ' reported as existing but not found')

  const update = await fetch(BASE + '/auth/v1/admin/users/' + found.id, {
    method: 'PUT',
    headers: H,
    body: JSON.stringify({ password, email_confirm: true }),
  })
  if (!update.ok) {
    throw new Error('auth update ' + email + ' -> ' + update.status + ' ' + (await update.text()))
  }
  return 'password reset'
}

// --- deterministic pseudo-random so reseeds look identical -----------------
let seedState = 1337
function rnd() {
  seedState = (seedState * 1103515245 + 12345) & 0x7fffffff
  return seedState / 0x7fffffff
}
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1))
const pick = (arr) => arr[int(0, arr.length - 1)]

// --- date helpers ----------------------------------------------------------
const DAY = 86400000
const today = new Date()
today.setHours(12, 0, 0, 0)

const iso = (d) => d.toISOString()
const ymd = (d) => d.toISOString().slice(0, 10)
const daysFromNow = (n) => new Date(today.getTime() + n * DAY)
const hoursAgo = (h) => new Date(today.getTime() - h * 3600000)

/** last_bill_date that makes a one-month service period expire `n` days out. */
function billDateForExpiryIn(n) {
  const d = daysFromNow(n)
  d.setMonth(d.getMonth() - 1)
  return ymd(d)
}

function macAddress() {
  const parts = []
  for (let i = 0; i < 6; i++) {
    parts.push(int(0, 255).toString(16).padStart(2, '0').toUpperCase())
  }
  return parts.join(':')
}

// --- source data -----------------------------------------------------------
const PEOPLE = [
  ['Marcus', 'Bennett'], ['Shanice', 'Campbell'], ['Devon', 'Grant'],
  ['Kemar', 'Ricketts'], ['Alicia', 'Thompson'], ['Andre', 'Blake'],
  ['Latoya', 'Powell'], ['Rohan', 'Chin'], ['Simone', 'Dixon'],
  ['Damion', 'Walters'], ['Kerry-Ann', 'Foster'], ['Omar', 'Sinclair'],
  ['Tanya', 'McKenzie'], ['Everton', 'Reid'], ['Nadine', 'Brown'],
]

const PARISHES = [
  'Kingston 6', 'Half Way Tree, St. Andrew', 'Montego Bay, St. James',
  'Ocho Rios, St. Ann', 'Portmore, St. Catherine', 'Mandeville, Manchester',
  'Spanish Town, St. Catherine', 'Negril, Westmoreland',
]

const AGENTS = ['Haydn Samuels', 'Michelle Grant', 'Peter Clarke']

const money = (n) => 'J$' + Number(n).toLocaleString('en-US')

async function main() {
  const force = process.argv.includes('--force')
  const existing = await count('companies')

  if (existing > 0 && !force) {
    console.log('companies already has ' + existing + ' row(s) - nothing to do.')
    console.log('Use --force to wipe and reseed.')
    return
  }

  if (force) {
    console.log('--force: clearing existing rows...')
    const order = [
      'log', 'notifications_queue', 'checkoff', 'support_tickets', 'payments',
      'subscriptions', 'customer_additional_services', 'customers',
      // customer_groups is dropped by 0007; wipe() skips a missing table so
      // this list works either side of that migration.
      'customer_groups', 'misc_categories', 'service_plans', 'additional_services',
      'network_infrastructure', 'settings', 'users', 'companies',
    ]
    for (const t of order) await wipe(t)
  }

  // 1. company
  //    Deliberately does NOT set ddns_hostname or nas_secret. Both columns
  //    exist on `companies` but nothing reads them — the app's copies live on
  //    `settings` (ddns_hostname, radius_secret). Seeding the companies copy
  //    put the value somewhere the application never looks.
  const companies = await insert('companies', [{
    name: 'Demo ISP Jamaica',
    email: 'billing@demoisp.jm',
    phone: '+1-876-555-0100',
    address: '14 Constant Spring Road, Kingston 10, Jamaica',
    plan: 'professional',
    status: 'active',
  }])
  const cid = companies[0].id
  console.log('company #' + cid + ' Demo ISP Jamaica')

  // 2. settings
  const hasExpiryMode = await (async () => {
    const r = await fetch(BASE + '/rest/v1/settings?select=default_expiry_mode&limit=1', { headers: H })
    return r.ok
  })()

  await insert('settings', [{
    company_id: cid,
    ...(hasExpiryMode ? { default_expiry_mode: 'from_expiry' } : {}),
    cut_off_date: 5,
    bill_date: 1,
    currency: 'JMD',
    sms_enabled: true,
    email_enabled: true,
    timezone: 'America/Jamaica',
    // The copy the app actually reads and writes. See the note on the
    // companies insert above.
    ddns_hostname: 'demoisp.ddns.net',
  }])

  // 2c. catalogue (migration 0005 seeded these once — the seed owns them now)
  const catalogReady = await hasCatalog()
  let plans = []
  let addons = []
  let miscCats = []

  if (catalogReady) {
    plans = await insert('service_plans', [
      { company_id: cid, name: 'Basic', speed_down_mbps: 10, speed_up_mbps: 5, monthly_price: 2000, description: 'Basic home internet' },
      { company_id: cid, name: 'Standard', speed_down_mbps: 25, speed_up_mbps: 10, monthly_price: 3500, description: 'Standard home internet' },
      { company_id: cid, name: 'Premium', speed_down_mbps: 50, speed_up_mbps: 20, monthly_price: 5000, description: 'Premium home internet' },
      { company_id: cid, name: 'Business Pro', speed_down_mbps: 100, speed_up_mbps: 50, monthly_price: 8000, description: 'Business grade internet' },
    ])
    addons = await insert('additional_services', [
      { company_id: cid, name: 'TV Package', monthly_price: 1500, description: 'Cable TV package' },
      { company_id: cid, name: 'Telephone', monthly_price: 800, description: 'VoIP telephone service' },
      { company_id: cid, name: 'Static IP', monthly_price: 500, description: 'Dedicated static IP address' },
      { company_id: cid, name: 'Enhanced Support', monthly_price: 1000, description: 'Priority technical support' },
    ])
    miscCats = await insert('misc_categories', [
      { company_id: cid, name: 'School' },
      { company_id: cid, name: 'Government' },
      { company_id: cid, name: 'Hotel' },
      { company_id: cid, name: 'Church' },
    ])
    console.log(plans.length + ' service plans, ' + addons.length + ' add-ons, ' + miscCats.length + ' misc categories')
  } else {
    console.log('SKIPPED catalogue - migration 0005 not applied')
  }

  const planByName = (n) => plans.find((p) => p.name === n) ?? null
  const addonByName = (n) => addons.find((a) => a.name === n) ?? null
  const miscByName = (n) => miscCats.find((m) => m.name === n) ?? null


  // 4. staff — one account per role, so every permission path is testable.
  //    Roles must match lib/permissions.ts exactly: toRole() fails closed to
  //    'technician' for any value it does not recognise.
  const staff = await insert('users', TEAM.map((m, i) => ({
    company_id: cid,
    first_name: m.first,
    last_name: m.last,
    email: m.email,
    phone: '+1-876-555-' + String(101 + i).padStart(4, '0'),
    role: m.role,
    // Migration 0002 added this column and lib/session.ts gates /superadmin on
    // it, not on the role string.
    is_super_admin: m.role === 'super_admin',
  })))

  const byRole = {}
  for (const u of staff) {
    const member = TEAM.find((m) => m.email === u.email)
    byRole[member.role] = u
    console.log('user #' + u.id + ' ' + u.email + ' (' + member.role + ')')
  }
  const admin = byRole.company_admin

  // 5. customers.
  //
  // There is no `status` column any more — a customer's status is derived from
  // the network registry alone (see lib/status.ts), so it cannot be seeded.
  // `expiryIn` only sets last_bill_date, which drives BILLING dates.
  const plan = [
    { expiryIn: -6 }, { expiryIn: -1 }, { expiryIn: 0 }, { expiryIn: 1 },
    { expiryIn: 2 }, { expiryIn: 5 }, { expiryIn: 9 }, { expiryIn: 12 },
    { expiryIn: 15 }, { expiryIn: 18 }, { expiryIn: 21 }, { expiryIn: 24 },
    { expiryIn: 27 }, { expiryIn: 29 }, { expiryIn: -3 },
  ]

  const customerRows = plan.map((p, i) => {
    const first = PEOPLE[i][0]
    const last = PEOPLE[i][1]
    // The legacy `services` table is gone; service_plans is the source of
    // truth for pricing, so the rate is taken straight from the chosen plan.
    const chosen = plans.length ? plans[int(0, plans.length - 1)] : null
    const rate = chosen ? Number(chosen.monthly_price) : 3000
    const emailLocal = first.toLowerCase().replace(/[^a-z]/g, '')
    return {
      company_id: cid,
      first_name: first,
      last_name: last,
      email: emailLocal + '.' + last.toLowerCase() + '@example.com',
      phone: '+1-876-555-' + String(200 + i).padStart(4, '0'),
      address: pick(PARISHES),
      gps: (17.9 + rnd() * 0.4).toFixed(5) + ',' + (-77.0 - rnd() * 0.9).toFixed(5),
      mac_address: macAddress(),
      monthly_rate: rate,
      // Arrears follow the billing date, not a status column: anyone whose
      // billing period has already lapsed owes for it.
      balance: p.expiryIn < 0 ? rate : 0,
      cut_off_date: 5,
      bill_due_date: 1,
      last_bill_date: billDateForExpiryIn(p.expiryIn),
      // spread signups over ~6 months so the billed line ramps up
      date_added: ymd(daysFromNow(-(175 - i * 11))),
      ...(catalogReady
        ? {
            service_plan_id: chosen?.id ?? null,
            connection_type: i % 3 === 0 ? 'wired' : 'wireless',
            customer_category: i % 4 === 0 ? 'business' : 'residential',
            // Two customers get a misc classification.
            misc_category_id:
              i === 2 ? miscByName('School')?.id ?? null
              : i === 8 ? miscByName('Hotel')?.id ?? null
              : null,
            notes: i === 2 ? 'Campus link — escalate outages during term time.' : null,
          }
        : {}),
    }
  })

  const customers = await insert('customers', customerRows)
  console.log(customers.length + ' customers')

  // 5b. One PPPoE and one hotspot customer.
  //     The catalogue fields arrive with migration 0005; the people are
  //     inserted either way so search and lists still demo, and the extra
  //     fields are attached only once the columns exist.

  const typed = [
    {
      base: {
        company_id: cid,
        first_name: 'Robert',
        last_name: 'Fletcher',
        email: 'robert.fletcher@example.com',
        phone: '+1-876-555-0301',
        address: 'New Kingston, St. Andrew',
        gps: '18.00845,-76.78320',
        // Only nullable once 0003 has run; before that give PPPoE a MAC so the
        // NOT NULL constraint is satisfied.
        mac_address: null,
        monthly_rate: Number(planByName('Business Pro')?.monthly_price ?? 8000),
        balance: 0,
        cut_off_date: 5,
        bill_due_date: 1,
        last_bill_date: billDateForExpiryIn(16),
        date_added: ymd(daysFromNow(-40)),
      },
      extra: {
        customer_type: 'pppoe',
        pppoe_username: 'rfletcher',
        pppoe_password: 'ppp123',
        ...(catalogReady
          ? {
              service_plan_id: planByName('Business Pro')?.id ?? null,
              connection_type: 'wired',
              customer_category: 'business',
              notes: 'Fibre drop to the office suite.',
            }
          : {}),
      },
    },
    {
      base: {
        company_id: cid,
        first_name: 'Sandra',
        last_name: 'Mills',
        email: 'sandra.mills@example.com',
        phone: '+1-876-555-0302',
        address: 'Montego Bay, St. James',
        gps: '18.47121,-77.91883',
        mac_address: 'BB:CC:DD:EE:FF:01',
        monthly_rate: Number(planByName('Basic')?.monthly_price ?? 2000),
        balance: 0,
        cut_off_date: 5,
        bill_due_date: 1,
        last_bill_date: billDateForExpiryIn(11),
        date_added: ymd(daysFromNow(-25)),
      },
      extra: {
        customer_type: 'hotspot',
        pppoe_username: 'smills',
        pppoe_password: 'hot123',
        ...(catalogReady
          ? {
              service_plan_id: planByName('Basic')?.id ?? null,
              connection_type: 'wireless',
              customer_category: 'residential',
            }
          : {}),
      },
    },
  ]

  const extra = await insert(
    'customers',
    typed.map((t) => (catalogReady ? { ...t.base, ...t.extra } : t.base))
  )
  customers.push(...extra)
  console.log(
    extra.length + ' typed customers (pppoe + hotspot)' +
    (catalogReady ? '' : ' - WITHOUT catalogue fields')
  )

  // 5c. additional services per customer
  if (catalogReady) {
    const byName = (first, last) =>
      customers.find((c) => c.first_name === first && c.last_name === last)

    const links = []
    const add = (customer, serviceName) => {
      const svc = addonByName(serviceName)
      if (customer && svc) {
        links.push({
          customer_id: customer.id,
          company_id: cid,
          additional_service_id: svc.id,
        })
      }
    }

    add(byName('Robert', 'Fletcher'), 'TV Package')
    add(byName('Robert', 'Fletcher'), 'Static IP')
    add(byName('Marcus', 'Bennett'), 'Telephone')
    add(byName('Alicia', 'Thompson'), 'Telephone')
    add(byName('Damion', 'Walters'), 'Telephone')

    if (links.length) {
      try {
        await insert('customer_additional_services', links)
        console.log(links.length + ' customer add-on links')
      } catch (err) {
        // 23503 = foreign_key_violation. The body embeds JSON with escaped
        // quotes, so match on the code alone rather than the message text.
        if (/23503/.test(err.message)) {
          console.log('SKIPPED add-on links - broken foreign key.')
          console.log('  customer_additional_services.company_id references customers(id),')
          console.log('  not companies(id). Run migration 0006_fix_addon_fk.sql.')
        } else {
          throw err
        }
      }
    }
  }

  // 6. payments - 30 spread over the last 3 months
  const payments = []
  for (let i = 0; i < 30; i++) {
    const c = customers[int(0, customers.length - 1)]
    const months = int(1, 2)
    payments.push({
      company_id: cid,
      customer_id: c.id,
      amount: Number(c.monthly_rate) * months,
      months_paid: months,
      payment_type: pick(['cash', 'card', 'online']),
      payment_date: iso(daysFromNow(-int(0, 89))),
      agent: pick(AGENTS),
    })
  }
  // A few of today's takings are attributed to the cashier account so the
  // cashier dashboard ("my collections today") has something to show.
  const cashierName = TEAM.find((m) => m.role === 'cashier')
  const cashierAgent = cashierName.first + ' ' + cashierName.last
  for (let i = 0; i < 4; i++) {
    const c = customers[int(0, customers.length - 1)]
    payments.push({
      company_id: cid,
      customer_id: c.id,
      amount: Number(c.monthly_rate),
      months_paid: 1,
      payment_type: pick(['cash', 'card', 'online']),
      payment_date: iso(hoursAgo(1 + i * 2)),
      agent: cashierAgent,
    })
  }

  // 6b. Checkoff test data — 15 payments across three collecting agents, mixed
  //     methods, with the older ones already checked off so each agent still
  //     has an outstanding balance to show on their collections panel.
  const hasCheckoff = await (async () => {
    const r = await fetch(
      BASE + '/rest/v1/payments?select=checked_off,payment_method,user_id&limit=1',
      { headers: H }
    )
    return r.ok
  })()

  if (hasCheckoff) {
    // insert() pads every row to the union of all keys, and an explicit NULL
    // beats the column DEFAULT — so rows built before this point would violate
    // the NOT NULL on checked_off. Give them concrete values first.
    //
    // The 30 historical payments are treated as already reconciled; the four
    // recent cashier takings stay outstanding so the collections panel has
    // something in it the moment you log in.
    const cashierUser = byRole.cashier
    for (const p of payments) {
      p.payment_method = p.payment_type
      const recent = new Date(p.payment_date).getTime() > Date.now() - 2 * 86400000
      p.checked_off = !recent
      p.checked_off_at = recent ? null : iso(daysFromNow(-int(1, 9)))
      p.checked_off_by = recent ? null : admin.id
      p.user_id = p.agent === cashierUser.first_name + ' ' + cashierUser.last_name
        ? cashierUser.id
        : null
    }

    const collectors = [byRole.manager, byRole.csr, byRole.cashier]
    const methods = [
      'cash', 'card', 'bank_transfer', 'cheque', 'paypal',
      'cashapp', 'zelle', 'wire_transfer', 'online', 'other',
    ]

    for (let i = 0; i < 15; i++) {
      const u = collectors[i % collectors.length]
      const c = customers[int(0, customers.length - 1)]
      const months = int(1, 2)
      const method = methods[i % methods.length]

      // The first third are historical and already reconciled; the rest are
      // outstanding, so every agent has something to be checked off.
      const settled = i < 5

      payments.push({
        company_id: cid,
        customer_id: c.id,
        amount: Number(c.monthly_rate) * months,
        months_paid: months,
        payment_type: method === 'cash' ? 'cash' : method === 'card' || method === 'cheque' ? 'card' : 'online',
        payment_method: method,
        payment_date: iso(settled ? daysFromNow(-int(10, 25)) : hoursAgo(int(1, 40))),
        agent: u.first_name + ' ' + u.last_name,
        user_id: u.id,
        checked_off: settled,
        checked_off_at: settled ? iso(daysFromNow(-int(1, 9))) : null,
        checked_off_by: settled ? admin.id : null,
        notes: method === 'other' ? 'Paid via in-store voucher' : null,
      })
    }
  }

  payments.sort((a, b) => new Date(a.payment_date) - new Date(b.payment_date))
  await insert('payments', payments)
  console.log(
    payments.length + ' payments' +
    (hasCheckoff ? ' (15 with checkoff data across 3 agents)' : ' (no checkoff columns — run migration 0010)')
  )

  // 7. support tickets
  await insert('support_tickets', [
    { company_id: cid, customer_id: customers[3].id, assigned_to: byRole.technician.id, title: 'No internet since morning storm', description: 'Customer reports total outage after heavy rain overnight.', status: 'open', priority: 'high', created_at: iso(hoursAgo(4)) },
    { company_id: cid, customer_id: customers[7].id, assigned_to: byRole.technician.id, title: 'Intermittent drops in the evenings', description: 'Connection drops repeatedly between 7pm and 10pm.', status: 'in_progress', priority: 'medium', created_at: iso(hoursAgo(26)) },
    { company_id: cid, customer_id: customers[1].id, assigned_to: byRole.csr.id, title: 'Requesting upgrade to 50Mbps', description: 'Wants to move from Home Standard to Home Premium.', status: 'open', priority: 'low', created_at: iso(hoursAgo(50)) },
    { company_id: cid, customer_id: customers[11].id, assigned_to: byRole.technician.id, title: 'Router keeps rebooting', description: 'Replaced power adapter, issue persists.', status: 'in_progress', priority: 'high', created_at: iso(hoursAgo(74)) },
    { company_id: cid, customer_id: customers[5].id, assigned_to: byRole.csr.id, title: 'Billing query on last invoice', description: 'Customer disputes a double charge in the last cycle.', status: 'resolved', priority: 'medium', created_at: iso(hoursAgo(120)), resolved_at: iso(hoursAgo(96)) },
  ])
  console.log('5 support tickets')

  // 8. activity log
  const logSpec = [
    { type: 'payment', c: 0, h: 1, text: (n) => n + ' made a payment of ' + money(3000) },
    { type: 'connect', c: 3, h: 3, text: (n) => n + ' was reconnected after payment' },
    { type: 'ticket', c: 7, h: 5, text: (n) => 'New support ticket opened by ' + n },
    { type: 'disconnect', c: 14, h: 8, text: (n) => n + ' was disconnected for non-payment' },
    { type: 'payment', c: 9, h: 12, text: (n) => n + ' made a payment of ' + money(4500) },
    { type: 'connect', c: 12, h: 26, text: (n) => n + ' was provisioned on Home Premium' },
    { type: 'payment', c: 2, h: 30, text: (n) => n + ' made a payment of ' + money(2000) },
    { type: 'ticket', c: 11, h: 36, text: (n) => 'Ticket escalated to high priority for ' + n },
    { type: 'disconnect', c: 1, h: 44, text: (n) => n + ' reached cut-off date and was suspended' },
    { type: 'payment', c: 6, h: 52, text: (n) => n + ' made a payment of ' + money(5000) },
  ]
  await insert('log', logSpec.map((r) => {
    const c = customers[r.c]
    const name = c.first_name + ' ' + c.last_name
    return {
      company_id: cid,
      user_id: admin.id,
      customer_id: c.id,
      type: r.type,
      details: r.text(name),
      created_at: iso(hoursAgo(r.h)),
    }
  }))
  console.log('10 log entries')

  // 9. notifications - 'pending' means unread, 'sent' means read
  const name = (c) => c.first_name + ' ' + c.last_name
  await insert('notifications_queue', [
    { company_id: cid, customer_id: customers[1].id, type: 'expiry', channel: 'sms', recipient: customers[1].phone, message: name(customers[1]) + ' has expired and is past the cut-off date', status: 'pending', created_at: iso(hoursAgo(1)) },
    { company_id: cid, customer_id: customers[14].id, type: 'payment', channel: 'email', recipient: customers[14].email, message: 'Card payment failed for ' + name(customers[14]), status: 'pending', created_at: iso(hoursAgo(2)) },
    { company_id: cid, customer_id: customers[3].id, type: 'ticket', channel: 'email', recipient: customers[3].email, message: 'New high priority ticket from ' + name(customers[3]), status: 'sent', sent_at: iso(hoursAgo(20)), created_at: iso(hoursAgo(20)) },
    { company_id: cid, customer_id: customers[9].id, type: 'customer', channel: 'email', recipient: customers[9].email, message: 'New customer ' + name(customers[9]) + ' was onboarded', status: 'sent', sent_at: iso(hoursAgo(44)), created_at: iso(hoursAgo(44)) },
    { company_id: cid, customer_id: customers[4].id, type: 'expiry', channel: 'sms', recipient: customers[4].phone, message: name(customers[4]) + ' expires in 2 days', status: 'sent', sent_at: iso(hoursAgo(70)), created_at: iso(hoursAgo(70)) },
  ])
  console.log('5 notifications (2 unread)')

  // 10. Supabase auth accounts for the staff who need to sign in.
  //     auth.users and the users table are separate stores joined by email;
  //     both halves must exist before anyone can sign in and get a profile.
  console.log('')
  for (const m of TEAM) {
    if (!m.auth) continue
    const outcome = await ensureAuthUser(m.email, STAFF_PASSWORD)
    console.log('auth ' + m.email + ' -> ' + outcome)
  }

  console.log('\nSeed complete.')
}

main().catch((err) => {
  console.error('SEED FAILED:', err.message)
  process.exit(1)
})
