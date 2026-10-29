#!/usr/bin/env bash
#
# Applies supabase/migrations/*.sql to the database, on the server, over a real
# Postgres connection.
#
# WHY THIS EXISTS. The app talks to Supabase over PostgREST, which is an HTTP
# API: it executes queries but cannot execute DDL. So every migration until now
# has had to be pasted into the Supabase SQL editor by hand, which means a
# deploy is only half a deploy — the code ships and the feature stays invisible
# until somebody remembers to run the SQL. Twice that gap has been mistaken for
# a broken build.
#
# THE ONE SECRET. This reads a Postgres connection string from
# /etc/ispman/db.env, which is root-only and is never printed, logged or echoed
# by this script. Nothing else here needs a credential.
#
# WHAT HAS ALREADY RUN is recorded in public.schema_migrations. Migrations 0001
# to 0043 were applied by hand before this script existed and are not in that
# table, so the first thing to do on a fresh install is record them without
# running them:
#
#     ispman-migrate --mark-applied-through 0043
#
# After that, a bare run applies everything new, oldest first:
#
#     ispman-migrate                       # everything not yet applied
#     ispman-migrate 0044_payment_reference.sql   # one named file
#     ispman-migrate --status              # what is applied and what is pending
#     ispman-migrate --dry-run             # what a bare run would do
#
# EACH MIGRATION IS ONE TRANSACTION (--single-transaction with ON_ERROR_STOP),
# so a migration that fails halfway leaves nothing behind. The row in
# schema_migrations is written inside that same transaction: a migration is
# recorded as applied if and only if it actually applied.
#
set -euo pipefail

ENV_FILE=/etc/ispman/db.env
MIGRATIONS_DIR="${ISPMAN_MIGRATIONS_DIR:-/var/www/ispman/supabase/migrations}"

die() { echo "ispman-migrate: $*" >&2; exit 1; }

[ -r "$ENV_FILE" ] || die "cannot read $ENV_FILE.
Put the Postgres connection string in it, owned by root and chmod 600:

  DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/postgres?sslmode=require

Supabase gives you this under Project Settings > Database > Connection string
(URI). Use the session-mode pooler, not the transaction-mode one: transaction
mode drops the session state some DDL needs.

This file is the only place that password lives on this machine. This script
never prints it."

# Sourced rather than parsed so the file can hold ordinary shell assignment, and
# in a subshell-free way so DATABASE_URL is available below. set -u would turn a
# missing variable into a confusing unbound error, so it is checked explicitly.
# shellcheck disable=SC1090
. "$ENV_FILE"
[ -n "${DATABASE_URL:-}" ] || die "$ENV_FILE does not set DATABASE_URL."

[ -d "$MIGRATIONS_DIR" ] || die "no migrations directory at $MIGRATIONS_DIR"

# PGPASSWORD is deliberately NOT used: the password is inside the URI and is
# handed to psql as one argument, so it never appears in a separate variable
# that something else might echo. ON_ERROR_STOP makes psql exit non-zero on the
# first error instead of carrying on and reporting success.
psql_run() {
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --no-psqlrc "$@"
}

ensure_table() {
  psql_run -q -c "
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    COMMENT ON TABLE public.schema_migrations IS
      'Which files in supabase/migrations have been applied. Written by scripts/ispman-migrate.sh.';
  " >/dev/null
}

applied_list() {
  psql_run -t -A -c "SELECT filename FROM public.schema_migrations ORDER BY filename"
}

all_list() {
  # Basename only, sorted, so the numeric prefix orders them.
  find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.sql' -printf '%f\n' | sort
}

# Files present on disk that have no row in schema_migrations.
pending_list() {
  local applied
  applied="$(applied_list)"
  local f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if ! printf '%s\n' "$applied" | grep -Fxq "$f"; then
      printf '%s\n' "$f"
    fi
  done < <(all_list)
}

apply_one() {
  local file="$1"
  local path="$MIGRATIONS_DIR/$file"
  [ -r "$path" ] || die "no such migration: $file"

  echo "--> $file"
  # The migration and its bookkeeping row in ONE transaction. A migration that
  # throws rolls back the row with it, so it stays pending and can be re-run.
  # The INSERT is appended to the file's SQL on the fly rather than run after,
  # because run after it would be a second transaction and could be the thing
  # that fails.
  {
    cat "$path"
    printf '\nINSERT INTO public.schema_migrations (filename) VALUES (%s) ON CONFLICT DO NOTHING;\n' \
      "$(printf "'%s'" "${file//\'/\'\'}")"
  } | psql_run --single-transaction -q -f - >/dev/null

  echo "    applied"
}

case "${1:-}" in
  --status)
    ensure_table
    echo "Applied:"
    applied_list | sed 's/^/  /'
    echo "Pending:"
    pending_list | sed 's/^/  /'
    ;;

  --dry-run)
    ensure_table
    echo "Would apply, in this order:"
    pending_list | sed 's/^/  /'
    ;;

  --mark-applied-through)
    through="${2:-}"
    [ -n "$through" ] || die "usage: ispman-migrate --mark-applied-through 0043"
    ensure_table
    # Everything whose numeric prefix is <= the given one, recorded WITHOUT
    # being run. For an existing database whose migrations were applied by hand.
    marked=0
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      prefix="${f%%_*}"
      if [ "$prefix" \< "$through" ] || [ "$prefix" = "$through" ]; then
        psql_run -q -c "INSERT INTO public.schema_migrations (filename) VALUES ('$f') ON CONFLICT DO NOTHING;" >/dev/null
        marked=$((marked + 1))
      fi
    done < <(all_list)
    echo "Recorded $marked migration(s) as already applied, through $through."
    echo "Nothing was run against the database."
    ;;

  --help|-h)
    sed -n '3,35p' "$0" | sed 's/^# \{0,1\}//'
    ;;

  '')
    ensure_table
    pending="$(pending_list)"
    if [ -z "$pending" ]; then
      echo "Nothing to apply — every migration on disk is recorded as applied."
      exit 0
    fi
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      apply_one "$f"
    done <<< "$pending"
    echo "Done."
    ;;

  *)
    ensure_table
    for f in "$@"; do
      apply_one "$f"
    done
    echo "Done."
    ;;
esac
