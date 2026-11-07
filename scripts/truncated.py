#!/usr/bin/env python3
"""
A SECOND, SEPARATE FAULT from the one make-good.py repairs.

make-good looks for months_paid = 0 - a payment that bought nothing at all.
This looks for months_paid >= 1 where the month that WAS granted is shorter
than a month, because the company expiry rule snaps the new expiry onto the
company cut-off day instead of running a full month from where the customer's
own cycle sat.

  Yashema Campbell #2026: anchor 15 Oct, paid 17 Oct, got 5 Nov. 21 days.
  Omar watson     #1892: anchor 17 Oct, paid 19 Oct, got 5 Nov. 19 days.

Both were set to expiry_mode 'from_payment', which the payment path reads and
discards (lib/domain.ts#renewal has no callers), so the setting did nothing and
the company rule applied anyway.

The old expiry is not stored on the payment row - only the new one - so it is
read back out of the radius_extend audit lines.

Read-only. PostgREST caps a response at 1000 rows whatever limit is asked for,
so everything here is paged.
"""

import collections
import json
import re
import sys
import urllib.request
from datetime import date

SINCE = "2026-09-06"
ENV = "/var/www/ispman/.env.local"
MON = {m: i + 1 for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])}


def env(key):
    with open(ENV) as fh:
        for line in fh:
            if line.startswith(key + "="):
                return line.split("=", 1)[1].strip().strip("'\"")
    return ""


URL, KEY = env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY")


def pages(path, page=1000):
    """Every row, a page at a time. PostgREST ignores limit above 1000."""
    out, offset = [], 0
    while True:
        req = urllib.request.Request(
            URL + "/rest/v1/" + path + "&limit=%d&offset=%d" % (page, offset),
            headers={"apikey": KEY, "Authorization": "Bearer " + KEY})
        with urllib.request.urlopen(req, timeout=180) as r:
            batch = json.loads(r.read().decode())
        if not isinstance(batch, list):
            raise RuntimeError(str(batch)[:300])
        out.extend(batch)
        if len(batch) < page:
            return out
        offset += page
        if offset > 60000:
            return out


def day(text):
    m = re.match(r"\s*(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})", text or "")
    if not m or m.group(2).title() not in MON:
        return None
    return date(int(m.group(3)), MON[m.group(2).title()], int(m.group(1)))


print("reading extend audit lines ...")
ext = pages("log?select=customer_id,company_id,created_at,details"
            "&type=eq.radius_extend&created_at=gte." + SINCE + "&order=id.asc")
print("  %d" % len(ext))

print("reading service payments ...")
pays = pages("payments?select=id,customer_id,amount,months_paid,paid_on,access_decision,"
             "customers(first_name,last_name,monthly_rate,cut_off_date,expiry_mode),"
             "companies(name)"
             "&payment_kind=eq.service&paid_on=gte." + SINCE + "&order=id.asc")
print("  %d" % len(pays))

by_id = {p["id"]: p for p in pays}

rows = []
for e in ext:
    det = e.get("details") or ""
    pid = re.search(r"payment_id=(\d+)", det)
    old = re.search(r"old_expiry=([^|]+)", det)
    new = re.search(r"new_expiry=([^|]+)", det)
    if not (pid and old and new):
        continue
    p = by_id.get(int(pid.group(1)))
    if not p:
        continue
    o, n = day(old.group(1)), day(new.group(1))
    if not o or not n:
        continue
    c = p.get("customers") or {}
    rate = float(c.get("monthly_rate") or 0)
    amt = float(p.get("amount") or 0)
    months = p.get("months_paid") or 0
    # Full-month money, at least one month granted, and the cashier was not
    # asked to pick a shorter date on purpose.
    if rate <= 0 or amt < rate or months < 1:
        continue
    if p.get("access_decision") == "date_selected":
        continue
    rows.append({
        "cid": p["customer_id"], "pid": p["id"], "company_id": e.get("company_id"),
        "name": ((c.get("first_name") or "") + " " + (c.get("last_name") or "")).strip(),
        "co": ((p.get("companies") or {}).get("name") or "")[:24],
        "paid_on": p.get("paid_on"), "amount": amt, "months": months,
        "old": o, "new": n, "days": (n - o).days,
        "cutoff": c.get("cut_off_date"), "mode": c.get("expiry_mode"),
    })

# One month granted should be about a month. Below 28 days is short however the
# calendar falls; 25 is the floor a 28-day February could justify.
short = [r for r in rows if r["months"] == 1 and r["days"] < 28]
multi = [r for r in rows if r["months"] > 1 and r["days"] < 28 * r["months"]]

print()
print("full-month payments that DID extend access: %d" % len(rows))
print("of those granted one month, short of 28 days: %d" % len(short))
print("of those granted several months, short: %d" % len(multi))

if short:
    lost = sum(30 - r["days"] for r in short)
    print()
    print("  about %d customer-days of paid-for service not delivered" % lost)
    print("  money involved: J$%.0f" % sum(r["amount"] for r in short))
    print()
    for co, n in collections.Counter(r["co"] for r in short).most_common():
        print("  %-26s %d" % (co, n))
    print()
    print("  by days granted:")
    for days, n in sorted(collections.Counter(r["days"] for r in short).items()):
        print("    %2d days  %d" % (days, n))
    print()
    print("  worst 40:")
    for r in sorted(short, key=lambda r: r["days"])[:40]:
        print("    #%-6s %-22s %-22s %s -> %s  %2d days  cut-off %-3s  mode %-12s pay %s"
              % (r["cid"], r["name"][:22], r["co"][:20], r["old"], r["new"],
                 r["days"], r["cutoff"], r["mode"], r["pid"]))
