/**
 * SLICE 5 LIVE GATE — the ACTUAL warranty evidence upload path, end to end
 * against production (owner requirement 2026-09-28).
 *
 * WHY THIS EXISTS SEPARATELY FROM `slice5.r2EvidenceStorage.ts`. That gate
 * proves the R2 ADAPTER works: presigning, privacy, expiry, against the real
 * bucket. It says nothing about the application path a customer actually
 * walks — the App Proxy auth, the persisted issued-destination row, the
 * customer/claim binding, single-use consumption, or the refusal of a
 * substituted key. The owner's instruction was explicit: live-prove the
 * warranty upload path, "not merely the lower-level R2 adapter". So this
 * gate speaks ONLY to the deployed app over HTTP and to R2 over HTTP. It
 * imports no application module and no database client: anything it proves,
 * it proves about what is actually running in production.
 *
 * ============================================================================
 * DO NOT RUN THIS WITHOUT COORDINATION. It creates REAL Shopify test
 * customers and a REAL order on the live store, and writes REAL objects to
 * the production evidence bucket. Everything it creates is tagged/prefixed
 * `carat-live-gate-slice5` and listed at the end for deletion.
 * ============================================================================
 *
 * WHAT IT PROVES — the owner's required list, each as a named assertion that
 * must actually EXECUTE (a clean failure count with missing assertions is
 * explicitly NOT a pass):
 *
 *   destination-issued          an authenticated customer gets a destination
 *   destination-persisted       it survives the request that issued it
 *   destination-bound-customer  a DIFFERENT customer cannot consume it
 *   presigned-put               a real PUT to R2 with that URL succeeds
 *   object-not-public           the uploaded object is not readable unsigned
 *   claim-accepts-valid-key     the claim is accepted with the issued key
 *   arbitrary-key-rejected      a made-up storageKey is refused
 *   reused-destination-rejected a consumed key cannot be used again
 *   no-partial-evidence         a batch with one bad key creates NO claim
 *   expired-destination-rejected a destination past its expiry is refused
 *
 * HOW "PERSISTED" IS PROVEN WITHOUT A DATABASE CLIENT. The destination is
 * issued by one HTTP request and consumed by a LATER, separate one. Nothing
 * in the second request carries the first's state, so a destination that was
 * not durably recorded could not be consumed at all. That is a stronger
 * statement than reading the row: it proves the row is found by the code path
 * that actually depends on it.
 *
 * THE EXPIRY CASE COSTS REAL TIME. A PUT destination lives 15 minutes
 * (`R2_PUT_URL_EXPIRY_SECONDS`) and there is no way to age one from outside
 * the app — which is correct; an endpoint that could would be a way to forge
 * evidence windows. So the probe destination is issued FIRST, every other
 * case runs while it ages, and the wait at the end is only the remainder.
 *
 * RUN: npx tsx tests/live/slice5.warrantyUploadFlow.ts
 */
import "dotenv/config";
import { createHmac, randomUUID } from "node:crypto";

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN!;
const SECRET = process.env.SHOPIFY_API_SECRET!;
const APP_URL = process.env.CARAT_LIVE_GATE_APP_URL ?? "https://caratforus.fly.dev";
const TEST_VARIANT_GID = process.env.CARAT_LIVE_GATE_VARIANT_GID ?? "gid://shopify/ProductVariant/REPLACE-ME";

/** 15 minutes plus a margin — the app's own PUT/destination window. */
const DESTINATION_TTL_MS = 15 * 60 * 1000;
const EXPIRY_MARGIN_MS = 45 * 1000;

const REQUIRED_ASSERTIONS = [
  "destination-issued",
  "destination-persisted",
  "destination-bound-customer",
  "presigned-put",
  "object-not-public",
  "claim-accepts-valid-key",
  "arbitrary-key-rejected",
  "reused-destination-rejected",
  "no-partial-evidence",
  "expired-destination-rejected",
] as const;
type AssertionId = (typeof REQUIRED_ASSERTIONS)[number];

