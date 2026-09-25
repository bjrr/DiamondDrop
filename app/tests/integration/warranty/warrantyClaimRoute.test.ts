import { createHmac, randomUUID } from "node:crypto";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  WARRANTY_CLAIM_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL,
  WARRANTY_CLAIM_ACKNOWLEDGMENT_POLICY_SLUG,
  WARRANTY_CLAIM_ACKNOWLEDGMENT_TEXT,
} from "~/domain/warranty/acknowledgmentText";
import * as warrantyClaimRoute from "~/routes/apps.carat.warranty-claim";
import { __setWarrantyClaimOrderLookupPortForTests, action } from "~/routes/apps.carat.warranty-claim";
import { RecordingWarrantyClaimOrderLookupPort } from "~/shopify/admin/warrantyClaimOrderLookupAdapter.server";

/**
 * Slice 5 task 5-3 — the Warranty Claim Form intake endpoint against real
 * Postgres (docs/WARRANTY-CLAIMS.md, docs/specs/SLICE-5-WARRANTY-CLAIMS.md
 * criteria 153-157). Mirrors `luxuryAcknowledgmentRoute.test.ts`'s shape:
 * real HMAC signing, `action()` called directly, evidence asserted against
 * the database rather than mocked.
 *
 * THE ACKNOWLEDGMENT IS NOW REAL, APPROVED COPY (owner approval 2026-09-25).
 * Migration `20260925030000_warranty_claim_policy_version` provisions its
 * `policy_version` row, and `tests/integration/globalSetup.ts` runs every
 * migration against this disposable database before any test file runs —
 * so unlike the earlier draft of this suite, nothing here seeds a throwaway
 * policy fixture; the route's normal, always-available acknowledgment path
 * is exercised directly, the same way a real deployment would use it.
 *
 * NOT COVERED HERE: the `acknowledgment_copy_pending_approval` 503 safety
 * net for a MISPROVISIONED environment (the migration not having run).
 * `policy_version` is append-only, so there is no way to delete the row
 * this migration inserts from within a test; that code path
 * (`if (!policyVersion) return null`) is unchanged from the version this
 * suite proved returns 503 before the copy was approved, and the same
 * safety net `/health`'s `checkRequiredPolicyVersionsProvisioned` covers
 * now that this slug is registered in `~/domain/evidence/requiredPolicyVersions`.
 */

let seq = 0;
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
    claimAcknowledgmentAccepted: true,
    ...overrides,
  };
}

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

  it("rejects claimAcknowledgmentAccepted: false (not literal true) with 400", async () => {
    const response = await callAction(claimRequest({ body: baseClaimBody({ claimAcknowledgmentAccepted: false }) }));
    expect(response.status).toBe(400);
  });

  it("rejects claimAcknowledgmentAccepted missing entirely with 400 — never pre-checked, never inferred", async () => {
    const body = baseClaimBody();
    delete (body as Record<string, unknown>).claimAcknowledgmentAccepted;
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
    const response = await callAction(claimRequest({ body: baseClaimBody({ hadImpactOrDamageEvent: true }) }));
    expect(response.status).toBe(400);
  });

  it("requires alterationDetails when wasAlteredAfterDelivery is true", async () => {
    const response = await callAction(claimRequest({ body: baseClaimBody({ wasAlteredAfterDelivery: true }) }));
    expect(response.status).toBe(400);
  });
});

