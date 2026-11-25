#!/bin/bash
# Joins ISPMan's ACS (GenieACS) to ISPMan, once, as root on the ISPMan server.
# Safe to run again: it keeps an existing secret and replaces the provision.
#
#   1. A shared secret, in ISPMan's .env.local (ACS_SHARED_SECRET) and in
#      GenieACS's environment (ISPMAN_ACS_SECRET), so only the ACS can ask
#      ISPMan what an ONU should have.
#   2. The extension that asks (ext/ispman.js).
#   3. The "ispman" provision, and a preset that runs it at every check-in.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP_ENV=/var/www/ispman/.env.local
ACS_ENV=/opt/genieacs/genieacs.env
EXT_DIR=/opt/genieacs/ext
NBI=http://127.0.0.1:7557

secret="$(grep -E '^ACS_SHARED_SECRET=' "$APP_ENV" | head -1 | cut -d= -f2- || true)"
if [ -z "$secret" ]; then
  secret="$(openssl rand -hex 32)"
  printf '\nACS_SHARED_SECRET=%s\n' "$secret" >> "$APP_ENV"
  echo "secret added to ISPMan"
fi
if grep -qE '^ISPMAN_ACS_SECRET=' "$ACS_ENV"; then
  sed -i "s/^ISPMAN_ACS_SECRET=.*/ISPMAN_ACS_SECRET=$secret/" "$ACS_ENV"
else
  printf 'ISPMAN_ACS_SECRET=%s\nISPMAN_PORT=3000\n' "$secret" >> "$ACS_ENV"
fi
echo "secret set for the ACS"

install -d "$EXT_DIR"
install -m 0644 "$HERE/ispman.js" "$EXT_DIR/ispman.js"
echo "extension installed"

curl -sf -X PUT "$NBI/provisions/ispman" --data-binary @"$HERE/provision-ispman.js" >/dev/null
echo "provision installed"
curl -sf -X PUT "$NBI/presets/ispman" -H 'content-type: application/json' \
  --data '{"weight":0,"channel":"ispman","events":{},"precondition":"","configurations":[{"type":"provision","name":"ispman","args":null}]}' >/dev/null
echo "preset installed"

systemctl restart genieacs-cwmp
pm2 restart ispman --update-env --silent
echo "done"