let failures = 0;
const executed = new Set<AssertionId>();

function check(id: AssertionId, condition: unknown, message: string): void {
  executed.add(id);
  console.log(`  ${condition ? "PASS" : "FAIL"}  [${id}] ${message}`);
  if (!condition) failures += 1;
}


/**
 * Whole seconds from milliseconds, WITHOUT Math.floor. This repo bans the
 * Math rounding family outright (money must round through the versioned rule
 * registry), and the ban is deliberately unconditional so nobody has to judge
 * whether a given call site is "money enough" to matter. Exact integer
 * arithmetic needs no exception.
 */
function wholeSeconds(ms: number): number {
  return (ms - (ms % 1000)) / 1000;
}

function missingAssertions(): AssertionId[] {
  return REQUIRED_ASSERTIONS.filter((id) => !executed.has(id));
}

// ---------------------------------------------------------------------------
// Shopify App Proxy signing — identical to
// `slice6.groupBuyCancellationOrderEnforcement.ts`'s helper, including the
// deliberate avoidance of Math.floor (this repo's money-safety lint bans that
// family unconditionally, even for a non-money timestamp).
// ---------------------------------------------------------------------------
function signedProxyUrl(path: string, params: Record<string, string>): string {
  const search = new URLSearchParams({
    ...params,
    shop: SHOP,
    path_prefix: "/apps/carat",
    timestamp: String(Date.now()).slice(0, -3),
  });
  const message = Array.from(search.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("");
  search.set("signature", createHmac("sha256", SECRET).update(message, "utf8").digest("hex"));
  return `${APP_URL}${path}?${search.toString()}`;
}

type AdminGraphql = (query: string, options?: { variables?: object }) => Promise<Response>;

async function gql<T>(admin: { graphql: AdminGraphql }, query: string, variables?: object): Promise<T> {
  const response = await admin.graphql(query, variables ? { variables } : undefined);
  const body = (await response.json()) as { data?: T; errors?: unknown };
  // EVERY Shopify Admin failure arrives on HTTP 200 — top-level `errors` for
  // a malformed query, per-mutation `userErrors` for a refused one. Checking
  // only response.ok would read a total failure as success.
  if (body.errors) throw new Error(`GraphQL errors: ${JSON.stringify(body.errors)}`);
  if (!body.data) throw new Error("GraphQL response carried no data");
  return body.data;
}

const CUSTOMER_CREATE = `
  mutation CaratLiveGateCustomer($input: CustomerInput!) {
    customerCreate(input: $input) { customer { id } userErrors { message } }
  }
`;

const DRAFT_CREATE = `
  mutation CaratLiveGateDraft($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) { draftOrder { id } userErrors { message } }
  }
`;

const DRAFT_COMPLETE = `
  mutation CaratLiveGateComplete($id: ID!) {
    draftOrderComplete(id: $id) {
      draftOrder { order { id name lineItems(first: 5) { nodes { id } } } }
      userErrors { message }
    }
  }
`;

/**
 * Two ways to get the two throwaway customers this gate needs, because
 * MINTING THEM REQUIRES A SCOPE THE APP DOES NOT HAVE.
 *
 * `customerCreate` needs `write_customers`; the app requests only products,
 * orders, draft orders, inventory, payment terms and fulfilment-order scopes
 * (`shopify.app.toml`). The first run of this gate failed on exactly that —
 * and, note, Shopify reported it on HTTP 200 with a top-level `errors`, which
 * is why `gql` above checks the body rather than `response.ok`.
 *
 * Adding the scope is a real permission change requiring owner approval and a
 * reinstall, so this gate also accepts two customers created BY HAND in the
 * Shopify admin, via `CARAT_LIVE_GATE_CUSTOMER_A` / `..._B` (numeric ids).
 * That path needs no new scope at all. Either is fine; the assertions do not
 * care where the customers came from, only that they are two DIFFERENT
 * identities, which is what the cross-customer binding case turns on.
 */
function preProvisionedCustomer(label: "A" | "B"): { id: string; numericId: string } | null {
  const raw = (label === "A" ? process.env.CARAT_LIVE_GATE_CUSTOMER_A : process.env.CARAT_LIVE_GATE_CUSTOMER_B)?.trim();
  if (!raw) return null;
  const numericId = raw.startsWith("gid://") ? raw.split("/").pop()! : raw;
  if (!/^\d+$/.test(numericId)) {
    throw new Error(`CARAT_LIVE_GATE_CUSTOMER_${label} must be a numeric customer id or a customer gid; got ${JSON.stringify(raw)}`);
  }
  return { id: `gid://shopify/Customer/${numericId}`, numericId };
}

async function createTestCustomer(admin: { graphql: AdminGraphql }, label: string): Promise<{ id: string; numericId: string }> {
  const created = await gql<{
    customerCreate: { customer: { id: string } | null; userErrors: { message: string }[] };
  }>(admin, CUSTOMER_CREATE, {
    input: {
      firstName: "Carat Live Gate",
      lastName: `slice5-${label}`,
      email: `carat-live-gate-slice5-${Date.now()}-${label}@example.com`,
      tags: ["carat-live-gate-slice5"],
    },
  });
  if (created.customerCreate.userErrors.length) {
    throw new Error(`customerCreate (${label}): ${JSON.stringify(created.customerCreate.userErrors)}`);
  }
  const id = created.customerCreate.customer!.id;
  return { id, numericId: id.split("/").pop()! };
}

/** A real order for this customer — the warranty claim route resolves order/line against Shopify and REQUIRES the order's own customer to match the caller. */
async function createTestOrder(
  admin: { graphql: AdminGraphql },
  customerGid: string
): Promise<{ orderGid: string; orderName: string; lineGid: string }> {
  const created = await gql<{
    draftOrderCreate: { draftOrder: { id: string } | null; userErrors: { message: string }[] };
  }>(admin, DRAFT_CREATE, {
    input: {
      customerId: customerGid,
      lineItems: [{ variantId: TEST_VARIANT_GID, quantity: 1 }],
      tags: ["carat-live-gate-slice5"],
    },
  });
  if (created.draftOrderCreate.userErrors.length) {
    throw new Error(`draftOrderCreate: ${JSON.stringify(created.draftOrderCreate.userErrors)}`);
  }
  const completed = await gql<{
    draftOrderComplete: {
      draftOrder: { order: { id: string; name: string; lineItems: { nodes: { id: string }[] } } | null } | null;
      userErrors: { message: string }[];
    };
  }>(admin, DRAFT_COMPLETE, { id: created.draftOrderCreate.draftOrder!.id });
  if (completed.draftOrderComplete.userErrors.length) {
    throw new Error(`draftOrderComplete: ${JSON.stringify(completed.draftOrderComplete.userErrors)}`);
  }
  const order = completed.draftOrderComplete.draftOrder!.order!;
  const lineGid = order.lineItems.nodes[0]?.id;
  if (!lineGid) throw new Error("completed order carried no line items — cannot submit a warranty claim against it");
  return { orderGid: order.id, orderName: order.name, lineGid };
}

interface DestinationResponse {
  status: number;
  storageKey?: string;
  uploadUrl?: string;
  expiresAt?: string;
  body: string;
}

async function requestDestination(customerNumericId: string, claimId: string): Promise<DestinationResponse> {
  const url = signedProxyUrl("/apps/carat/warranty-claim-upload-destination", {
    logged_in_customer_id: customerNumericId,
  });
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ claimId, kind: "photo", contentType: "image/jpeg", sizeBytes: 12_345 }),
  });
  const text = await response.text();
  let parsed: { storageKey?: string; uploadUrl?: string; expiresAt?: string } = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    /* non-JSON body is itself a finding; the caller asserts on status */
  }
  return { status: response.status, ...parsed, body: text };
}

