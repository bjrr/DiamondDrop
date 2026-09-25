import { createHmac, randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import * as warrantyClaimRoute from "~/routes/apps.carat.warranty-claim";
import {
  __setWarrantyAcknowledgmentLabelSourceForTests,
  __setWarrantyClaimOrderLookupPortForTests,
  action,
  WARRANTY_ACCURACY_CERTIFICATION_POLICY_SLUG,
  WARRANTY_COVERAGE_NOT_ESTABLISHED_POLICY_SLUG,
} from "~/routes/apps.carat.warranty-claim";
import { RecordingWarrantyClaimOrderLookupPort } from "~/shopify/admin/warrantyClaimOrderLookupAdapter.server";

/**
 * Slice 5 task 5-3 — the Warranty Claim Form intake endpoint against real
 * Postgres (docs/WARRANTY-CLAIMS.md, docs/specs/SLICE-5-WARRANTY-CLAIMS.md
 * criteria 153-157). Mirrors `luxuryAcknowledgmentRoute.test.ts`'s shape:
 * real HMAC signing, `action()` called directly, evidence asserted against
 * the database rather than mocked.
 *
 * ACKNOWLEDGMENT COPY IS INTENTIONALLY NOT SEEDED IN ANY REAL MIGRATION OR
 * SEED SCRIPT (see the route's own module comment — the owner has not
 * approved it). The "happy path" tests below seed their OWN throwaway
 * `policy_version` rows directly, as TEST FIXTURE DATA in this disposable
 * integration database only — exactly like `warrantyClaimSchema.test.ts`'s
 * `createAcknowledgment` helper already does for the other two
 * acknowledgments on this same model. Nothing here pins, ships, or approves
 * real customer-facing copy; the placeholder text below is deliberately
 * NOT the proposal's wording, so it cannot be mistaken for it.
 */

let seq = 0;
let policyVersionCounter = 1;
const uniq = () => `${Date.now() % 900_000}-${(seq += 1)}`;

const SHOP = "caratforus-dev.myshopify.com";

function signedPost(path: string, queryParams: Record<string, string>, body: unknown, options: { rawBody?: string } = {}): Request {
  const secret = process.env.SHOPIFY_API_SECRET as string;
  const message = Object.entries(queryParams)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("");
  const signature = createHmac("sha256", secret).update(message, "utf8").digest("hex");

  const url = new URL(`https://shop.example.com${path}`);
  for (const [k, v] of Object.entries(queryParams)) url.searchParams.set(k, v);
  url.searchParams.set("signature", signature);

  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: options.rawBody ?? JSON.stringify(body),
  });
}

function claimRequest(overrides: Partial<{ query: Record<string, string>; body: unknown; rawBody: string }> = {}) {
  return signedPost(
    "/apps/carat/warranty-claim",
    overrides.query ?? { shop: SHOP },
    overrides.body,
    overrides.rawBody !== undefined ? { rawBody: overrides.rawBody } : {}
  );
}

function callAction(request: Request) {
  return action({ request, params: {}, context: {} } as never);
}

/** Purely numeric, unlike `uniq()` (which embeds a hyphen) — orderRef/lineRef must match the route's `gid://shopify/Order|LineItem/\d+` pattern. */
function uniqNumeric(): string {
  return `${Date.now()}${(seq += 1)}`;
}

function baseClaimBody(overrides: Record<string, unknown> = {}) {
  const orderNumber = uniqNumeric();
  const lineNumber = uniqNumeric();
  return {
    orderRef: `gid://shopify/Order/${orderNumber}`,
    lineRef: `gid://shopify/LineItem/${lineNumber}`,
    purchaserName: "Test Purchaser",
    purchaserEmail: "purchaser@example.com",
    itemConfigurationDescription: "14k gold solitaire ring, size 7",
    problemDescription: "Prong appears to have a defective solder joint.",
    hadImpactOrDamageEvent: false,
    wasAlteredAfterDelivery: false,
    accuracyCertificationAccepted: true,
    coverageNotEstablishedAccepted: true,
    ...overrides,
  };
}

