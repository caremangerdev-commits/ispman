#!/usr/bin/env python3
"""
Gives the month to every customer who paid for one and did not get it.

THE FAULT. A service payment of at least one monthly charge that recorded
months_paid = 0. The money settled the balance and bought no access, because
the billing period it was attributed to had already been granted by an earlier
payment. 81 of these since 6 September, across every tenant.

WHAT THIS DOES, per customer, and why it is safe to run twice:

  * the target is built from the expiry the customer HELD AT THE TIME of the
    first unpaid-for payment, plus one month for each such payment. That is
    what the money bought and did not deliver.
  * the target is then compared with what the network holds NOW. If the
    customer has since been made whole - a later payment that did extend them,
    or somebody reconnecting them by hand - the current expiry already reaches
    the target and they are SKIPPED. That is what makes this idempotent, and
    it is why nobody gets a second month for the same money.
  * only a customer whose current expiry falls SHORT of the target is moved,
    and only forward.

Every write is a compare-and-set against the exact value just read, so a
payment taken while this runs cannot be clobbered. Each change writes a log row
naming the payments it is making good.

    make-good.py              report only, writes nothing
    make-good.py --apply      do it
"""

import collections
import json
import os
import re
import subprocess
import sys
import urllib.request

APPLY = "--apply" in sys.argv
ENV = "/var/www/ispman/.env.local"
SINCE = "2026-09-06"
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
DAYS_IN = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]


def env(key):
    with open(ENV) as fh:
        for line in fh:
            if line.startswith(key + "="):
                return line.split("=", 1)[1].strip().strip("'\"")
    return ""


URL, KEY = env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY")
RH, RU = env("RADIUS_DB_HOST"), env("RADIUS_DB_USER")
RP, RD = env("RADIUS_DB_PASSWORD"), env("RADIUS_DB_NAME")


def rest(path):
    req = urllib.request.Request(
        URL + "/rest/v1/" + path,
        headers={"apikey": KEY, "Authorization": "Bearer " + KEY})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode())


