import { createHmac, randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { createAcknowledgment } from "~/db/repositories/acknowledgmentRepository.server";
import { getLatestPolicyVersion } from "~/db/repositories/policyVersionRepository.server";
import { createWarrantyClaim } from "~/db/repositories/warrantyClaimRepository.server";
import {
  WARRANTY_CLAIM_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL,
  WARRANTY_CLAIM_ACKNOWLEDGMENT_POLICY_SLUG,
  WARRANTY_CLAIM_ACKNOWLEDGMENT_TEXT,
} from "~/domain/warranty/acknowledgmentText";
import { R2WarrantyUploadPort, RecordingWarrantyUploadPort } from "~/jobs/warranty/ports";
import { R2ObjectStorageClient } from "~/lib/storage/r2Client.server";
import * as uploadDestinationRoute from "~/routes/apps.carat.warranty-claim-upload-destination";
import { __setWarrantyUploadPortResolverForTests, action } from "~/routes/apps.carat.warranty-claim-upload-destination";

/**
 * R2 adapter task — the upload-destination-issuing route against real
 * Postgres. Mirrors `warrantyClaimRoute.test.ts`'s shape: real HMAC signing,
 * `action()` called directly, a real claim seeded via the repository.
 *
 * NO REAL BUCKET IS EVER TOUCHED. Tests that need the "configured" branch
 * inject a `R2WarrantyUploadPort` built with DUMMY, non-functional
 * credentials via `__setWarrantyUploadPortResolverForTests` — presigning is
 * pure local SigV4 computation (see `r2Client.server.test.ts`), so this
 * proves the route's wiring (auth, ownership, response shape) without any
 * network call and without depending on `STORAGE_*` being set anywhere.
 */

const SHOP = "caratforus-dev.myshopify.com";
const DEFAULT_CUSTOMER_ID = "222222";
const DEFAULT_CUSTOMER_GID = `gid://shopify/Customer/${DEFAULT_CUSTOMER_ID}`;

let seq = 0;
const uniqNumeric = () => `${Date.now()}${(seq += 1)}`;

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

function destinationRequest(overrides: Partial<{ query: Record<string, string>; body: unknown; rawBody: string }> = {}) {
  return signedPost(
    "/apps/carat/warranty-claim-upload-destination",
    overrides.query ?? { shop: SHOP, logged_in_customer_id: DEFAULT_CUSTOMER_ID },
    overrides.body,
    overrides.rawBody !== undefined ? { rawBody: overrides.rawBody } : {}
  );
}

function callAction(request: Request) {
  return action({ request, params: {}, context: {} } as never);
}

/** A real, persisted claim owned by `DEFAULT_CUSTOMER_GID` unless overridden. */
async function seedClaim(overrides: { customerRef?: string | null } = {}) {
  const policyVersion = await getLatestPolicyVersion(WARRANTY_CLAIM_ACKNOWLEDGMENT_POLICY_SLUG);
  if (!policyVersion) throw new Error("expected the warranty claim acknowledgment policy_version to be provisioned by migration");

  const orderNumber = uniqNumeric();
  const orderRef = `gid://shopify/Order/${orderNumber}`;
  const acknowledgment = await createAcknowledgment({
    exactText: WARRANTY_CLAIM_ACKNOWLEDGMENT_TEXT,
    policyVersionId: policyVersion.id,
    acknowledgedAt: new Date(),
    affirmativeActionLabel: WARRANTY_CLAIM_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL,
    customerRef: overrides.customerRef !== undefined ? (overrides.customerRef ?? undefined) : DEFAULT_CUSTOMER_GID,
    orderRef,
  });

  return createWarrantyClaim({
    orderRef,
    lineRef: `gid://shopify/LineItem/${uniqNumeric()}`,
    customerRef: overrides.customerRef !== undefined ? overrides.customerRef : DEFAULT_CUSTOMER_GID,
    itemConfigurationDescription: "14k gold solitaire ring, size 7",
    purchaserName: "Test Purchaser",
    purchaserEmail: "purchaser@example.com",
    problemDescription: "Prong appears loose.",
    hadImpactOrDamageEvent: false,
    wasAlteredAfterDelivery: false,
    accuracyCertificationAcknowledgmentId: acknowledgment.id,
    coverageNotEstablishedAcknowledgmentId: acknowledgment.id,
    actor: { actorType: "customer", actorRef: DEFAULT_CUSTOMER_GID },
  });
}

function useConfiguredR2PortForTests() {
  const port = new R2WarrantyUploadPort(
    new R2ObjectStorageClient({
      endpoint: "https://acct123.r2.cloudflarestorage.com",
      bucket: "caratforus-evidence",
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "shh-its-a-secret",
    })
  );
  __setWarrantyUploadPortResolverForTests(() => ({ configured: true, port }));
  return port;
}

function useUnconfiguredPortForTests() {
  __setWarrantyUploadPortResolverForTests(() => ({ configured: false, reason: "object storage not configured: missing STORAGE_ENDPOINT" }));
}

afterEach(() => {
  __setWarrantyUploadPortResolverForTests(null);
});

describe("resource-route shape", () => {
  it("has no default export (F-23 — a default export would 400 every real caller in production)", () => {
    expect("default" in uploadDestinationRoute).toBe(false);
    expect(typeof uploadDestinationRoute.action).toBe("function");
  });
});

describe("method and signature guards", () => {
  it("rejects a non-POST request with 405", async () => {
    const url = new URL(`https://shop.example.com/apps/carat/warranty-claim-upload-destination?shop=${SHOP}`);
    const response = await callAction(new Request(url, { method: "GET" }));
    expect(response.status).toBe(405);
  });

  it("rejects an unsigned request with 401", async () => {
    const url = new URL(`https://shop.example.com/apps/carat/warranty-claim-upload-destination?shop=${SHOP}`);
    const request = new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const response = await callAction(request);
    expect(response.status).toBe(401);
  });
});

describe("docs/REQUIRED-CUSTOMER-ACCOUNTS.md — no guest path", () => {
  it("refuses an anonymous request (no logged_in_customer_id) with 401 authentication_required, before the body is even parsed", async () => {
    const response = await callAction(destinationRequest({ query: { shop: SHOP }, rawBody: "{not json at all" }));
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("authentication_required");
  });
});

describe("ownership — the gate this route exists for", () => {
  it("ISSUES a destination for a claim id that does not exist YET — the client-generated-id-before-creation flow (apps.carat.warranty-claim.tsx's module comment)", async () => {
    useConfiguredR2PortForTests();
    const pendingClaimId = randomUUID();
    const response = await callAction(
      destinationRequest({ body: { claimId: pendingClaimId, kind: "photo", contentType: "image/jpeg", sizeBytes: 1000 } })
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { storageKey: string };

    const persisted = await prisma.warrantyClaimUploadDestination.findUnique({ where: { storageKey: body.storageKey } });
    // `ownerId` + `purpose`, NOT the retired `claim_id`. This assertion used
    // to read `claimId`, and it failed the moment the writer stopped setting
    // that column in contract step A — correctly: it was checking a value
    // that no longer carries the binding. `ownerId` is what consumption
    // actually matches on, so it is what the test must pin.
    expect(persisted?.ownerId).toBe(pendingClaimId);
    expect(persisted?.purpose).toBe("warranty_claim");
    expect(persisted?.customerRef).toBe(DEFAULT_CUSTOMER_GID);
    expect(persisted?.consumedAt).toBeNull();
  });

  it("refuses a request for a REAL claim that belongs to a DIFFERENT customer — unlike a not-yet-existing id, a real claim's ownership is enforced", async () => {
    useConfiguredR2PortForTests();
    const otherCustomerClaim = await seedClaim({ customerRef: "gid://shopify/Customer/999999" });

    const response = await callAction(
      destinationRequest({ body: { claimId: otherCustomerClaim.id, kind: "photo", contentType: "image/jpeg", sizeBytes: 1000 } })
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("claim_unresolved");

    // QUERIED BY `ownerId`, NOT the retired `claim_id`. This matters more here
    // than in the assertion above: this one asserts that NO row exists, and
    // since contract step A stopped writing `claim_id`, a query on that column
    // finds nothing whether or not the route leaked a destination. It would
    // have passed vacuously — a check that can only ever succeed is not a
    // check. `purpose` is included so a Custom Jewelry row sharing this owner
    // id could not be mistaken for the thing under test.
    const persisted = await prisma.warrantyClaimUploadDestination.findFirst({
      where: { purpose: "warranty_claim", ownerId: otherCustomerClaim.id },
    });
    expect(persisted).toBeNull();
  });

  it("refuses a request for a real claim with NO customer on file (no self-service bypass)", async () => {
    useConfiguredR2PortForTests();
    const claim = await seedClaim({ customerRef: null });

    const response = await callAction(
      destinationRequest({ body: { claimId: claim.id, kind: "photo", contentType: "image/jpeg", sizeBytes: 1000 } })
    );
    expect(response.status).toBe(422);
  });

  it("issues a real destination for the caller's OWN claim", async () => {
    useConfiguredR2PortForTests();
    const claim = await seedClaim();

    const response = await callAction(
      destinationRequest({ body: { claimId: claim.id, kind: "photo", contentType: "image/jpeg", sizeBytes: 1000 } })
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { storageKey: string; uploadUrl: string; expiresAt: string };
    expect(body.storageKey).toContain(`warranty/${claim.id}/photo/`);
    expect(body.uploadUrl).toContain("X-Amz-Signature");
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });
});

describe("fail-closed when storage is unconfigured", () => {
  it("returns 503 uploads_unavailable for the caller's own claim, and never reaches the port", async () => {
    useUnconfiguredPortForTests();
    const claim = await seedClaim();

    const response = await callAction(
      destinationRequest({ body: { claimId: claim.id, kind: "photo", contentType: "image/jpeg", sizeBytes: 1000 } })
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("uploads_unavailable");
  });

  it("checks ownership BEFORE checking configuration — a REAL claim that isn't the caller's own never learns whether storage is configured", async () => {
    useUnconfiguredPortForTests();
    const otherCustomerClaim = await seedClaim({ customerRef: "gid://shopify/Customer/999999" });

    const response = await callAction(
      destinationRequest({ body: { claimId: otherCustomerClaim.id, kind: "photo", contentType: "image/jpeg", sizeBytes: 1000 } })
    );
    // 422 claim_unresolved, NOT 503 uploads_unavailable — ownership is
    // checked first regardless of storage configuration.
    expect(response.status).toBe(422);
  });
});

describe("upload metadata validation, applied before any destination is offered", () => {
  it("refuses an invalid content type with 422 invalid_upload", async () => {
    useConfiguredR2PortForTests();
    const claim = await seedClaim();

    const response = await callAction(
      destinationRequest({ body: { claimId: claim.id, kind: "photo", contentType: "application/pdf", sizeBytes: 1000 } })
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("invalid_upload");
  });

  it("refuses an oversized request with 422 invalid_upload", async () => {
    useConfiguredR2PortForTests();
    const claim = await seedClaim();

    const response = await callAction(
      destinationRequest({ body: { claimId: claim.id, kind: "photo", contentType: "image/jpeg", sizeBytes: 1_000_000_000 } })
    );
    expect(response.status).toBe(422);
  });

  it("rejects a non-uuid claimId with 400 before touching the database", async () => {
    useConfiguredR2PortForTests();
    const response = await callAction(
      destinationRequest({ body: { claimId: "not-a-uuid", kind: "photo", contentType: "image/jpeg", sizeBytes: 1000 } })
    );
    expect(response.status).toBe(400);
  });
});

describe("the RecordingWarrantyUploadPort is never used as a production fallback here", () => {
  it("an unconfigured resolution never falls back to RecordingWarrantyUploadPort's null uploadUrl — the response is 503, not a 201 with a null url", async () => {
    useUnconfiguredPortForTests();
    const claim = await seedClaim();
    const response = await callAction(
      destinationRequest({ body: { claimId: claim.id, kind: "photo", contentType: "image/jpeg", sizeBytes: 1000 } })
    );
    // Guards against a regression where someone "helpfully" wires
    // RecordingWarrantyUploadPort in as the unconfigured branch's answer,
    // which would return 201 with uploadUrl: null instead of an honest 503.
    expect(response.status).not.toBe(201);
    expect(new RecordingWarrantyUploadPort()).toBeInstanceOf(RecordingWarrantyUploadPort); // sanity: import is exercised, not dead
  });
});