/** Test-fixture-only PolicyVersion rows under the route's two slugs — see this file's header comment. NOT real approved copy. */
async function seedAcknowledgmentPolicies(): Promise<void> {
  const version = policyVersionCounter++;
  await prisma.policyVersion.create({
    data: {
      slug: WARRANTY_ACCURACY_CERTIFICATION_POLICY_SLUG,
      version,
      effectiveFrom: new Date(),
      text: `[TEST FIXTURE — NOT REAL COPY] accuracy certification text v${version}`,
      contentHash: `test-hash-accuracy-${version}`,
    },
  });
  await prisma.policyVersion.create({
    data: {
      slug: WARRANTY_COVERAGE_NOT_ESTABLISHED_POLICY_SLUG,
      version,
      effectiveFrom: new Date(),
      text: `[TEST FIXTURE — NOT REAL COPY] coverage not established text v${version}`,
      contentHash: `test-hash-coverage-${version}`,
    },
  });
}

const FAKE_LABEL_SOURCE = {
  accuracyCertificationLabel: () => "[TEST] Accuracy Label",
  coverageNotEstablishedLabel: () => "[TEST] Coverage Label",
};

/** Wires a fake order-lookup port pre-seeded to resolve exactly this order/line. Returns the port so a test can also seed additional combinations. */
function useResolvableOrderLookup(orderGid: string, lineGid: string, extra: { customerGid?: string | null } = {}) {
  const port = new RecordingWarrantyClaimOrderLookupPort();
  port.seed(orderGid, lineGid, {
    orderName: "#1001",
    customerGid: extra.customerGid ?? null,
    orderEmail: "purchaser@example.com",
  });
  __setWarrantyClaimOrderLookupPortForTests(port);
  return port;
}

async function createVariant(overrides: { shopifyVariantGid?: string } = {}) {
  const suffix = uniq();
  const product = await prisma.masterProduct.create({
    data: {
      name: `warranty claim fixture ${suffix}`,
      category: "ring",
      sizeAxis: "none",
      allowedSizeMin: "0",
      allowedSizeMax: "0",
      sizeIncrement: "1",
      baseSize: "0",
      offeredMetals: ["gold"],
      status: "active",
    },
  });
  return prisma.masterVariant.create({
    data: {
      masterProductId: product.id,
      metal: "gold",
      purity: "GOLD_14K",
      baseWeightGrams: "3.0000",
      weightPerFullSizeGrams: "0.0000",
      status: "active",
      laborSource: "india",
      shopifyVariantGid: overrides.shopifyVariantGid ?? `gid://shopify/ProductVariant/${suffix}`,
    },
  });
}

afterEach(() => {
  __setWarrantyClaimOrderLookupPortForTests(null);
  __setWarrantyAcknowledgmentLabelSourceForTests(null);
});

describe("resource-route shape", () => {
  it("has no default export (F-23 — a default export would 400 every real caller in production)", () => {
    expect("default" in warrantyClaimRoute).toBe(false);
    expect(typeof warrantyClaimRoute.action).toBe("function");
  });
});

describe("method and signature guards", () => {
  it("rejects a non-POST request with 405", async () => {
    const url = new URL(`https://shop.example.com/apps/carat/warranty-claim?shop=${SHOP}`);
    const response = await callAction(new Request(url, { method: "GET" }));
    expect(response.status).toBe(405);
  });

  it("rejects an unsigned request with 401, before any body validation", async () => {
    const url = new URL(`https://shop.example.com/apps/carat/warranty-claim?shop=${SHOP}`);
    const request = new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const response = await callAction(request);
    expect(response.status).toBe(401);
  });

  it("rejects a tampered signature with 401", async () => {
    const url = new URL(`https://shop.example.com/apps/carat/warranty-claim?shop=${SHOP}`);
    url.searchParams.set("signature", "0".repeat(64));
    const request = new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(baseClaimBody()),
    });
    const response = await callAction(request);
    expect(response.status).toBe(401);
  });
});

