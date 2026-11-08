#!/usr/bin/env bash
#
# Deploy the ISOLATED DEVELOPMENT environment. Never production.
#
# ---------------------------------------------------------------------------
# WHY THIS SCRIPT EXISTS
# ---------------------------------------------------------------------------
# Two commands in this repository mirror a local working tree onto a remote
# that is not named in the command:
#
#   flyctl deploy              reads fly.toml  -> app "caratforus"  (PRODUCTION)
#   shopify app deploy         targets the CURRENTLY LINKED app, whose
#                              application_url and App Proxy point at
#                              https://caratforus.fly.dev  (PRODUCTION)
#
# In both cases the dangerous invocation is the SHORTER one. That is the same
# shape as the `shopify theme push` incident this repository already carries a
# scripted guard for (see scripts/theme-push.sh and CLAUDE.md): a bare command
# that looks like "deploy what I am working on" and in fact targets the live
# system. So the dev path gets a script too, and the rule is the same — use
# the script, never the bare command.
#
# Usage:
#   ./scripts/deploy-dev.sh            # Fly app + Shopify app config
#   ./scripts/deploy-dev.sh fly        # Fly app only
#   ./scripts/deploy-dev.sh shopify    # Shopify app config only
set -euo pipefail

FLY_APP="caratforus-dev"
FLY_CONFIG="fly.dev.toml"
SHOPIFY_CONFIG="caratforus-dev"
PROD_FLY_APP="caratforus"

cd "$(dirname "$0")/.."

# ---------------------------------------------------------------------------
# REFUSE TO RUN IF THE CONFIG COULD REACH PRODUCTION.
#
# Checked rather than assumed, because the whole premise of the script is that
# a deploy command does not say out loud which remote it is about to overwrite.
# A one-character edit to fly.dev.toml's `app =` line is all it would take.
# ---------------------------------------------------------------------------
if ! grep -qx "app = \"${FLY_APP}\"" "${FLY_CONFIG}"; then
  echo "REFUSING: ${FLY_CONFIG} does not declare app = \"${FLY_APP}\"." >&2
  exit 1
fi
if grep -qx "app = \"${PROD_FLY_APP}\"" "${FLY_CONFIG}"; then
  echo "REFUSING: ${FLY_CONFIG} names the production app." >&2
  exit 1
fi
# COMMENTS STRIPPED BEFORE MATCHING, and the first version of this script got
# it wrong: it refused to run because the dev app's own config EXPLAINS the
# production URL in a comment. A guard that reads prose reports the thing it
# is documenting as the thing it is preventing. Only assigned values count.
SHOPIFY_VALUES="$(sed 's/#.*//' "shopify.app.${SHOPIFY_CONFIG}.toml")"
if ! grep -q "caratforus-dev.fly.dev" <<<"${SHOPIFY_VALUES}"; then
  echo "REFUSING: shopify.app.${SHOPIFY_CONFIG}.toml does not point at the dev origin." >&2
  exit 1
fi
if grep -q "https://caratforus\.fly\.dev" <<<"${SHOPIFY_VALUES}"; then
  echo "REFUSING: shopify.app.${SHOPIFY_CONFIG}.toml assigns the PRODUCTION origin." >&2
  exit 1
fi

TARGET="${1:-all}"

if [[ "${TARGET}" == "all" || "${TARGET}" == "fly" ]]; then
  echo "==> Fly: deploying ${FLY_APP} from ${FLY_CONFIG}"
  # --config and --app both named. Either alone would be enough; both are
  # given so that a mistake in one is contradicted by the other rather than
  # silently obeyed.
  flyctl deploy --config "${FLY_CONFIG}" --app "${FLY_APP}"
fi

if [[ "${TARGET}" == "all" || "${TARGET}" == "shopify" ]]; then
  echo "==> Shopify: deploying app config ${SHOPIFY_CONFIG}"
  # --allow-updates and --allow-deletes answer the CLI's non-interactive
  # confirmation prompts. They are safe ONLY because the guards above have
  # already established which app record is being written: --allow-deletes
  # removes declarations absent from the config, which on this app means the
  # `app init` template's leftover FAQ metaobject and metafield definitions.
  # Against the production app record the same flag would remove the SYOS
  # metaobject definition, which is precisely why the guards run first.
  npx shopify app deploy --config "${SHOPIFY_CONFIG}" --allow-updates --allow-deletes --no-input
fi

echo "==> done. Dev app: https://${FLY_APP}.fly.dev"
