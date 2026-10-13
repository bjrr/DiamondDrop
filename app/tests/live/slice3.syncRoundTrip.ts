/**
 * SLICE 3 LIVE GATE, STAGE 1 — the `carat.luxury_steal` metafield round trip.
 *
 * WHAT THIS PROVES, AND WHY IT IS NOT A UNIT TEST.
 * `luxuryStealMetafieldWriter.test.ts` proves the writer builds the right
 * mutation and interprets a mocked response correctly. It cannot prove that
 * Shopify ACCEPTS that mutation, that `type: "boolean"` is the right type for
 * this owner, that the value comes back as a real boolean rather than the
 * string "true", or that the metafield lands on the VARIANT rather than
 * silently on some other owner. Stage 2C cost this project real time learning
 * that lesson three separate ways — `originalUnitPrice` was accepted and
 * silently ignored, `DraftOrderInvoiceSendInput` did not exist, and
 * `paymentPending` did not exist while the orders it produced were marked
 * PAID. Every one of those passed a mocked test first.
 *
 * So this harness writes to the real dev store and READS THE VALUE BACK from
 * Shopify, asserting on what Shopify actually stored rather than on what we
 * believe we sent.
 *
 * WHAT IT DELIBERATELY DOES NOT PROVE. The storefront half — that the badge,
 * disclosure and acknowledgment gate render, that the gate resets on variant
 * change, and that an order carries `_carat_ls_ack` through to an evidence
 * row. Those are F-3-1 … F-3-5 in the spec's carried-forward register. The
 * order path in particular cannot be proven from here at all: the dev store's
 * webhooks are delivered to `caratforus.fly.dev`, whose Postgres is NOT this
 * machine's `carat_dev`, so an order placed now would write its evidence row
 * somewhere this process cannot see. That needs a deploy first, and is stage 2.
 *
 * RUN:  npx tsx tests/live/slice3.syncRoundTrip.ts
 * Requires SHOPIFY_SHOP_DOMAIN and a stored offline session for that shop.
 *
 * SAFE TO RE-RUN. It records the variant's original assignment and restores
 * it in a finally block, including the metafield, so the store and database
 * are left as they were found even if an assertion fails midway.
 */
import "dotenv/config";

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok   ${message}`);
}

const READ_BACK = `#graphql
  query CaratReadLuxuryStealMetafield($id: ID!) {
    productVariant(id: $id) {
      id
      metafield(namespace: "carat", key: "luxury_steal") {
        id
        type
        value
        ownerType
      }
    }
  }