def post_log(company_id, customer_id, details):
    body = json.dumps({"company_id": company_id, "customer_id": customer_id,
                       "type": "network_expiry_corrected", "details": details}).encode()
    req = urllib.request.Request(
        URL + "/rest/v1/log", data=body, method="POST",
        headers={"apikey": KEY, "Authorization": "Bearer " + KEY,
                 "Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=60).read()


def sql(query):
    """MySQL, via the client, with the password passed through the environment."""
    out = subprocess.run(
        ["mysql", "-h", RH, "-u", RU, "-D", RD, "-N", "-B", "-e", query],
        env=dict(os.environ, MYSQL_PWD=RP),
        capture_output=True, timeout=120)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.decode(errors="replace")[:300])
    return out.stdout.decode(errors="replace")


# --- the Expiration string, as FreeRADIUS and the app both spell it ---------

def parse_exp(value):
    m = re.match(r"\s*(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{1,2}):(\d{2})", value or "")
    if not m:
        return None
    day, mon, year, hh, mm = m.groups()
    if mon.title() not in MONTHS:
        return None
    return (int(day), MONTHS.index(mon.title()) + 1, int(year), int(hh), int(mm))


def fmt_exp(parts):
    day, mon, year, hh, mm = parts
    return "%02d %s %d %02d:%02d" % (day, MONTHS[mon - 1], year, hh, mm)


def add_months(parts, n):
    day, mon, year, hh, mm = parts
    total = (year * 12 + (mon - 1)) + n
    year, mon = total // 12, total % 12 + 1
    last = DAYS_IN[mon - 1] + (1 if mon == 2 and (year % 4 == 0 and (year % 100 or year % 400 == 0)) else 0)
    return (min(day, last), mon, year, hh, mm)


def key(mac):
    return re.sub(r"[^0-9A-F]", "", (mac or "").upper())


def ymd(parts):
    return "%04d-%02d-%02d" % (parts[2], parts[1], parts[0])


# --- gather ----------------------------------------------------------------

print("reading payments that bought no service since " + SINCE + " ...")
pays = rest(
    "payments?select=id,company_id,customer_id,amount,paid_on,months_paid,"
    "access_granted_until,service_active_until,"
    "customers(first_name,last_name,mac_address,customer_type,pppoe_username,monthly_rate),"
    "companies(name)"
    "&payment_kind=eq.service&months_paid=eq.0&paid_on=gte." + SINCE +
    "&order=paid_on.asc&limit=1000")

affected = collections.defaultdict(list)
skipped_small, no_anchor = [], []
for p in pays:
    c = p.get("customers") or {}
    rate = float(c.get("monthly_rate") or 0)
    amt = float(p.get("amount") or 0)
    if rate <= 0 or amt < rate:
        skipped_small.append(p["id"])
        continue
    anchor = p.get("access_granted_until") or p.get("service_active_until")
    if not anchor:
        no_anchor.append((p["id"], p.get("customer_id"),
                          ((c.get("first_name") or "") + " " + (c.get("last_name") or "")).strip()))
        continue
    affected[p["customer_id"]].append(p)

print("  %d payments of a full month or more that bought nothing" % sum(len(v) for v in affected.values()))
print("  %d part payments ignored (less than a month's charge)" % len(skipped_small))
print("  %d could not be anchored - no expiry recorded on the row; listed at the end" % len(no_anchor))

# DELIBERATELY CUT OFF SINCE THE PAYMENT - leave them alone.
#
# LAYON VALENTINE GALLIMORE (#1390) is why this exists. His payment did buy
# nothing, so he looked like one to fix - but Ezmze disconnected him on 4 Nov,
# pulling his expiry from 15 Nov back to 4 Nov, and the engine then pro-rated
# his November charge from J$5,000 to J$700 for the four days he had. Moving
# him forward would undo a disconnection somebody chose to make AND hand him
# service he has already been credited for not having.
#
# A disconnection is a decision. This script does not overrule decisions; it
# only delivers months that were paid for and never handed over.
print("reading disconnections ...")
cut_off = {}
for row in rest("log?select=customer_id,created_at,type,details"
                "&type=in.(network_disconnect,service_ended)"
                "&created_at=gte." + SINCE + "&limit=5000"):
    cid = row.get("customer_id")
    if cid is None:
        continue
    at = (row.get("created_at") or "")[:10]
    if at > cut_off.get(cid, ""):
        cut_off[cid] = at

print("reading what the network holds now ...")
rad = collections.defaultdict(list)
for line in sql("SELECT username, value FROM radcheck WHERE attribute='Expiration';").splitlines():
    parts = line.split("\t")
    if len(parts) >= 2:
        rad[key(parts[0])].append((parts[0], parts[1]))

# --- decide ----------------------------------------------------------------

plan, already, unclear, disconnected = [], [], [], []
for cid, rows in sorted(affected.items()):
    rows.sort(key=lambda r: (r.get("paid_on") or "", r["id"]))
    first = rows[0]
    last_paid = rows[-1].get("paid_on") or ""
    c = first.get("customers") or {}
    name = ((c.get("first_name") or "") + " " + (c.get("last_name") or "")).strip() or ("#%s" % cid)
    co = (first.get("companies") or {}).get("name") or ""
    ident = (c.get("pppoe_username") if c.get("customer_type") == "pppoe"
             else c.get("mac_address"))

    # Cut off after they paid: somebody decided that, so it stands.
    if cid in cut_off and cut_off[cid] >= last_paid:
        disconnected.append((cid, name, co, len(rows), cut_off[cid]))
        continue

    held = rad.get(key(ident), [])
    if len(held) != 1:
        unclear.append((cid, name, co, len(rows),
                        "no network row" if not held else "%d network rows" % len(held)))
        continue
    username, current_raw = held[0]
    current = parse_exp(current_raw)

    # The anchor is the expiry the customer held when the first unpaid-for
    # payment was taken; the clock comes from the row the network holds, so
    # the written value keeps the same time of day as everything else.
    anchor_ymd = (first.get("access_granted_until") or first.get("service_active_until"))[:10]
    try:
        ay, am, ad = (int(x) for x in anchor_ymd.split("-"))
    except ValueError:
        unclear.append((cid, name, co, len(rows), "unreadable anchor " + str(anchor_ymd)))
        continue
    if current is None:
        unclear.append((cid, name, co, len(rows), "unreadable expiry " + current_raw))
        continue

    anchor = (ad, am, ay, current[3], current[4])
    target = add_months(anchor, len(rows))

    if ymd(current) >= ymd(target):
        already.append((cid, name, co, len(rows), current_raw, fmt_exp(target)))
    else:
        plan.append({
            "cid": cid, "name": name, "co": co,
            "company_id": first["company_id"],
            "username": username,
            "current": current_raw, "target": fmt_exp(target),
            "months": len(rows),
            "pay_ids": [r["id"] for r in rows],
            "amount": sum(float(r.get("amount") or 0) for r in rows),
        })

print()
print("=" * 74)
print("ALREADY MADE WHOLE - skipping %d customers" % len(already))
for cid, name, co, n, cur, tgt in already[:40]:
    print("  #%-6s %-24s %-20s holds %-20s (needed %s)" % (cid, name[:24], co[:20], cur, tgt))

print()
print("NEEDS THE MONTH - %d customers" % len(plan))
by_co = collections.Counter(p["co"] for p in plan)
for co, n in by_co.most_common():
    print("  %-38s %d" % (co, n))
print()
for p in plan:
    print("  #%-6s %-24s %-20s %-20s -> %-20s  %d mo  J$%.0f  pay %s"
          % (p["cid"], p["name"][:24], p["co"][:20], p["current"], p["target"],
             p["months"], p["amount"], ",".join(str(i) for i in p["pay_ids"])))

if disconnected:
    print()
    print("CUT OFF SINCE THEY PAID - skipping %d customers" % len(disconnected))
    for cid, name, co, n, when in disconnected:
        print("  #%-6s %-24s %-20s cut off %s" % (cid, name[:24], co[:20], when))

if unclear:
    print()
    print("NEEDS A HUMAN - %d customers" % len(unclear))
    for cid, name, co, n, why in unclear:
        print("  #%-6s %-24s %-20s %s" % (cid, name[:24], co[:20], why))

if no_anchor:
    print()
    print("NO EXPIRY RECORDED ON THE PAYMENT - %d payments, left alone" % len(no_anchor))
    for pid, cid, name in no_anchor[:20]:
        print("  pay %-7s #%-6s %s" % (pid, cid, name))

# --- apply -----------------------------------------------------------------

if not APPLY:
    print()
    print("Report only. Nothing was written. Re-run with --apply to make the changes.")
    raise SystemExit

print()
print("=" * 74)
print("APPLYING")
done = failed = 0
for p in plan:
    u = p["username"].replace("\\", "\\\\").replace("'", "\\'")
    cur = p["current"].replace("'", "\\'")
    tgt = p["target"].replace("'", "\\'")
    try:
        sql("UPDATE radcheck SET value='%s' WHERE username='%s' AND attribute='Expiration' AND value='%s';"
            % (tgt, u, cur))
        back = sql("SELECT value FROM radcheck WHERE username='%s' AND attribute='Expiration';" % u).strip()
        if back != p["target"]:
            print("  #%-6s %-22s NOT CHANGED - now reads %r, expected %r"
                  % (p["cid"], p["name"][:22], back, p["target"]))
            failed += 1
            continue
        post_log(p["company_id"], p["cid"],
                 "Expiry corrected for %s. Expiry %s -> %s. By claude (on the owner's instruction) "
                 "| reason=Payment%s %s of J$%.2f recorded months_paid=0 and bought no access: the "
                 "period had already been granted by an earlier payment. A full month was paid and a "
                 "full month is owed. Expiry moved forward %d month(s) from the date held when that "
                 "payment was taken. The rule is fixed in code so it cannot recur."
                 % (p["username"].strip(), p["current"], p["target"],
                    "s" if len(p["pay_ids"]) > 1 else "",
                    ",".join("#%s" % i for i in p["pay_ids"]), p["amount"], p["months"]))
        print("  #%-6s %-22s %s -> %s" % (p["cid"], p["name"][:22], p["current"], p["target"]))
        done += 1
    except Exception as err:
        print("  #%-6s %-22s FAILED: %s" % (p["cid"], p["name"][:22], err))
        failed += 1

print()
print("changed %d, failed %d, skipped %d already whole" % (done, failed, len(already)))
