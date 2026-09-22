// READ-ONLY, TEMPORARY. What radcheck holds: attribute census, the two demo
// PPPoE/hotspot identities, any password attribute anywhere, and what radreply
// and radusergroup hold, since FreeRADIUS may be checking passwords there.
import { readFileSync } from 'node:fs'
import process from 'node:process'
import mysql from 'mysql2/promise'
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}
const need = (n) => { const v = process.env[n]; if (!v) { console.error('Missing ' + n); process.exit(1) } return v }
const my = await mysql.createConnection({ host: need('RADIUS_DB_HOST'), user: need('RADIUS_DB_USER'), password: need('RADIUS_DB_PASSWORD'), port: Number(process.env.RADIUS_DB_PORT ?? 3306), dateStrings: true, connectTimeout: 20000 })
const DB = need('RADIUS_DB_NAME')
const q = async (sql, params) => (await my.query(sql, params))[0]
const hide = (a, v) => (/password|secret/i.test(a) ? '(hidden, ' + String(v ?? '').length + ' chars)' : v)

console.log('radcheck attribute census:')
console.table(await q('SELECT attribute, op, COUNT(*) n FROM `' + DB + '`.radcheck GROUP BY attribute, op'))
console.log('distinct usernames in radcheck:', (await q('SELECT COUNT(DISTINCT username) n FROM `' + DB + '`.radcheck'))[0].n)
console.log('distinct non-MAC usernames:', (await q("SELECT COUNT(DISTINCT username) n FROM `" + DB + "`.radcheck WHERE username NOT REGEXP '^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$'"))[0].n)
const nonMac = await q("SELECT username, attribute, op, value FROM `" + DB + "`.radcheck WHERE username NOT REGEXP '^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$' ORDER BY username LIMIT 40")
console.log('non-MAC rows (up to 40):')
for (const r of nonMac) console.log('  ' + JSON.stringify(r.username) + ' ' + r.attribute + ' ' + r.op + ' ' + hide(r.attribute, r.value))

console.log('\ndemo identities rfletcher / smills / BB:CC:DD:EE:FF:01:')
for (const r of await q('SELECT username, attribute, op, value FROM `' + DB + '`.radcheck WHERE username IN (?)', [['rfletcher', 'smills', 'BB:CC:DD:EE:FF:01']])) {
  console.log('  ' + r.username + ' ' + r.attribute + ' ' + r.op + ' ' + hide(r.attribute, r.value))
}
console.log('\nany password attribute anywhere in radcheck:')
console.table(await q("SELECT attribute, COUNT(*) n FROM `" + DB + "`.radcheck WHERE attribute LIKE '%Password%' GROUP BY attribute"))

for (const t of ['radreply', 'radusergroup', 'radgroupcheck', 'radgroupreply', 'nas']) {
  const exists = (await q('SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = ? AND table_name = ?', [DB, t]))[0].n
  if (!exists) { console.log('\n' + t + ': (no table)'); continue }
  const n = (await q('SELECT COUNT(*) n FROM `' + DB + '`.`' + t + '`'))[0].n
  console.log('\n' + t + ': ' + n + ' rows')
  if (n > 0 && t !== 'nas') console.table(await q('SELECT attribute, op, COUNT(*) n FROM `' + DB + '`.`' + t + '` GROUP BY attribute, op'))
  if (t === 'nas') for (const r of await q('SELECT nasname, shortname, type FROM `' + DB + '`.nas')) console.log('  ' + r.nasname + ' ' + r.shortname + ' ' + r.type)
}
// A sample of what a MAC-auth request looks like in accounting: the username the NAS sends.
const acct = await q('SELECT username, COUNT(*) n FROM `' + DB + '`.radacct GROUP BY username ORDER BY n DESC LIMIT 5')
console.log('\nradacct top usernames (shape of what the NAS sends):')
for (const r of acct) console.log('  ' + JSON.stringify(r.username) + ' x' + r.n)
const acctNonMac = (await q("SELECT COUNT(DISTINCT username) n FROM `" + DB + "`.radacct WHERE username NOT REGEXP '^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$'"))[0].n
console.log('radacct distinct non-MAC usernames:', acctNonMac)
await my.end()