`;

async function main() {
  if (!SHOP) throw new Error("SHOPIFY_SHOP_DOMAIN is not set");
  console.log(`Slice 3 live gate, stage 1 — sync round trip against ${SHOP}\n`);

  const { prisma } = await import("~/db/client.server");
  const { unauthenticated } = await import("~/shopify.server");
  const { ShopifyLuxuryStealMetafieldSyncPort } = await import("~/jobs/luxurysteals/ports");
  const { syncLuxuryStealAssignment } = await import("~/jobs/luxurysteals/syncAssignment.server");
  const { setLuxuryStealAssignment } = await import("~/db/repositories/luxuryStealRepository.server");

  // THE FIXTURE IS VERIFIED BEFORE IT IS USED, not assumed.
  //
  // Being mapped in Postgres is not the same as existing in Shopify. When this
  // harness was first run, 20 of this database's 21 mapped variant gids no
  // longer resolved — demo products had been deleted from the dev store while
  // the mappings stayed behind. The first run therefore failed with
  // "Owner does not exist", which reads like a permissions or API bug and is
  // actually stale fixture data. Resolving candidates against Shopify first
  // turns that into a clear diagnosis instead of a misleading error.
  const candidates = await prisma.masterVariant.findMany({
    where: { shopifyVariantGid: { startsWith: "gid://shopify/ProductVariant/" } },
    select: { id: true, shopifyVariantGid: true, isLuxurySteal: true },
  });
  if (candidates.length === 0) {
    throw new Error("no Shopify-mapped master variant exists in this database");
  }

  const { admin: probeAdmin } = await unauthenticated.admin(SHOP);
  const probe = await probeAdmin.graphql(
    `#graphql
      query CaratResolveVariants($ids: [ID!]!) {
        nodes(ids: $ids) { ... on ProductVariant { id } }
      }
    `,
    { variables: { ids: candidates.map((c) => c.shopifyVariantGid) } }
  );
  const probeBody = (await probe.json()) as {
    data?: { nodes?: ({ id?: string } | null)[] };
  };
  const liveGids = new Set(
    (probeBody.data?.nodes ?? []).filter(Boolean).map((n) => n!.id!)
  );
  const variant = candidates.find((c) => liveGids.has(c.shopifyVariantGid!));
  if (!variant?.shopifyVariantGid) {
    throw new Error(
      `none of this database's ${candidates.length} mapped variant gids resolve in ${SHOP}. ` +
        "The mappings are stale — re-map before running this gate."
    );
  }
  console.log(`${liveGids.size} of ${candidates.length} mapped variants resolve in Shopify`);
  console.log(`variant ${variant.id}\n  -> ${variant.shopifyVariantGid}`);
  console.log(`  original isLuxurySteal = ${variant.isLuxurySteal}\n`);

  const { admin } = await unauthenticated.admin(SHOP);
  const port = new ShopifyLuxuryStealMetafieldSyncPort(admin);

  const readBack = async () => {
    const response = await admin.graphql(READ_BACK, {
      variables: { id: variant.shopifyVariantGid },
    });
    const body = (await response.json()) as {
      errors?: unknown;
      data?: {
        productVariant?: {
          id?: string;
          metafield?: { type?: string; value?: string; ownerType?: string } | null;
        } | null;
      };
    };
    // Every Admin API failure arrives on HTTP 200 — a top-level `errors` is
    // how a coerced or rejected query reports itself, so it is checked before
    // anything is read out of `data`.
    if (body.errors) {
      throw new Error(`read-back query returned errors: ${JSON.stringify(body.errors)}`);
    }
    return body.data?.productVariant ?? null;
  };

  const originalAssignment = variant.isLuxurySteal;

  try {
    console.log("1. assign + sync");
    await setLuxuryStealAssignment(variant.id, true);
    const assigned = await syncLuxuryStealAssignment(variant.id, {
      port,
      trigger: "live-gate:slice3-stage1",
    });
    assert(assigned.kind === "synced", `sync reports success (got kind=${assigned.kind})`);

    const afterAssign = await readBack();
    assert(afterAssign !== null, "Shopify still resolves the variant");
    assert(
      afterAssign?.id === variant.shopifyVariantGid,
      "metafield was read back from the EXPECTED variant, not merely a variant"
    );
    assert(afterAssign?.metafield != null, "metafield exists on the variant after sync");
    assert(
      afterAssign?.metafield?.ownerType === "PRODUCTVARIANT",
      `ownerType is PRODUCTVARIANT (got ${afterAssign?.metafield?.ownerType}) — D27 requires variant grain`
    );
    assert(
      afterAssign?.metafield?.type === "boolean",
      `stored type is boolean (got ${afterAssign?.metafield?.type}) — a text field would be truthy in Liquid even when "false"`
    );
    assert(
      afterAssign?.metafield?.value === "true",
      `stored value is exactly "true" (got ${JSON.stringify(afterAssign?.metafield?.value)})`
    );

    console.log("\n2. unassign + sync — criterion 128 writes an explicit false, not a delete");
    await setLuxuryStealAssignment(variant.id, false);
    const unassigned = await syncLuxuryStealAssignment(variant.id, {
      port,
      trigger: "live-gate:slice3-stage1",
    });
    assert(unassigned.kind === "synced", `unassign sync reports success (got kind=${unassigned.kind})`);

    const afterUnassign = await readBack();
    assert(
      afterUnassign?.metafield != null,
      "metafield still EXISTS after unassignment — a deleted field is indistinguishable from never-synced"
    );
    assert(
      afterUnassign?.metafield?.value === "false",
      `stored value is exactly "false" (got ${JSON.stringify(afterUnassign?.metafield?.value)})`
    );

    console.log("\nSTAGE 1 PASSED — Shopify stores a real boolean on the real variant.");
    console.log("Still unproven (F-3-1 … F-3-5): storefront rendering, the gate,");
    console.log("variant-change reset, and the order-time evidence path.");
  } finally {
    console.log("\nrestoring original state");
    await setLuxuryStealAssignment(variant.id, originalAssignment);
    await syncLuxuryStealAssignment(variant.id, {
      port,
      trigger: "live-gate:slice3-stage1-restore",
    }).catch((error) => {
      // Reported, never swallowed: leaving the store in a state this harness
      // created would be worse than the harness failing loudly.
      console.error("  RESTORE SYNC FAILED — check the variant by hand:", error);
    });
    console.log(`  isLuxurySteal restored to ${originalAssignment}`);
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("\n", error);
  process.exit(1);
});
