#!/usr/bin/env python3
"""
Applies supabase/migrations/*.sql, from the server, over the Supabase
management API.

WHY NOT A POSTGRES CONNECTION. The obvious way to do this is psql against the
database. That cannot work from this server:

  * the direct host, db.<ref>.supabase.co, resolves to an AAAA record only, and
    this instance has no IPv6 egress at all.
  * outbound 5432 and 6543 are blocked upstream of the box. Not by ufw, whose
    OUTPUT policy is ACCEPT, so it is the instance's security group or a VPC
    NACL. Proved by a control host: scanme.nmap.org:5432 is closed from here
    while api.ipify.org:443 is open. Outbound 22 is blocked the same way.

So no amount of having the database password would help. 443 is open, and the
management API answers on it -- the same API the dashboard's own SQL editor
uses -- so that is the route.

THE CREDENTIAL IS A PERSONAL ACCESS TOKEN, not the database password. That is
the better trade on every axis: it is revocable from the dashboard in one
click, it does not require resetting the database password (which Supabase
warns "will break any existing connections"), and it is scoped to the account's
projects rather than being Postgres superuser. It lives in
/etc/ispman/supabase.env, root-only, and is never printed, logged or echoed by
this script.

WHAT HAS ALREADY RUN is recorded in public.schema_migrations. On a database
whose migrations were applied by hand, record them without running them first:

    ispman-migrate --mark-applied-through 0044

then a bare run applies everything newer, oldest first:

    ispman-migrate                        # everything pending
    ispman-migrate 0046_leads.sql         # one named file
    ispman-migrate --status               # applied vs pending
    ispman-migrate --dry-run              # what a bare run would do

EACH MIGRATION IS ONE TRANSACTION. The file's SQL and the row that records it
are sent as a single BEGIN/COMMIT block, so a migration that fails halfway
leaves nothing behind and stays pending.
"""

import json
import os
import re
import sys
import urllib.error
import urllib.request

ENV_FILE = "/etc/ispman/supabase.env"
MIGRATIONS_DIR = os.environ.get(
    "ISPMAN_MIGRATIONS_DIR", "/var/www/ispman/supabase/migrations"
)
API = "https://api.supabase.com/v1/projects/{ref}/database/query"


def die(message):
    print("ispman-migrate: " + message, file=sys.stderr)
    raise SystemExit(1)


def load_env():
    """Reads the token file. Shell-style KEY=VALUE, comments and blanks ignored."""
    if not os.path.exists(ENV_FILE):
        die(
            "cannot read " + ENV_FILE + ".\n\n"
            "Create a Supabase personal access token at\n"
            "  https://supabase.com/dashboard/account/tokens\n"
            "then put it in that file, root-only:\n\n"
            "  SUPABASE_ACCESS_TOKEN=sbp_...\n"
            "  SUPABASE_PROJECT_REF=wrjmgmsjgspyioalkbdw\n\n"
            "  chmod 600 " + ENV_FILE + "\n\n"
            "This script never prints the token."
        )
    values = {}
    with open(ENV_FILE) as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip().strip("'\"")

    token = values.get("SUPABASE_ACCESS_TOKEN", "")
    ref = values.get("SUPABASE_PROJECT_REF", "")
    if not token:
        die(ENV_FILE + " does not set SUPABASE_ACCESS_TOKEN.")
    if not ref:
        die(ENV_FILE + " does not set SUPABASE_PROJECT_REF.")
    return token, ref


