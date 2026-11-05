#!/usr/bin/env bash
#
# Why is this customer's service where it is?
#
#   why.sh 5768              one customer by id
#   why.sh "ishena campbell" by name, any part of it
#
# Prints, for each match: who they are, what the network actually holds for
# them, every charge raised, every payment with what it bought, and the audit
# trail. Read-only — it writes nothing anywhere.
#
# WHY THIS EXISTS. "The customer paid and nothing happened" is answerable only
# by putting four things side by side: the charge, the payment, what the
# payment was attributed to, and the expiry the network holds. They live in
# three different databases. Assembling that by hand each time invites
# guessing, and guessing about somebody's money is how the wrong thing gets
# fixed.
set -uo pipefail

ARG=${1:-}
[ -z "$ARG" ] && { echo "usage: why.sh <customer-id|name>"; exit 1; }

cd /var/www/ispman || exit 1
val() { grep -m1 "^$1=" .env.local | cut -d= -f2- | tr -d '"'"'"' \r\n'; }
URL=$(val NEXT_PUBLIC_SUPABASE_URL); KEY=$(val SUPABASE_SERVICE_ROLE_KEY)
H1="apikey: $KEY"; H2="Authorization: Bearer $KEY"
RH=$(val RADIUS_DB_HOST); RU=$(val RADIUS_DB_USER)
RP=$(val RADIUS_DB_PASSWORD); RD=$(val RADIUS_DB_NAME)

COLS='id,first_name,last_name,mac_address,customer_type,pppoe_username,monthly_rate,carried_balance,account_credit,bill_date,cut_off_date,date_added,expiry_mode,companies(name)'

# A bare number is an id; anything else is matched across both name columns and
# the whole name, so "ishena campbell" works as well as either half.
if [[ "$ARG" =~ ^[0-9]+$ ]]; then
  curl -s -H "$H1" -H "$H2" "$URL/rest/v1/customers?select=$COLS&id=eq.$ARG" > /tmp/why_c.json
