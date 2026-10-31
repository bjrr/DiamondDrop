#!/bin/bash
#
# Guarded Shopify theme push.
#
# ---------------------------------------------------------------------------
# WHY THIS EXISTS
# ---------------------------------------------------------------------------
# On 2026-10-30 the live theme 187633434842 was reduced from ~410 files to 4.
# The four survivors were config/settings_data.json, config/settings_schema.json,
# layout/theme.liquid and templates/gift_card.liquid — exactly the set Shopify
# refuses to delete. That signature means a full-directory sync ran against a
# directory with nothing in it to upload, so the CLI deleted every remote file
# it was permitted to delete.
#
# The command that can do this is:
#
#     shopify theme push --theme <id> --allow-live
#
# run from a directory that is not the theme root. Three things made it
# possible and this script removes all three:
#
#   1. NO `cd` IN THE COMMAND. The shell's working directory is reset to the
#      repo root between tool calls, and the repo root is NOT a theme root
#      (the theme lives in ./theme). A bare `shopify theme push` there has no
#      files to upload. This script always resolves and verifies the root.
#   2. NO `--nodelete`. Without it, push is a mirror, not an upload. This
#      script passes --nodelete unless DELETE=1 is set explicitly.
#   3. OUTPUT PIPED THROUGH `tail -4`. The file list and any deletion summary
#      scrolled past unseen, so a push that destroyed the theme looked like a
#      push that succeeded. This script tees full output to a log.
#
# ---------------------------------------------------------------------------
# USAGE
#   scripts/theme-push.sh <theme-id> <file> [file ...]
#
#   THEME_STORE=...  override the store (default nnb1th-cm.myshopify.com)
#   DELETE=1         permit remote deletions (refuses on the live theme)
# ---------------------------------------------------------------------------
set -euo pipefail

STORE="${THEME_STORE:-nnb1th-cm.myshopify.com}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$REPO/theme"

THEME_ID="${1:-}"; shift || true
if [ -z "$THEME_ID" ] || [ "$#" -eq 0 ]; then
  echo "usage: scripts/theme-push.sh <theme-id> <file> [file ...]" >&2
  echo "       every file is passed as an explicit --only; there is no 'push everything' mode." >&2
  exit 2
fi

# GUARD 1 — the theme root must actually be a theme root. This is the check
# whose absence caused the incident.
for required in config/settings_schema.json layout/theme.liquid; do
  if [ ! -f "$ROOT/$required" ]; then
    echo "REFUSING: $ROOT is not a theme root (missing $required)." >&2
    exit 1
  fi
done

# GUARD 2 — every named file must exist. A typo must not become a deletion or
# a silent no-op.
ONLY=()
for f in "$@"; do
  if [ ! -f "$ROOT/$f" ]; then
    echo "REFUSING: $f does not exist under $ROOT." >&2
    exit 1
  fi
  ONLY+=(--only "$f")
done

LIVE_ID="$(npx shopify theme list --store "$STORE" --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const t=JSON.parse(s).find(x=>x.role==="live"||x.role==="main");console.log(t?t.id:"")}catch{console.log("")}})' || true)"
TARGETS_LIVE=0
[ -n "$LIVE_ID" ] && [ "$LIVE_ID" = "$THEME_ID" ] && TARGETS_LIVE=1

# GUARD 3 — deletions are off by default and never allowed on the live theme.
DELETE_FLAG=(--nodelete)
if [ "${DELETE:-0}" = "1" ]; then
  if [ "$TARGETS_LIVE" = "1" ]; then
    echo "REFUSING: DELETE=1 against the LIVE theme ($THEME_ID). Push to a draft and publish instead." >&2
    exit 1
  fi
  DELETE_FLAG=()
  echo "WARNING: deletions enabled for theme $THEME_ID."
fi

# GUARD 4 — targeting the live theme must be deliberate. The CLI needs
# --allow-live and will otherwise hang on an interactive prompt. That flag is
# only hazardous without --only and --nodelete, both of which are enforced
# above; requiring LIVE=1 keeps it from ever being typed out of habit.
LIVE_FLAG=()
if [ "$TARGETS_LIVE" = "1" ]; then
  if [ "${LIVE:-0}" != "1" ]; then
    echo "REFUSING: $THEME_ID is the LIVE theme. Re-run with LIVE=1 to confirm." >&2
    exit 1
  fi
  LIVE_FLAG=(--allow-live)
  echo "NOTE: targeting the LIVE theme, confirmed by LIVE=1."
fi

mkdir -p "$REPO/.theme-backups/logs"
LOG="$REPO/.theme-backups/logs/push-$THEME_ID-$(date +%Y%m%d-%H%M%S).log"

echo "store   : $STORE"
echo "theme   : $THEME_ID"
echo "root    : $ROOT"
echo "files   : $# explicit --only selection(s)"
echo "delete  : ${DELETE:-0}"
echo "log     : $LOG"
echo

# `cd` is inside this script, so it cannot be lost to a working-directory
# reset between tool calls. Full output is kept; only the tail is echoed.
cd "$ROOT"
npx shopify theme push \
  --store "$STORE" \
  --theme "$THEME_ID" \
  "${DELETE_FLAG[@]}" \
  "${LIVE_FLAG[@]}" \
  "${ONLY[@]}" \
  --no-color 2>&1 | tee "$LOG" | tail -20

echo
echo "full log: $LOG"
if grep -qiE '\bdelet(e|ed|ing)\b' "$LOG"; then
  echo "NOTE: the log mentions deletion — read it in full before trusting this push." >&2
fi
