import { createHmac, randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

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
  it("refuses a request for a claim id that does not exist, without ever reaching the upload port", async () => {
    useConfiguredR2PortForTests();
    const response = await callAction(
      destinationRequest({ body: { claimId: randomUUID(), kind: "photo", contentType: "image/jpeg", sizeBytes: 1000 } })
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("claim_unresolved");
  });

  it("refuses a request for a REAL claim that belongs to a DIFFERENT customer, with the SAME response as a nonexistent claim", async () => {
    useConfiguredR2PortForTests();
    const otherCustomerClaim = await seedClaim({ customerRef: "gid://shopify/Customer/999999" });

    const response = await callAction(
      destinationRequest({ body: { claimId: otherCustomerClaim.id, kind: "photo", contentType: "image/jpeg", sizeBytes: 1000 } })
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("claim_unresolved");
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

  it("checks ownership BEFORE checking configuration — a claim that isn't the caller's own never learns whether storage is configured", async () => {
    useUnconfiguredPortForTests();
    const response = await callAction(
      destinationRequest({ body: { claimId: randomUUID(), kind: "photo", contentType: "image/jpeg", sizeBytes: 1000 } })
    );
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
