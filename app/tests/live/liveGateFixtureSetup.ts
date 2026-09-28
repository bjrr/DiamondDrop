/**
 * LIVE GATE FIXTURE SETUP — creates the purpose-built, NON-PUBLIC test product
 * the Slice 5 and Slice 6 live gates need, and prints the ids to put in `.env`.
 *
 * WHY A SCRIPT RATHER THAN CLICKING. The owner's requirement is "test variants
 * only ... do not use anything intended for customers". A product created by
 * hand is one someone can later mistake for a real one; a product created here
 * is named, tagged and left UNPUBLISHED deliberately, and this file is the
 * record of exactly what it is and how to remove it.
 *
 * NON-PUBLIC IS THE POINT. The product is created with `status: DRAFT` and is
 * published to NO sales channel, so it cannot be reached by a customer, cannot
 * be searched, and cannot be added to a cart from the storefront. The live
 * gates reach its variant only through the Admin API, which does not care
 * about publication state.
 *
 * SAFE TO RE-RUN: each run creates a NEW product with a fresh timestamped
 * handle rather than mutating an existing one, so it can never silently
 * repoint a gate at something that has since been edited.
 *
 * RUN: npx tsx tests/live/liveGateFixtureSetup.ts
 */
import "dotenv/config";

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN!;

type AdminGraphql = (query: string, options?: { variables?: object }) => Promise<Response>;

async function gql<T>(admin: { graphql: AdminGraphql }, query: string, variables?: object): Promise<T> {
  const response = await admin.graphql(query, variables ? { variables } : undefined);
  const body = (await response.json()) as { data?: T; errors?: unknown };
  // Shopify returns HTTP 200 for failures too — top-level `errors` for a bad
  // query, `userErrors` per mutation. Checking response.ok proves nothing.
  if (body.errors) throw new Error(`GraphQL errors: ${JSON.stringify(body.errors)}`);
  if (!body.data) throw new Error("GraphQL response carried no data");
  return body.data;
}

const PRODUCT_CREATE = `
  mutation CaratLiveGateProduct($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product { id title handle status variants(first: 1) { nodes { id title } } }
      userErrors { field message }
    }
  }
`;

const VARIANT_UPDATE = `
  mutation CaratLiveGateVariantPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id price }
      userErrors { field message }
    }
  }
`;

async function main() {
  if (!SHOP) throw new Error("SHOPIFY_SHOP_DOMAIN must be set");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  console.log(`Creating a NON-PUBLIC live-gate test product on ${SHOP}\n`);

  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(SHOP);

  const created = await gql<{
    productCreate: {
      product: {
        id: string;
        title: string;
        handle: string;
        status: string;
        variants: { nodes: { id: string; title: string }[] };
      } | null;
      userErrors: { field: string[]; message: string }[];
    };
  }>(admin, PRODUCT_CREATE, {
    product: {
      title: `ZZ LIVE GATE TEST — DO NOT SELL (${stamp})`,
      handle: `carat-live-gate-test-${stamp}`.toLowerCase(),
      // DRAFT and unpublished: unreachable from the storefront.
      status: "DRAFT",
      tags: ["carat-live-gate", "do-not-sell"],
      productType: "Live Gate Fixture",
      vendor: "CaratForUs Internal",
    },
  });

  if (created.productCreate.userErrors.length) {
    throw new Error(`productCreate: ${JSON.stringify(created.productCreate.userErrors)}`);
  }
  const product = created.productCreate.product!;
  const variant = product.variants.nodes[0];
  if (!variant) throw new Error("product was created with no default variant — cannot proceed");

  // A nonzero price, so a draft order against it completes normally rather
  // than tripping any zero-value edge case in Shopify's own order flow.
  const priced = await gql<{
    productVariantsBulkUpdate: {
      productVariants: { id: string; price: string }[];
      userErrors: { field: string[]; message: string }[];
    };
  }>(admin, VARIANT_UPDATE, {
    productId: product.id,
    variants: [{ id: variant.id, price: "1.00" }],
  });
  if (priced.productVariantsBulkUpdate.userErrors.length) {
    throw new Error(`productVariantsBulkUpdate: ${JSON.stringify(priced.productVariantsBulkUpdate.userErrors)}`);
  }

  console.log("CREATED (status DRAFT, published to no sales channel):");
  console.log(`  product: ${product.id}`);
  console.log(`  title:   ${product.title}`);
  console.log(`  status:  ${product.status}`);
  console.log(`  variant: ${variant.id}`);
  console.log(`  price:   ${priced.productVariantsBulkUpdate.productVariants[0]?.price}`);
  console.log("\nAdd this line to app/.env:");
  console.log(`CARAT_LIVE_GATE_VARIANT_GID=${variant.id}`);
  console.log("\nTo remove afterwards: Shopify admin -> Products -> filter tag `carat-live-gate` -> delete.");
}

main().catch((error) => {
  console.error("\n", error);
  process.exitCode = 1;
});