else
  FIRST=${ARG%% *}; LAST=${ARG##* }
  curl -s -H "$H1" -H "$H2" \
    "$URL/rest/v1/customers?select=$COLS&or=(first_name.ilike.*${FIRST}*,last_name.ilike.*${LAST}*)&limit=40" \
    > /tmp/why_c.json
  python3 - "$ARG" <<'PY'
import json, sys, re
want = re.sub(r'\s+', ' ', sys.argv[1]).strip().lower()
rows = json.load(open('/tmp/why_c.json'))
if isinstance(rows, list) and len(rows) > 1:
    # Prefer rows whose full name contains everything asked for.
    parts = want.split(' ')
    tight = [r for r in rows
             if all(p in ((r.get('first_name') or '') + ' ' + (r.get('last_name') or '')).lower()
                    for p in parts)]
    if tight:
        json.dump(tight, open('/tmp/why_c.json', 'w'))
PY
fi

python3 - <<'PY' > /tmp/why_ids.txt
import json
rows = json.load(open('/tmp/why_c.json'))
if not isinstance(rows, list):
    print('ERR ' + json.dumps(rows)); raise SystemExit
if not rows:
    print('NONE'); raise SystemExit
if len(rows) > 6:
    print('MANY ' + str(len(rows)))
    for r in rows[:30]:
        print('  %-6s %-26s %s' % (r['id'],
          ((r.get('first_name') or '') + ' ' + (r.get('last_name') or '')).strip(),
          (r.get('companies') or {}).get('name', '')))
    raise SystemExit
for r in rows:
    print('ID %s' % r['id'])
PY

head -1 /tmp/why_ids.txt | grep -q '^NONE' && { echo "No customer matched \"$ARG\"."; exit 0; }
head -1 /tmp/why_ids.txt | grep -q '^ERR'  && { cat /tmp/why_ids.txt; exit 1; }
head -1 /tmp/why_ids.txt | grep -q '^MANY' && {
  echo "Several matched \"$ARG\" — rerun with one id:"; tail -n +2 /tmp/why_ids.txt; exit 0; }

for ID in $(awk '/^ID /{print $2}' /tmp/why_ids.txt); do
echo "============================================================"
curl -s -H "$H1" -H "$H2" "$URL/rest/v1/customers?select=$COLS&id=eq.$ID" | python3 -c "
import json,sys
r=json.load(sys.stdin)[0]
print('%s %s   (#%s, %s)' % (r['first_name'], r['last_name'], r['id'], (r.get('companies') or {}).get('name')))
print('  identity   %s' % (r.get('pppoe_username') if r.get('customer_type')=='pppoe' else r.get('mac_address')))
print('  rate %s   owes %s   credit %s' % (r.get('monthly_rate'), r.get('carried_balance'), r.get('account_credit')))
print('  bill day %s   cut-off %s   joined %s   expiry rule %s' % (r.get('bill_date'), r.get('cut_off_date'), r.get('date_added'), r.get('expiry_mode')))
open('/tmp/why_mac.txt','w').write((r.get('pppoe_username') if r.get('customer_type')=='pppoe' else r.get('mac_address')) or '')
"

echo
echo "-- what the network holds --"
MAC=$(cat /tmp/why_mac.txt)
if [ -n "$MAC" ] && [ -n "$RU" ]; then
  MYSQL_PWD="$RP" mysql -h "$RH" -u "$RU" -D "$RD" -N -B -e \
    "SELECT attribute, value FROM radcheck WHERE username='$MAC';" 2>&1 | sed 's/^/  /'
else
  echo "  not on the network (no identity)"
fi

echo
echo "-- charges raised --"
curl -s -H "$H1" -H "$H2" "$URL/rest/v1/bill_charges?select=period_start,period_end,amount,charged_on,carried_balance_before,carried_balance_after&customer_id=eq.$ID&order=period_start.desc&limit=10" | python3 -c "
import json,sys
rows=json.load(sys.stdin)
if not isinstance(rows,list): print('  ',rows); raise SystemExit
if not rows: print('  (none — nothing has ever been billed to them by the engine)')
for r in rows: print('  %s..%s  %-9s raised %s   owed %s -> %s' % (r['period_start'],r['period_end'],r['amount'],r['charged_on'],r.get('carried_balance_before'),r.get('carried_balance_after')))
"

echo
echo "-- payments, and what each one bought --"
curl -s -H "$H1" -H "$H2" "$URL/rest/v1/payments?select=id,amount,amount_due,months_paid,paid_on,payment_kind,agent,access_decision,access_granted_until,service_active_until,carried_balance_before,carried_balance_after,credit_applied,billing_period_start,billing_period_end&customer_id=eq.$ID&order=id.desc&limit=10" | python3 -c "
import json,sys
rows=json.load(sys.stdin)
if not isinstance(rows,list): print('  ',rows); raise SystemExit
if not rows: print('  (none)')
for r in rows:
    m=r.get('months_paid')
    flag='  <-- bought no service' if m in (0,None) and r.get('payment_kind')!='other' else ''
    print('  %-7s %s  %-7s paid %-9s asked %-9s months %s%s' % (
      r['id'], r.get('paid_on'), r.get('payment_kind'), r.get('amount'), r.get('amount_due'), m, flag))
    print('          access %s -> %s   owed %s -> %s   choice %r   for period %s..%s' % (
      r.get('service_active_until'), r.get('access_granted_until'),
      r.get('carried_balance_before'), r.get('carried_balance_after'),
      r.get('access_decision'), r.get('billing_period_start'), r.get('billing_period_end')))
"

echo
echo "-- audit trail --"
curl -s -H "$H1" -H "$H2" "$URL/rest/v1/log?select=created_at,type,details&customer_id=eq.$ID&order=id.desc&limit=14" | python3 -c "
import json,sys
rows=json.load(sys.stdin)
if not isinstance(rows,list): print('  ',rows); raise SystemExit
if not rows: print('  (none)')
for r in rows:
    print('  %s  %s' % (r['created_at'][:19].replace('T',' '), r['type']))
    print('     %s' % (r.get('details') or '')[:220])
"
echo
done
rm -f /tmp/why_c.json /tmp/why_ids.txt /tmp/why_mac.txt
