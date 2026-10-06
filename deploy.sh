#!/usr/bin/env bash
#
# deploy.sh — deploy ISPMan on the pm2 server without ever taking the site down
# because of a build.
#
#   ./deploy.sh              pull, install if needed, build, switch, restart, check
#   ./deploy.sh --install    same, but always run npm install
#   ./deploy.sh --rollback   switch back to the previous build and restart
#   ./deploy.sh --check      only check the live site's CSS and JS
#
# Settings (environment variables, all optional):
#   PM2_APP    the pm2 process name                default: ispman
#   SITE_URL   where the login page is fetched     default: https://app.ispman.online
#
# WHY IT BUILDS IN A SEPARATE FOLDER
#   `npm run build` writes into .next, the folder the RUNNING app serves its CSS
#   and JS from. It deletes the old files as it goes, so the live site breaks
#   mid-build, and stays broken if the build then fails. That took the site down
#   on 6 Oct 2026, and it would have happened with a good build too.
#
#   So builds go into one of two slots, .next-a and .next-b, and .next is a
#   symlink to whichever is live. Each deploy builds into the slot the live app
#   is NOT using. Only if that build succeeds does .next switch to it (one atomic
#   rename) and pm2 restart. If the build fails, nothing the running app uses has
#   been touched. The previous build stays in the other slot for --rollback.
#
#   next.config.ts reads the build folder from NEXT_DIST_DIR (default .next);
#   only this script sets it, and only for the build command.
#
#   First run: .next is still a real folder. It is kept as .next-previous when
#   the link takes its place, and --rollback can put it back.

set -Eeuo pipefail

# Only the build command may see a build folder. Anything inherited from the
# shell would otherwise reach the app through `pm2 restart --update-env`.
unset NEXT_DIST_DIR

APP="${PM2_APP:-ispman}"
SITE_URL="${SITE_URL:-https://app.ispman.online}"
SLOT_A=".next-a"
SLOT_B=".next-b"
LIVE=".next"
FIRST_RUN_BACKUP=".next-previous"

# Colours only when there is a terminal that knows them.
RED="$(tput setaf 1 2>/dev/null || true)"
GREEN="$(tput setaf 2 2>/dev/null || true)"
YELLOW="$(tput setaf 3 2>/dev/null || true)"
BOLD="$(tput bold 2>/dev/null || true)"
RESET="$(tput sgr0 2>/dev/null || true)"

say()  { printf '%s\n' "${BOLD}==>${RESET} $*"; }
warn() { printf '%s\n' "${YELLOW}${BOLD}WARNING:${RESET} $*"; }

# Loud, and stops the script.
die() {
  printf '\n%s\n' "${RED}${BOLD}################################################################${RESET}"
  printf '%s\n' "${RED}${BOLD}  DEPLOY STOPPED: $*${RESET}"
  printf '%s\n\n' "${RED}${BOLD}################################################################${RESET}"
  exit 1
}

# Run from the folder this script lives in, wherever it is called from.
cd "$(dirname "$(readlink -f "$0")")"

MODE="deploy"
FORCE_INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --rollback) MODE="rollback" ;;
    --check) MODE="check" ;;
    --install) FORCE_INSTALL=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) die "unknown option: $arg (try --help)" ;;
  esac
done

need() {
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 || die "'$cmd' is not installed or not on PATH"
  done
}

if [ "$MODE" = "check" ]; then
  need curl
else
  need git npm pm2 curl flock
  # One deploy at a time.
  exec 9>"/tmp/ispman-deploy.lock"
  flock -n 9 || die "another deploy is already running"
fi

# --------------------------------------------------------------------------------
# Live-site check: every CSS and JS file the login page asks for must return 200.
# --------------------------------------------------------------------------------
check_site() {
  local page code assets bad=0 total=0 a

  say "Fetching $SITE_URL/login"
  page="$(mktemp)"
  code=""
  # The app needs a moment after a restart; try for up to a minute.
  for _ in $(seq 1 30); do
    code="$(curl -s -o "$page" -w '%{http_code}' --max-time 10 "$SITE_URL/login" || true)"
    [ "$code" = "200" ] && break
    sleep 2
  done
  if [ "$code" != "200" ]; then
    rm -f "$page"
    printf '\n%s\n' "${RED}${BOLD}!!!! THE LOGIN PAGE RETURNED HTTP ${code:-nothing} — THE SITE IS NOT SERVING !!!!${RESET}"
    printf '%s\n' "${RED}${BOLD}!!!! Look at: pm2 logs $APP --lines 50 --nostream${RESET}"
    return 1
  fi

  assets="$(grep -oE '/_next/static/[A-Za-z0-9_.~-]+(/[A-Za-z0-9_.~-]+)*' "$page" | grep -E '[.](js|css)$' | sort -u || true)"
  rm -f "$page"

  if [ -z "$assets" ]; then
    printf '\n%s\n' "${RED}${BOLD}!!!! THE LOGIN PAGE REFERENCES NO CSS OR JS — SOMETHING IS WRONG !!!!${RESET}"
    return 1
  fi

  while IFS= read -r a; do
    total=$((total + 1))
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$SITE_URL$a" || true)"
    if [ "$code" != "200" ]; then
      bad=$((bad + 1))
      printf '%s\n' "${RED}${BOLD}  MISSING ($code): $a${RESET}"
    fi
  done <<< "$assets"

  if [ "$bad" -gt 0 ]; then
    printf '\n%s\n' "${RED}${BOLD}################################################################${RESET}"
    printf '%s\n' "${RED}${BOLD}  $bad OF $total CSS/JS FILES ARE MISSING — PAGES WILL LOOK BROKEN${RESET}"
    printf '%s\n' "${RED}${BOLD}  Roll back with:  ./deploy.sh --rollback${RESET}"
    printf '%s\n\n' "${RED}${BOLD}################################################################${RESET}"
    return 1
  fi

  printf '%s\n' "${GREEN}${BOLD}Site OK: login page 200, all $total CSS/JS files 200.${RESET}"
}