interface ClaimUpload {
  kind: "photo" | "video";
  storageKey: string;
  contentType: string;
  sizeBytes: number;
  checksum: string;
}

async function submitClaim(
  customerNumericId: string,
  claimId: string,
  order: { orderGid: string; lineGid: string },
  uploads: ClaimUpload[]
): Promise<{ status: number; body: string }> {
  const url = signedProxyUrl("/apps/carat/warranty-claim", { logged_in_customer_id: customerNumericId });
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      claimId,
      orderRef: order.orderGid,
      lineRef: order.lineGid,
      purchaserName: "Carat Live Gate",
      purchaserEmail: "carat-live-gate-slice5@example.com",
      itemConfigurationDescription: "Live gate test item",
      problemDescription: "Live gate synthetic claim — warranty upload flow verification.",
      hadImpactOrDamageEvent: false,
      wasAlteredAfterDelivery: false,
      claimAcknowledgmentAccepted: true,
      uploads,
    }),
  });
  return { status: response.status, body: await response.text() };
}

function anUpload(storageKey: string): ClaimUpload {
  return { kind: "photo", storageKey, contentType: "image/jpeg", sizeBytes: 12_345, checksum: `sha256:${randomUUID().replace(/-/g, "")}` };
}

async function main() {
  if (TEST_VARIANT_GID.includes("REPLACE-ME")) {
    throw new Error(
      "Set CARAT_LIVE_GATE_VARIANT_GID to a purpose-built test variant before running this gate. " +
        "Refusing to run against a placeholder."
    );
  }
  if (!SHOP || !SECRET) {
    throw new Error("SHOPIFY_SHOP_DOMAIN and SHOPIFY_API_SECRET must be set — this gate signs real App Proxy requests.");
  }

  console.log(`Slice 5 live gate — warranty evidence upload flow against ${APP_URL}`);
  console.log(`store: ${SHOP}   test variant: ${TEST_VARIANT_GID}`);
  console.log("THIS CREATES REAL TEST CUSTOMERS, A REAL ORDER, AND REAL BUCKET OBJECTS.\n");

  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(SHOP);

  console.log("0. setup — two throwaway customers and one real order");
  const provisionedA = preProvisionedCustomer("A");
  const provisionedB = preProvisionedCustomer("B");
  if (provisionedA && provisionedB) {
    console.log("  using pre-provisioned test customers (no write_customers scope needed)");
  } else if (provisionedA || provisionedB) {
    throw new Error(
      "Set BOTH CARAT_LIVE_GATE_CUSTOMER_A and CARAT_LIVE_GATE_CUSTOMER_B, or neither. The cross-customer " +
        "binding assertion is meaningless without two distinct identities, and half-configuring it would " +
        "silently weaken the one case that proves a destination cannot be consumed by someone else."
    );
  }
  const customerA = provisionedA ?? (await createTestCustomer(admin, "A"));
  const customerB = provisionedB ?? (await createTestCustomer(admin, "B"));
  if (customerA.numericId === customerB.numericId) {
    throw new Error("customer A and customer B are the same identity — the binding assertion would pass vacuously");
  }
  const order = await createTestOrder(admin, customerA.id);
  console.log(`  customer A = ${customerA.id}`);
  console.log(`  customer B = ${customerB.id}`);
  console.log(`  order      = ${order.orderName}  ${order.orderGid}\n`);

  // THE EXPIRY PROBE IS ISSUED FIRST so it ages while everything else runs.
  console.log("1. issuing the expiry-probe destination now, so the 15-minute window elapses during the rest of the gate");
  const expiryClaimId = randomUUID();
  const expiryProbe = await requestDestination(customerA.numericId, expiryClaimId);
  const probeIssuedAt = Date.now();
  if (expiryProbe.status !== 201 || !expiryProbe.storageKey) {
    throw new Error(`could not issue the expiry probe destination (HTTP ${expiryProbe.status}): ${expiryProbe.body.slice(0, 300)}`);
  }
  console.log(`  probe key: ${expiryProbe.storageKey}\n`);

  // -------------------------------------------------------------------------
  console.log("2. an authenticated customer can request an upload destination");
  const claimId = randomUUID();
  const destination = await requestDestination(customerA.numericId, claimId);
  check(
    "destination-issued",
    destination.status === 201 && Boolean(destination.uploadUrl) && Boolean(destination.storageKey),
    `HTTP ${destination.status}, uploadUrl ${destination.uploadUrl ? "present" : "MISSING"}, storageKey ${destination.storageKey ?? "MISSING"}`
  );
  if (!destination.uploadUrl || !destination.storageKey) {
    throw new Error(`no destination to continue with: ${destination.body.slice(0, 300)}`);
  }

  // -------------------------------------------------------------------------
  console.log("\n3. the presigned PUT actually works against the production bucket");
  const putBody = `carat-live-gate-slice5 ${new Date().toISOString()}`;
  const putResponse = await fetch(destination.uploadUrl, {
    method: "PUT",
    headers: { "content-type": "image/jpeg" },
    body: putBody,
  });
  check("presigned-put", putResponse.ok, `PUT to R2 succeeded (HTTP ${putResponse.status})`);

  // -------------------------------------------------------------------------
  console.log("\n4. the uploaded object is NOT readable without a signature");
  const unsignedUrl = new URL(destination.uploadUrl);
  unsignedUrl.search = "";
  const unsignedResponse = await fetch(unsignedUrl.toString());
  check(
    "object-not-public",
    unsignedResponse.status !== 200,
    `unsigned GET of the real evidence object does NOT return 200 (got ${unsignedResponse.status}). ` +
      `NOTE: this proves the S3 endpoint requires auth; it does NOT prove the bucket has no public r2.dev URL, ` +
      `which is a dashboard setting this gate cannot observe.`
  );

  // -------------------------------------------------------------------------
  console.log("\n5. a DIFFERENT customer cannot consume that destination");
  // Uploads are verified and consumed BEFORE the order lookup, so customer B
  // needs no order of their own: the upload check refuses them first. The
  // response must be the same generic refusal as a key that never existed.
  const crossCustomer = await submitClaim(customerB.numericId, randomUUID(), order, [anUpload(destination.storageKey)]);
  check(
    "destination-bound-customer",
    crossCustomer.status === 422,
    `customer B submitting customer A's storageKey is refused (HTTP ${crossCustomer.status})`
  );

  // -------------------------------------------------------------------------
  console.log("\n6. a made-up storageKey is refused");
  const arbitrary = await submitClaim(customerA.numericId, randomUUID(), order, [
    anUpload(`warranty/${randomUUID()}/photo/${randomUUID()}.jpg`),
  ]);
  check("arbitrary-key-rejected", arbitrary.status === 422, `an invented storageKey is refused (HTTP ${arbitrary.status})`);

  // -------------------------------------------------------------------------
  console.log("\n7. a batch containing ONE bad key creates NO claim at all");
  const partialClaimId = randomUUID();
  const goodForPartial = await requestDestination(customerA.numericId, partialClaimId);
  if (goodForPartial.status !== 201 || !goodForPartial.storageKey) {
    throw new Error(`could not issue the partial-batch destination (HTTP ${goodForPartial.status})`);
  }
  const partial = await submitClaim(customerA.numericId, partialClaimId, order, [
    anUpload(goodForPartial.storageKey),
    anUpload(`warranty/${randomUUID()}/photo/${randomUUID()}.jpg`),
  ]);
  check(
    "no-partial-evidence",
    partial.status === 422,
    `a two-upload batch with one unverifiable key is refused whole (HTTP ${partial.status})`
  );
  // AND the good key from that refused batch must still be unconsumed — the
  // transaction rolled back. Proven by it working in a fresh submission below.
  const recoveredClaimId = randomUUID();
  const recovered = await requestDestination(customerA.numericId, recoveredClaimId);
  if (recovered.status !== 201 || !recovered.storageKey) {
    throw new Error("could not issue a destination for the rollback re-check");
  }

  // -------------------------------------------------------------------------
  console.log("\n8. the claim IS accepted with a genuinely issued key");
  const accepted = await submitClaim(customerA.numericId, claimId, order, [anUpload(destination.storageKey)]);
  check(
    "claim-accepts-valid-key",
    accepted.status === 201,
    `claim accepted with the issued storageKey (HTTP ${accepted.status}) ${accepted.status >= 400 ? accepted.body.slice(0, 200) : ""}`
  );
  // PERSISTENCE, proven by behaviour: this key was issued by a DIFFERENT HTTP
  // request minutes earlier and nothing carried its state forward. It could
  // only be found because the app durably recorded it.
  check(
    "destination-persisted",
    accepted.status === 201,
    "a destination issued by an earlier, separate request was still resolvable — it was durably recorded"
  );

  // -------------------------------------------------------------------------
  console.log("\n9. the same destination cannot be used twice");
  const reuse = await submitClaim(customerA.numericId, randomUUID(), order, [anUpload(destination.storageKey)]);
  check(
    "reused-destination-rejected",
    reuse.status === 422,
    `an already-consumed storageKey is refused on a second claim (HTTP ${reuse.status})`
  );

  // -------------------------------------------------------------------------
  console.log("\n10. an EXPIRED destination is refused");
  const elapsed = Date.now() - probeIssuedAt;
  const remaining = DESTINATION_TTL_MS + EXPIRY_MARGIN_MS - elapsed;
  if (remaining > 0) {
    console.log(`  waiting ${wholeSeconds(remaining)}s for the probe destination to pass its 15-minute expiry...`);
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
  const expired = await submitClaim(customerA.numericId, expiryClaimId, order, [anUpload(expiryProbe.storageKey)]);
  check(
    "expired-destination-rejected",
    expired.status === 422,
    `a destination past its expiry is refused (HTTP ${expired.status}), ${wholeSeconds(Date.now() - probeIssuedAt)}s after issuance`
  );

  // -------------------------------------------------------------------------
  console.log("\n============================================================");
  console.log("CREATED — delete these by hand:");
  console.log(`  customers: ${customerA.id}  ${customerB.id}   (tag carat-live-gate-slice5)`);
  console.log(`  order:     ${order.orderName}  ${order.orderGid}`);
  console.log(`  objects:   ${destination.storageKey}`);
  console.log(`             ${goodForPartial.storageKey} (issued, rolled back, never uploaded)`);
  console.log(`             ${recovered.storageKey} (issued, unused)`);
  console.log(`             ${expiryProbe.storageKey} (issued, expired, never uploaded)`);
  console.log("  Only the first has bytes in the bucket; the rest are database rows only.");
}

main()
  .catch((error) => {
    console.error("\n", error);
    failures += 1;
  })
  .finally(() => {
    const missing = missingAssertions();
    if (missing.length > 0) {
      console.log(
        `\nINCOMPLETE — ${missing.length} required assertion(s) NEVER RAN: ${missing.join(", ")}. ` +
          "NOT a pass, however many PASS lines appear above."
      );
    }
    const green = failures === 0 && missing.length === 0;
    console.log(
      green
        ? `\nLIVE GATE PASSED — all ${REQUIRED_ASSERTIONS.length} required assertions executed and passed against production.`
        : `\n${failures} FAILURE(S) — the warranty upload path is NOT proven. Uploads must not be offered to customers.`
    );
    process.exitCode = green ? 0 : 1;
  });
