#!/usr/bin/env bash
#
# Pushes the variables in .env.production.vercel into Vercel's Production
# environment, one at a time, then redeploys.
#
# The dashboard's bulk-paste box silently does nothing in some cases; this does
# not depend on it. Values are piped in on stdin, so none of them appear in your
# shell history or in this script's output.
#
#   1. npx vercel@latest login       (once, opens your browser)
#   2. bash scripts/push-env-to-vercel.sh
#
set -euo pipefail

FILE=".env.production.vercel"
PROJECT="diiwaan-so"
VERCEL="npx --yes vercel@latest"

cd "$(dirname "$0")/.."

if [ ! -f "$FILE" ]; then
  echo "Cannot find $FILE in $(pwd)." >&2
  exit 1
fi

# Refuse to upload placeholders — a variable that says PASTE_YOUR... is worse
# than one that is absent, because the app then fails further along.
if grep -q "PASTE_YOUR\|<db_username>\|<db_password>" "$FILE"; then
  echo "There are still placeholders in $FILE:" >&2
  grep -n "PASTE_YOUR\|<db_username>\|<db_password>" "$FILE" | cut -d= -f1 >&2
  echo "Fill those in first." >&2
  exit 1
fi

if ! $VERCEL whoami >/dev/null 2>&1; then
  echo "You are not signed in to Vercel yet. Run this first:" >&2
  echo "    npx vercel@latest login" >&2
  exit 1
fi

echo "Signed in as: $($VERCEL whoami 2>/dev/null)"
echo

count=0
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|\#*) continue ;; esac
  key="${line%%=*}"
  value="${line#*=}"
  [ -z "$key" ] && continue
  [ -z "$value" ] && { echo "  skipped $key (no value)"; continue; }

  # --force replaces any existing copy, so this is safe to re-run after a
  # key rotation.
  if printf '%s' "$value" | $VERCEL env add "$key" production --force --project "$PROJECT" >/dev/null 2>&1; then
    echo "  set $key"
    count=$((count + 1))
  else
    echo "  FAILED to set $key" >&2
  fi
done < "$FILE"

echo
echo "$count variables are now in Production."
echo "Redeploying so they take effect..."
$VERCEL --prod --yes >/dev/null 2>&1 && echo "Done." || echo "Deploy from the dashboard instead: Deployments -> ... -> Redeploy"