restart_app() {
  say "Restarting pm2 app '$APP'"
  pm2 restart "$APP" --update-env >/dev/null || die "pm2 restart failed — check: pm2 list"
  sleep 5
}

# Points .next at a slot in one step: a new link is made beside it and renamed
# over it, so there is never a moment with no .next.
point_live_at() {
  ln -sfn "$1" "$LIVE.tmp"
  mv -Tf "$LIVE.tmp" "$LIVE"
}

slot_commit() {
  if [ -f "$1/DEPLOYED_COMMIT" ]; then cat "$1/DEPLOYED_COMMIT"; else echo "unknown commit"; fi
}

if [ "$MODE" = "check" ]; then
  check_site || exit 1
  exit 0
fi

pm2 describe "$APP" >/dev/null 2>&1 || die "pm2 has no app called '$APP' (set PM2_APP, see: pm2 list)"

# --------------------------------------------------------------------------------
# Rollback
# --------------------------------------------------------------------------------
if [ "$MODE" = "rollback" ]; then
  if [ -L "$LIVE" ]; then
    current="$(readlink "$LIVE")"
    if [ "$current" = "$SLOT_A" ]; then other="$SLOT_B"; else other="$SLOT_A"; fi
    if [ -f "$other/BUILD_ID" ]; then
      say "Switching back from $current to $other ($(slot_commit "$other"))"
      point_live_at "$other"
    elif [ -d "$FIRST_RUN_BACKUP" ]; then
      say "Switching back to the build from before deploy.sh was first used"
      rm -f "$LIVE"
      mv "$FIRST_RUN_BACKUP" "$LIVE"
    else
      die "there is no previous build to roll back to"
    fi
  else
    die ".next is not a deploy.sh link, so there is nothing to roll back to"
  fi
  restart_app
  check_site || die "rollback finished but the site check failed (see above)"
  warn "the code in git is still the newer commit; only the running build was rolled back"
  exit 0
fi

# --------------------------------------------------------------------------------
# Deploy
# --------------------------------------------------------------------------------
if ! git diff --quiet || ! git diff --cached --quiet; then
  git status --short
  die "this folder has local changes to tracked files (above); refusing to pull over them"
fi

BEFORE="$(git rev-parse HEAD)"
say "Pulling (currently at $(git log -1 --format='%h %s'))"
git pull --ff-only || die "git pull failed — nothing was built or restarted"
AFTER="$(git rev-parse HEAD)"
if [ "$BEFORE" = "$AFTER" ]; then
  say "Already up to date; rebuilding $(git log -1 --format='%h') anyway"
else
  say "Pulled $(git rev-list --count "$BEFORE..$AFTER") commit(s), now at $(git log -1 --format='%h %s')"
fi

# Install only when the dependencies changed (or on --install). npm install
# rewrites node_modules, which the running app also loads from, so it is not
# done when there is nothing to install.
if [ "$FORCE_INSTALL" = "1" ] || [ ! -d node_modules ] \
   || ! git diff --quiet "$BEFORE" "$AFTER" -- package.json package-lock.json; then
  say "Installing dependencies"
  npm install --no-audit --no-fund || die "npm install failed — nothing was built or restarted"
else
  say "Dependencies unchanged; skipping npm install"
fi

# Which slot is live, and which one to build into.
if [ -L "$LIVE" ]; then
  live_slot="$(readlink "$LIVE")"
else
  live_slot=""
fi
if [ "$live_slot" = "$SLOT_A" ]; then target="$SLOT_B"; else target="$SLOT_A"; fi
say "Live build: ${live_slot:-.next folder}. Building into $target"

rm -rf "$target"
if ! NEXT_DIST_DIR="$target" npm run build; then
  rm -rf "$target"
  git checkout -- tsconfig.json 2>/dev/null || true
  die "THE BUILD FAILED. The running app was NOT touched and is still serving the previous build."
fi
# Next may add its type folders to tsconfig.json; the slots are already listed,
# but never leave a tracked file modified on the server.
git diff --quiet -- tsconfig.json || git checkout -- tsconfig.json

[ -f "$target/BUILD_ID" ] || die "the build reported success but $target/BUILD_ID is missing; running app NOT touched"
git log -1 --format='%h %s' > "$target/DEPLOYED_COMMIT"

# Switch. On the first run .next is a real folder: keep it for --rollback.
if [ -d "$LIVE" ] && [ ! -L "$LIVE" ]; then
  rm -rf "$FIRST_RUN_BACKUP"
  mv "$LIVE" "$FIRST_RUN_BACKUP"
  say "First run: the old .next folder is kept as $FIRST_RUN_BACKUP"
fi
say "Switching live build to $target"
point_live_at "$target"

restart_app

if check_site; then
  printf '\n%s\n' "${GREEN}${BOLD}Deployed: $(git log -1 --format='%h %s')${RESET}"
else
  printf '\n%s\n' "${RED}${BOLD}Deployed $(git log -1 --format='%h %s') BUT THE SITE CHECK FAILED (see above).${RESET}"
  exit 1
fi
