#!/bin/bash
#
# Create a NEW unpublished theme from the complete local theme source.
#
# ---------------------------------------------------------------------------
# WHY THIS IS A SEPARATE SCRIPT
# ---------------------------------------------------------------------------
# `theme-push.sh` deliberately has no push-everything mode, because syncing a
# whole directory over an EXISTING theme is the operation that destroyed the
# live theme on 2026-10-30. This is a different operation with a different
# risk profile: the target does not exist yet, so there is nothing to delete
# and no published storefront to damage.
#
# It exists as the alternative to `themeDuplicate`, which works but is
# ASYNCHRONOUS AND SLOW, and reports nothing about its progress. Read a few
# seconds after the mutation returns, a duplicate looks like a wiped theme:
# `layout/theme.liquid` 48 bytes, `config/settings_schema.json` 2, most
# sections simply absent. Pushing into that window gets files rejected for
# referencing sections that "do not exist" — they exist, they have not been
# copied yet. Building the draft from the local source instead removes the
# race, and means the draft matches the commit under test rather than
# whatever is currently live.
#
# ---------------------------------------------------------------------------
# THE GUARD THAT MATTERS
# ---------------------------------------------------------------------------
# An incomplete local directory must never become a theme, because a theme
# that exists can later be published. So this refuses to run unless the source
# looks like a real, whole theme: the two files Shopify will not delete, plus a
# floor on the total file count. The live theme carries ~410 files; 200 is low
# enough to never trip on legitimate work and high enough to catch a half-
# checked-out or partially-wiped tree.
#
# It also refuses to reuse a name that already exists, so this can never be
# turned into "push everything over that theme" by typing the wrong argument.
#
# ---------------------------------------------------------------------------
# USAGE
#   scripts/theme-new-draft.sh <name>
#
#   THEME_STORE=...  override the store (default nnb1th-cm.myshopify.com)
#   MIN_FILES=...    override the completeness floor (default 200)
# ---------------------------------------------------------------------------
set -euo pipefail

STORE="${THEME_STORE:-nnb1th-cm.myshopify.com}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$REPO/theme"
MIN_FILES="${MIN_FILES:-200}"

NAME="${1:-}"
if [ -z "$NAME" ]; then
  echo "usage: scripts/theme-new-draft.sh <name>" >&2
  exit 2
fi

# GUARD 1 — the source must be a theme root.
for required in config/settings_schema.json layout/theme.liquid; do
  if [ ! -f "$ROOT/$required" ]; then
    echo "REFUSING: $ROOT is not a theme root (missing $required)." >&2
    exit 1
  fi
done

# GUARD 2 — the source must be WHOLE. An empty or partial directory is how the
# original incident happened; here it would mint a theme that looks real.
COUNT="$(find "$ROOT" -type f \
  \( -name '*.liquid' -o -name '*.json' -o -name '*.css' -o -name '*.js' \) | wc -l | tr -d ' ')"
if [ "$COUNT" -lt "$MIN_FILES" ]; then
  echo "REFUSING: $ROOT holds only $COUNT theme files, below the floor of $MIN_FILES." >&2
  echo "          An incomplete source must not become a theme — a theme can be published later." >&2
  exit 1
fi

# GUARD 3 — never reuse an existing name. Keeps this from becoming a
# full-directory sync over a theme that already exists.
EXISTING="$(npx shopify theme list --store "$STORE" --json 2>/dev/null \
  | NAME="$NAME" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const m=JSON.parse(s).filter(t=>t.name===process.env.NAME);console.log(m.map(t=>t.id).join(","))}catch{console.log("")}})' || true)"
if [ -n "$EXISTING" ]; then
  echo "REFUSING: a theme named '$NAME' already exists (id $EXISTING)." >&2
  echo "          Pick a new name, or use scripts/theme-push.sh for targeted file pushes." >&2
  exit 1
fi

mkdir -p "$REPO/.theme-backups/logs"
LOG="$REPO/.theme-backups/logs/new-draft-$(date +%Y%m%d-%H%M%S).log"

echo "store   : $STORE"
echo "name    : $NAME"
echo "root    : $ROOT ($COUNT theme files, floor $MIN_FILES)"
echo "log     : $LOG"
echo

cd "$ROOT"
npx shopify theme push \
  --store "$STORE" \
  --unpublished \
  --theme "$NAME" \
  --no-color 2>&1 | tee "$LOG" | tail -20

echo
echo "full log: $LOG"

# A rejected file must fail the script. `shopify theme push` exits 0 when it
# reports "pushed with errors", which is how a broken draft once looked fine.
if grep -qiE 'was pushed with errors|does not refer to an existing|Invalid (JSON|schema)' "$LOG"; then
  echo >&2
  echo "FAILED: Shopify rejected at least one file. The CLI still exited 0; this script does not." >&2
  exit 1
fi

NEW_ID="$(npx shopify theme list --store "$STORE" --json 2>/dev/null \
  | NAME="$NAME" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const t=JSON.parse(s).find(x=>x.name===process.env.NAME);console.log(t?t.id:"")}catch{console.log("")}})' || true)"
echo "theme id: ${NEW_ID:-unknown}"
echo "preview : https://$STORE?preview_theme_id=${NEW_ID:-}"