describe("criterion 155 — order/line resolution", () => {
  it("refuses a claim whose order/line does not resolve, and creates no claim", async () => {
    __setWarrantyClaimOrderLookupPortForTests(new RecordingWarrantyClaimOrderLookupPort()); // resolves nothing

    const before = await prisma.warrantyClaim.count();
    const response = await callAction(claimRequest({ body: baseClaimBody() }));

    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("order_or_line_unresolved");
    await expect(prisma.warrantyClaim.count()).resolves.toBe(before);
  });

  it("refuses when the resolved order belongs to a different logged-in customer", async () => {
    const claimBody = baseClaimBody();
    useResolvableOrderLookup(claimBody.orderRef, claimBody.lineRef, { customerGid: "gid://shopify/Customer/999999" });

    const response = await callAction(
      claimRequest({ query: { shop: SHOP, logged_in_customer_id: "111111" }, body: claimBody })
    );
    expect(response.status).toBe(422);
  });

  it("succeeds when the resolved order's customer matches the logged-in customer", async () => {
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
  /**
   * REPLACED A VACUOUS FENCE, 2026-09-25 (QA review).
   *
   * The previous version asserted:
   *
   *     expect("getWarrantyClaimForStaffReview" in warrantyClaimRoute).toBe(false)
   *
   * `warrantyClaimRoute` is a namespace object of the module's own EXPORTS, so
   * that only asked whether the route re-exports a binding by that name. It
   * said nothing about whether the route IMPORTS and CALLS it — which is the
   * entire regression criterion 165 exists to prevent. Adding
   * `import { getWarrantyClaimForStaffReview } from ...` and using it in the
   * action body would have sailed straight through, green.
   *
   * It was worse than no test: it occupied the place where a real guard
   * belonged and reported success, so nobody would look again.
   *
   * This reads the route's SOURCE instead, the same way
   * `metafieldEligibilityFence.test.ts` and `csrfResourceRouteFence.test.ts`
   * do. Comments are stripped first, because this file's own header
   * legitimately explains what it must never import.
   */
  const ROUTE_PATH = join(process.cwd(), "app", "routes", "apps.carat.warranty-claim.tsx");

  function routeSourceWithoutComments(): string {
    const raw = readFileSync(ROUTE_PATH, "utf8");
    return raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  }

  it("the route file exists where this fence expects it — guard the guard", () => {
    // Without this, a rename turns every assertion below into a vacuous pass
    // against an empty string, which is the failure mode being fixed.
    expect(existsSync(ROUTE_PATH)).toBe(true);
    expect(routeSourceWithoutComments().length).toBeGreaterThan(500);
  });

  it.each([
    ["getWarrantyClaimForStaffReview", /getWarrantyClaimForStaffReview/],
    ["the local-jeweller table", /localJewellerAuthorization/i],
    ["any jeweller identifier at all", /jewell?er/i],
    ["the staff triage read", /searchWarrantyClaimsForStaff/],
  ])(
    "the customer intake route's source never references %s",
    (_label, pattern) => {
      expect(routeSourceWithoutComments()).not.toMatch(pattern);
    }
  );

  it("the fence itself can fail — proven against a synthetic violating source", () => {
    // A fence nobody has watched fire is a fence nobody should trust.
    const violating = 'import { getWarrantyClaimForStaffReview } from "~/db/repositories/warrantyClaimRepository.server";';
    expect(violating).toMatch(/getWarrantyClaimForStaffReview/);
  });
});

describe("criterion 154 — the evidence row: one acknowledgment, the owner-approved text", () => {
  it("records exactly one acknowledgment, referenced by BOTH FK columns, matching the pinned approved text/label/slug", async () => {
    const claimBody = baseClaimBody();
    useResolvableOrderLookup(claimBody.orderRef, claimBody.lineRef);

    const response = await callAction(claimRequest({ body: claimBody }));
    expect(response.status).toBe(201);
    const { claimId } = (await response.json()) as { claimId: string };

    const claim = await prisma.warrantyClaim.findUniqueOrThrow({
      where: { id: claimId },
      include: { accuracyCertificationAcknowledgment: { include: { policyVersion: true } }, coverageNotEstablishedAcknowledgment: true },
    });

    // The owner merged the two proposed acknowledgments into one — both FK
    // columns reference the SAME row.
    expect(claim.accuracyCertificationAcknowledgmentId).toBe(claim.coverageNotEstablishedAcknowledgmentId);
    expect(claim.accuracyCertificationAcknowledgment.exactText).toBe(WARRANTY_CLAIM_ACKNOWLEDGMENT_TEXT);
    expect(claim.accuracyCertificationAcknowledgment.affirmativeActionLabel).toBe(
      WARRANTY_CLAIM_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL
    );
    expect(claim.accuracyCertificationAcknowledgment.policyVersion.slug).toBe(WARRANTY_CLAIM_ACKNOWLEDGMENT_POLICY_SLUG);
    expect(claim.status).toBe("submitted");
  });
});

describe("claim creation — the evidence row", () => {
  it("resolves masterVariantId when shopifyVariantId matches a known variant", async () => {
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
    const claimBody = baseClaimBody({ shopifyVariantId: `gid://shopify/ProductVariant/${randomUUID()}` });
    useResolvableOrderLookup(claimBody.orderRef, claimBody.lineRef);

    const response = await callAction(claimRequest({ body: claimBody }));
    expect(response.status).toBe(201);
    const { claimId } = (await response.json()) as { claimId: string };
    const claim = await prisma.warrantyClaim.findUniqueOrThrow({ where: { id: claimId } });
    expect(claim.masterVariantId).toBeNull();
  });

  it("does not persist a customer first name field beyond the required purchaserName (PII minimization)", async () => {
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
    const claimBody = baseClaimBody({
      uploads: [{ kind: "photo", storageKey: "warranty/x/1.jpg", contentType: "image/jpeg", sizeBytes: 1_000_000_000, checksum: "sha256:abc" }],
    });
    useResolvableOrderLookup(claimBody.orderRef, claimBody.lineRef);

    const response = await callAction(claimRequest({ body: claimBody }));
    expect(response.status).toBe(422);
  });

  it("records a well-formed upload against the created claim", async () => {
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