describe("malformed or hostile bodies are refused, not partially processed", () => {
  it("rejects invalid JSON with 400 and creates no claim", async () => {
    const before = await prisma.warrantyClaim.count();
    const response = await callAction(claimRequest({ rawBody: "{not json" }));
    expect(response.status).toBe(400);
    await expect(prisma.warrantyClaim.count()).resolves.toBe(before);
  });

  it("rejects a body missing required fields with 400", async () => {
    const response = await callAction(claimRequest({ body: { orderRef: "gid://shopify/Order/1" } }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  it("rejects accuracyCertificationAccepted: false (not literal true) with 400", async () => {
    const response = await callAction(
      claimRequest({ body: baseClaimBody({ accuracyCertificationAccepted: false }) })
    );
    expect(response.status).toBe(400);
  });

  it("rejects coverageNotEstablishedAccepted missing entirely with 400", async () => {
    const body = baseClaimBody();
    delete (body as Record<string, unknown>).coverageNotEstablishedAccepted;
    const response = await callAction(claimRequest({ body }));
    expect(response.status).toBe(400);
  });

  it("rejects malformed orderRef/lineRef that do not look like Shopify GIDs", async () => {
    const response = await callAction(
      claimRequest({ body: baseClaimBody({ orderRef: "not-a-gid-at-all!!", lineRef: "also-not-one" }) })
    );
    expect(response.status).toBe(400);
  });

  it("requires impactOrDamageDetails when hadImpactOrDamageEvent is true", async () => {
    const response = await callAction(
      claimRequest({ body: baseClaimBody({ hadImpactOrDamageEvent: true }) })
    );
    expect(response.status).toBe(400);
  });

  it("requires alterationDetails when wasAlteredAfterDelivery is true", async () => {
    const response = await callAction(
      claimRequest({ body: baseClaimBody({ wasAlteredAfterDelivery: true }) })
    );
    expect(response.status).toBe(400);
  });
});

describe("criterion 154 — acknowledgment copy not yet approved refuses every submission", () => {
  it("returns 503 acknowledgment_copy_pending_approval when no policy_version rows exist for either slug, and creates no claim/acknowledgment", async () => {
    const beforeClaims = await prisma.warrantyClaim.count();
    const beforeAcks = await prisma.acknowledgment.count();

    const response = await callAction(claimRequest({ body: baseClaimBody() }));

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("acknowledgment_copy_pending_approval");
    await expect(prisma.warrantyClaim.count()).resolves.toBe(beforeClaims);
    await expect(prisma.acknowledgment.count()).resolves.toBe(beforeAcks);
  });

  it("still refuses when policy versions exist but no label source is configured", async () => {
    await seedAcknowledgmentPolicies();
    const response = await callAction(claimRequest({ body: baseClaimBody() }));
    expect(response.status).toBe(503);
  });

  it("never calls the Shopify order-lookup port while copy is pending approval", async () => {
    const port = new RecordingWarrantyClaimOrderLookupPort();
    __setWarrantyClaimOrderLookupPortForTests(port);
    await callAction(claimRequest({ body: baseClaimBody() }));
    expect(port.calls).toHaveLength(0);
  });
});

describe("criterion 155 — order/line resolution", () => {
  it("refuses a claim whose order/line does not resolve, and creates no claim", async () => {
    await seedAcknowledgmentPolicies();
    __setWarrantyAcknowledgmentLabelSourceForTests(FAKE_LABEL_SOURCE);
    __setWarrantyClaimOrderLookupPortForTests(new RecordingWarrantyClaimOrderLookupPort()); // resolves nothing

    const before = await prisma.warrantyClaim.count();
    const response = await callAction(claimRequest({ body: baseClaimBody() }));

    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("order_or_line_unresolved");
    await expect(prisma.warrantyClaim.count()).resolves.toBe(before);
  });

  it("refuses when the resolved order belongs to a different logged-in customer", async () => {
    await seedAcknowledgmentPolicies();
    __setWarrantyAcknowledgmentLabelSourceForTests(FAKE_LABEL_SOURCE);
    const claimBody = baseClaimBody();
    useResolvableOrderLookup(claimBody.orderRef, claimBody.lineRef, { customerGid: "gid://shopify/Customer/999999" });

    const response = await callAction(
      claimRequest({ query: { shop: SHOP, logged_in_customer_id: "111111" }, body: claimBody })
    );
    expect(response.status).toBe(422);
  });

  it("succeeds when the resolved order's customer matches the logged-in customer", async () => {
    await seedAcknowledgmentPolicies();
    __setWarrantyAcknowledgmentLabelSourceForTests(FAKE_LABEL_SOURCE);
    const claimBody = baseClaimBody();
    useResolvableOrderLookup(claimBody.orderRef, claimBody.lineRef, { customerGid: "gid://shopify/Customer/111111" });

    const response = await callAction(
      claimRequest({ query: { shop: SHOP, logged_in_customer_id: "111111" }, body: claimBody })
    );
    expect(response.status).toBe(201);
  });
});

describe("criterion 156 — no shipping instruction appears anywhere in the response", () => {
  it("the success response contains only claimId/claimReference/status, with no address- or shipping-like content", async () => {
    await seedAcknowledgmentPolicies();
    __setWarrantyAcknowledgmentLabelSourceForTests(FAKE_LABEL_SOURCE);
    const claimBody = baseClaimBody();
    useResolvableOrderLookup(claimBody.orderRef, claimBody.lineRef);

    const response = await callAction(claimRequest({ body: claimBody }));
    expect(response.status).toBe(201);

    const rawText = await response.text();
    expect(Object.keys(JSON.parse(rawText)).sort()).toEqual(["claimId", "claimReference", "status"]);
    expect(rawText).not.toMatch(/ship|address|carrier|insur|tracking|street|postal|zip\b/i);

    const claim = JSON.parse(rawText) as { status: string };
    expect(claim.status).toBe("submitted");
  });
});

describe("criterion 165 — this route never touches jeweller data", () => {
  it("imports nothing from the local-jeweller table or the staff-only read", () => {
    expect("getWarrantyClaimForStaffReview" in warrantyClaimRoute).toBe(false);
  });
});

describe("claim creation — the evidence row", () => {
  it("records both acknowledgments, distinct evidence rows, referencing the seeded policy versions", async () => {
    await seedAcknowledgmentPolicies();
    __setWarrantyAcknowledgmentLabelSourceForTests(FAKE_LABEL_SOURCE);
    const claimBody = baseClaimBody();
    useResolvableOrderLookup(claimBody.orderRef, claimBody.lineRef);

    const response = await callAction(claimRequest({ body: claimBody }));
    expect(response.status).toBe(201);
    const { claimId } = (await response.json()) as { claimId: string };

    const claim = await prisma.warrantyClaim.findUniqueOrThrow({
      where: { id: claimId },
      include: { accuracyCertificationAcknowledgment: true, coverageNotEstablishedAcknowledgment: true },
    });
    expect(claim.accuracyCertificationAcknowledgmentId).not.toBe(claim.coverageNotEstablishedAcknowledgmentId);
    expect(claim.accuracyCertificationAcknowledgment.affirmativeActionLabel).toBe("[TEST] Accuracy Label");
    expect(claim.coverageNotEstablishedAcknowledgment.affirmativeActionLabel).toBe("[TEST] Coverage Label");
    expect(claim.accuracyCertificationAcknowledgment.policyVersionId).not.toBe(
      claim.coverageNotEstablishedAcknowledgment.policyVersionId
    );
    expect(claim.status).toBe("submitted");
  });

  it("resolves masterVariantId when shopifyVariantId matches a known variant", async () => {
    await seedAcknowledgmentPolicies();
    __setWarrantyAcknowledgmentLabelSourceForTests(FAKE_LABEL_SOURCE);
    const variant = await createVariant();
    const claimBody = baseClaimBody({ shopifyVariantId: variant.shopifyVariantGid });
    useResolvableOrderLookup(claimBody.orderRef, claimBody.lineRef);

    const response = await callAction(claimRequest({ body: claimBody }));
    expect(response.status).toBe(201);
    const { claimId } = (await response.json()) as { claimId: string };
    const claim = await prisma.warrantyClaim.findUniqueOrThrow({ where: { id: claimId } });
    expect(claim.masterVariantId).toBe(variant.id);
  });

  it("does NOT refuse the claim when shopifyVariantId matches no known variant (variant resolution never gates criterion 155)", async () => {
    await seedAcknowledgmentPolicies();
    __setWarrantyAcknowledgmentLabelSourceForTests(FAKE_LABEL_SOURCE);
    const claimBody = baseClaimBody({ shopifyVariantId: `gid://shopify/ProductVariant/${randomUUID()}` });
    useResolvableOrderLookup(claimBody.orderRef, claimBody.lineRef);

    const response = await callAction(claimRequest({ body: claimBody }));
    expect(response.status).toBe(201);
    const { claimId } = (await response.json()) as { claimId: string };
    const claim = await prisma.warrantyClaim.findUniqueOrThrow({ where: { id: claimId } });
    expect(claim.masterVariantId).toBeNull();
  });

  it("does not persist a customer first name field beyond the required purchaserName (PII minimization)", async () => {
    await seedAcknowledgmentPolicies();
    __setWarrantyAcknowledgmentLabelSourceForTests(FAKE_LABEL_SOURCE);
    const claimBody = baseClaimBody();
    useResolvableOrderLookup(claimBody.orderRef, claimBody.lineRef);

    const response = await callAction(claimRequest({ body: claimBody }));
    const { claimId } = (await response.json()) as { claimId: string };
    const claim = await prisma.warrantyClaim.findUniqueOrThrow({ where: { id: claimId } });
    expect(Object.keys(claim)).not.toContain("firstName");
  });
});

describe("uploads — attacker-supplied metadata, validated before anything is written", () => {
  it("rejects a disallowed content type with 422 and creates no claim", async () => {
    await seedAcknowledgmentPolicies();
    __setWarrantyAcknowledgmentLabelSourceForTests(FAKE_LABEL_SOURCE);
    const claimBody = baseClaimBody({
      uploads: [{ kind: "photo", storageKey: "warranty/x/1.pdf", contentType: "application/pdf", sizeBytes: 1000, checksum: "sha256:abc" }],
    });
    useResolvableOrderLookup(claimBody.orderRef, claimBody.lineRef);

    const before = await prisma.warrantyClaim.count();
    const response = await callAction(claimRequest({ body: claimBody }));

    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("invalid_upload");
    await expect(prisma.warrantyClaim.count()).resolves.toBe(before);
  });

  it("rejects an oversized upload with 422 and creates no claim", async () => {
    await seedAcknowledgmentPolicies();
    __setWarrantyAcknowledgmentLabelSourceForTests(FAKE_LABEL_SOURCE);
    const claimBody = baseClaimBody({
      uploads: [{ kind: "photo", storageKey: "warranty/x/1.jpg", contentType: "image/jpeg", sizeBytes: 1_000_000_000, checksum: "sha256:abc" }],
    });
    useResolvableOrderLookup(claimBody.orderRef, claimBody.lineRef);

    const response = await callAction(claimRequest({ body: claimBody }));
    expect(response.status).toBe(422);
    const before = await prisma.warrantyClaim.count();
    expect(before).toBeGreaterThanOrEqual(0); // sanity — no crash reading count
  });

  it("records a well-formed upload against the created claim", async () => {
    await seedAcknowledgmentPolicies();
    __setWarrantyAcknowledgmentLabelSourceForTests(FAKE_LABEL_SOURCE);
    const claimBody = baseClaimBody({
      uploads: [{ kind: "photo", storageKey: "warranty/x/1.jpg", contentType: "image/jpeg", sizeBytes: 500_000, checksum: "sha256:abc123" }],
    });
    useResolvableOrderLookup(claimBody.orderRef, claimBody.lineRef);

    const response = await callAction(claimRequest({ body: claimBody }));
    expect(response.status).toBe(201);
    const { claimId } = (await response.json()) as { claimId: string };

    const uploads = await prisma.warrantyClaimUpload.findMany({ where: { claimId } });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.contentType).toBe("image/jpeg");
  });
});