def run_sql(token, ref, sql):
    """
    Sends one SQL string. Returns the decoded rows on success.

    Raises RuntimeError with the server's own message on failure. The token is
    only ever a header value -- it is not interpolated into anything printable,
    and the error paths below deliberately echo the server's message and not
    the request.
    """
    body = json.dumps({"query": sql}).encode()
    request = urllib.request.Request(
        API.format(ref=ref),
        data=body,
        method="POST",
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            text = response.read().decode()
    except urllib.error.HTTPError as err:
        detail = err.read().decode(errors="replace")
        try:
            detail = json.loads(detail).get("message", detail)
        except ValueError:
            pass
        if err.code in (401, 403):
            raise RuntimeError(
                "the access token was refused (HTTP %d). Create a new one at "
                "https://supabase.com/dashboard/account/tokens and update %s. "
                "Server said: %s" % (err.code, ENV_FILE, detail)
            )
        raise RuntimeError("HTTP %d: %s" % (err.code, detail))
    except urllib.error.URLError as err:
        raise RuntimeError("could not reach api.supabase.com: %s" % err.reason)

    if not text.strip():
        return []
    try:
        return json.loads(text)
    except ValueError:
        return []


def ensure_table(token, ref):
    run_sql(
        token,
        ref,
        """
        CREATE TABLE IF NOT EXISTS public.schema_migrations (
          filename   TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        COMMENT ON TABLE public.schema_migrations IS
          'Which files in supabase/migrations have been applied. Written by scripts/ispman-migrate.py.';
        """,
    )


def applied(token, ref):
    rows = run_sql(
        token, ref, "SELECT filename FROM public.schema_migrations ORDER BY filename"
    )
    return {r["filename"] for r in rows if isinstance(r, dict) and "filename" in r}


def on_disk():
    if not os.path.isdir(MIGRATIONS_DIR):
        die("no migrations directory at " + MIGRATIONS_DIR)
    return sorted(f for f in os.listdir(MIGRATIONS_DIR) if f.endswith(".sql"))


def quote(value):
    """A single-quoted SQL literal. Doubling is the whole of the escaping."""
    return "'" + value.replace("'", "''") + "'"


def apply_one(token, ref, name):
    path = os.path.join(MIGRATIONS_DIR, name)
    if not os.path.exists(path):
        die("no such migration: " + name)
    with open(path) as handle:
        sql = handle.read()

    print("--> " + name)
    # The migration and its bookkeeping row in ONE transaction, so a file that
    # throws halfway rolls back the row with it and stays pending.
    run_sql(
        token,
        ref,
        "BEGIN;\n" + sql + "\nINSERT INTO public.schema_migrations (filename) VALUES "
        + "(" + quote(name) + ") ON CONFLICT DO NOTHING;\nCOMMIT;",
    )
    print("    applied")


def prefix_of(name):
    match = re.match(r"^(\d+)", name)
    return match.group(1) if match else ""


def main(argv):
    token, ref = load_env()
    args = argv[1:]

    try:
        if args and args[0] == "--status":
            ensure_table(token, ref)
            done = applied(token, ref)
            print("Applied:")
            for name in sorted(done):
                print("  " + name)
            print("Pending:")
            for name in on_disk():
                if name not in done:
                    print("  " + name)
            return 0

        if args and args[0] == "--dry-run":
            ensure_table(token, ref)
            done = applied(token, ref)
            pending = [n for n in on_disk() if n not in done]
            print("Would apply, in this order:" if pending else "Nothing to apply.")
            for name in pending:
                print("  " + name)
            return 0

        if args and args[0] == "--mark-applied-through":
            if len(args) < 2:
                die("usage: ispman-migrate --mark-applied-through 0044")
            through = args[1]
            ensure_table(token, ref)
            # Recorded WITHOUT being run, for a database whose migrations were
            # applied by hand before this script existed.
            names = [n for n in on_disk() if prefix_of(n) and prefix_of(n) <= through]
            if names:
                values = ", ".join("(" + quote(n) + ")" for n in names)
                run_sql(
                    token,
                    ref,
                    "INSERT INTO public.schema_migrations (filename) VALUES "
                    + values + " ON CONFLICT DO NOTHING;",
                )
            print("Recorded %d migration(s) as already applied, through %s."
                  % (len(names), through))
            print("Nothing was run against the database.")
            return 0

        if args and args[0] in ("--help", "-h"):
            print(__doc__.strip())
            return 0

        ensure_table(token, ref)
        done = applied(token, ref)

        if args:
            for name in args:
                apply_one(token, ref, name)
        else:
            pending = [n for n in on_disk() if n not in done]
            if not pending:
                print("Nothing to apply — every migration on disk is recorded as applied.")
                return 0
            for name in pending:
                apply_one(token, ref, name)

        print("Done.")
        return 0

    except RuntimeError as err:
        die(str(err))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
