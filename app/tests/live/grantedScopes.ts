/**
 * WHAT SHOPIFY ACTUALLY GRANTED — not what `shopify.app.toml` asks for.
 *
 * Those are different things, and the gap between them is where a scope bug
 * lives. The TOML is a REQUEST. The grant happens only when the merchant
 * re-authorises, and until they do the app runs on the OLD set while the file
 * says otherwise. Editing the TOML and assuming the capability now exists is
 * precisely the mistake this exists to prevent (owner instruction 2026-09-29:
 * "do not assume the TOML change means Shopify granted it").
 *
 * Shopify also grants IMPLIED read scopes alongside writes — requesting
 * `write_draft_orders` yields `read_draft_orders` too — so the granted list is
 * legitimately longer than the requested one. Compare MEMBERSHIP, never length.
 *
 * RUN: npx tsx tests/live/grantedScopes.ts
 *   (DATABASE_URL must point at the database holding the app's Shopify session)
 */
import "dotenv/config";
const SHOP = process.env.SHOPIFY_SHOP_DOMAIN!;
async function main() {
  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(SHOP);
  const res = await admin.graphql(`{ currentAppInstallation { accessScopes { handle } } }`);
  const body = (await res.json()) as { data?: { currentAppInstallation?: { accessScopes?: { handle: string }[] } }; errors?: unknown };
  if (body.errors) { console.log("errors:", JSON.stringify(body.errors).slice(0, 300)); }
  const scopes = (body.data?.currentAppInstallation?.accessScopes ?? []).map((s) => s.handle).sort();
  console.log("GRANTED SCOPES (" + scopes.length + "):");
  for (const s of scopes) console.log("  " + s);
  console.log("\nread_customers granted: " + (scopes.includes("read_customers") ? "YES" : "NO"));
  console.log("write_customers granted: " + (scopes.includes("write_customers") ? "YES (unexpected)" : "no"));
}
main().catch((e) => { console.error("THREW:", String(e).slice(0, 300)); process.exitCode = 1; });
