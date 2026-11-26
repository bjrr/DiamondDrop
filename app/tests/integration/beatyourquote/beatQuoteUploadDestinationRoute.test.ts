import { createHmac, randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { createBeatQuoteSubmission } from "~/db/repositories/beatQuoteSubmissionRepository.server";
import { R2WarrantyUploadPort } from "~/jobs/warranty/ports";
import { R2ObjectStorageClient } from "~/lib/storage/r2Client.server";
import {
  __setBeatQuoteUploadPortResolverForTests,
  action,
} from "~/routes/apps.carat.beat-quote-upload-destination";

/**
 * THE BEAT QUOTE UPLOAD DESTINATION ROUTE, against real Postgres.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 * ============================================================================
 * `apps.carat.warranty-claim-upload-destination` and the Custom Jewelry
 * equivalent each had an integration test; this route had none, and it is the
 * one about to be switched on for customers. The gap mattered for a specific
 * question nobody could answer from the code alone without reading it
 * carefully: the storefront now offers an attachment on ALL THREE submission
 * kinds, so does the route accept all three?
 *
 * It does, and the reason is worth pinning rather than re-deriving: THE ROUTE
 * NEVER READS THE SUBMISSION KIND. Its `kind` field is the FILE's kind,
 * `document` or `photo`. Nothing in the request, the ownership check or the
 * destination record mentions custom_quote, online_listing or
 * competing_group_buy. That is a property a test can hold in place, and the
 * tests below exercise a real persisted submission of each kind so a future
 * change that starts branching on kind fails here.
 *
 * NO REAL BUCKET IS EVER TOUCHED, exactly as the warranty route's test does
 * it: the "configured" branch is injected as an `R2WarrantyUploadPort` built
 * on DUMMY credentials, because presigning is pure local SigV4 computation.
 * So this proves the route's wiring without a network call and without
 * depending on `STORAGE_*` being set in any environment. Whether the REAL
 * bucket works is a different question, answered by
 * `tests/live/slice5.r2EvidenceStorage.ts`, which has to be run by hand.
 */

const SHOP = "caratforus-dev.myshopify.com";
const CUSTOMER_ID = "987654";
const CUSTOMER_GID = `gid://shopify/Customer/${CUSTOMER_ID}`;

let seq = 0;
const uniq = () => `${Date.now()}${(seq += 1)}`;

function signedPost(body: unknown, query: Record<string, string>): Request {
  const secret = process.env.SHOPIFY_API_SECRET as string;
  const message = Object.entries(query)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("");
  const signature = createHmac("sha256", secret).update(message, "utf8").digest("hex");

  const url = new URL("https://shop.example.com/apps/carat/beat-quote-upload-destination");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  url.searchParams.set("signature", signature);

  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function call(request: Request) {
  return action({ request, params: {}, context: {} } as never);
}

/** Dummy, non-functional credentials. Presigning never leaves the process. */
function configuredPort() {
  return {
    configured: true as const,
    port: new R2WarrantyUploadPort(
      new R2ObjectStorageClient({
        endpoint: "https://example.r2.cloudflarestorage.com",
        bucket: "test-bucket",
        accessKeyId: "AKIATESTTESTTESTTEST",
        secretAccessKey: "secret-access-key-for-local-signing-only",
      })
    ),
  };
}

/** A real, persisted submission of the given kind, owned by CUSTOMER_GID. */
async function seedSubmission(kind: "custom_quote" | "online_listing" | "competing_group_buy") {
  const id = randomUUID();
  const today = new Date().toISOString().slice(0, 10);
  await createBeatQuoteSubmission({
    id,
    customerRef: CUSTOMER_GID,
    firstName: "Ada",
    lastName: "Lovelace",
    email: `ada-${uniq()}@example.com`,
    phone: null,
    kind,
    treatment: kind === "custom_quote" ? "guarantee" : "review_only",
    quoteAgeCalendarDays: kind === "custom_quote" ? 1 : null,
    quoteIssuedOn: kind === "custom_quote" ? new Date(`${today}T00:00:00.000Z`) : null,
    submittedOn: new Date(`${today}T00:00:00.000Z`),
    submittedAt: new Date(),
    calendarZone: "America/New_York",
    competitorSellerName: null,
    competitorWebsite: null,
    listingUrl: null,
    competitorPriceMinorUnits: null,
    competitorPriceCurrency: null,
    specifications: null,
    competitorTimeline: null,
    competitorReturnPolicy: null,
    competitorWarranty: null,
  });
  return id;
}

const validBody = (submissionId: string) => ({
  submissionId,
  kind: "document" as const,
  contentType: "application/pdf",
  sizeBytes: 24_000,
});

afterEach(() => {
  __setBeatQuoteUploadPortResolverForTests(null);
});

describe("uploads are offered for every submission kind", () => {
  it.each(["custom_quote", "online_listing", "competing_group_buy"] as const)(
    "issues a destination for a %s submission",
    async (kind) => {
      __setBeatQuoteUploadPortResolverForTests(configuredPort);
      const submissionId = await seedSubmission(kind);

      const response = await call(
        signedPost(validBody(submissionId), { shop: SHOP, logged_in_customer_id: CUSTOMER_ID })
      );
      expect(response.status, kind).toBe(200);

      const json = (await response.json()) as Record<string, unknown>;
      expect(typeof json.uploadUrl, kind).toBe("string");
      expect(typeof json.storageKey, kind).toBe("string");
      expect(typeof json.expiresAt, kind).toBe("string");

      // AND the destination is recorded, scoped to this purpose and owner.
      // `purpose` is part of the consumption WHERE clause, so a destination
      // issued for a quote can never be redeemed against a warranty claim.
      const rows = await prisma.warrantyClaimUploadDestination.findMany({
        where: { ownerId: submissionId },
      });
      expect(rows, kind).toHaveLength(1);
      expect(rows[0]!.purpose, kind).toBe("beat_quote_submission");
      expect(rows[0]!.customerRef, kind).toBe(CUSTOMER_GID);
      expect(rows[0]!.storageKey, kind).toBe(json.storageKey);
    }
  );

  /**
   * A destination is requested WHILE the form is being filled in, before
   * anything is submitted, so a not-yet-existing submission id must work. If
   * this ever required an existing row, attaching a file would be impossible
   * for every first-time submission, which is all of them.
   */
  it("issues a destination for a submission id that does not exist yet", async () => {
    __setBeatQuoteUploadPortResolverForTests(configuredPort);
    const response = await call(
      signedPost(validBody(randomUUID()), { shop: SHOP, logged_in_customer_id: CUSTOMER_ID })
    );
    expect(response.status).toBe(200);
  });

  it("accepts a photo of a printed quote as well as a document", async () => {
    __setBeatQuoteUploadPortResolverForTests(configuredPort);
    const response = await call(
      signedPost(
        { submissionId: randomUUID(), kind: "photo", contentType: "image/jpeg", sizeBytes: 90_000 },
        { shop: SHOP, logged_in_customer_id: CUSTOMER_ID }
      )
    );
    expect(response.status).toBe(200);
  });
});

describe("who may obtain a destination", () => {
  /**
   * An endpoint that mints presigned PUTs for anyone is free file hosting.
   * The storefront states the consequence rather than hiding it: a signed-out
   * customer can still SUBMIT, they just cannot attach.
   */
  it("REFUSES an anonymous caller with authentication_required", async () => {
    __setBeatQuoteUploadPortResolverForTests(configuredPort);
    const response = await call(signedPost(validBody(randomUUID()), { shop: SHOP }));
    expect(response.status).toBe(401);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.error).toBe("authentication_required");
  });

  it("REFUSES someone else's existing submission, without confirming it exists", async () => {
    __setBeatQuoteUploadPortResolverForTests(configuredPort);
    const submissionId = await seedSubmission("custom_quote");

    const response = await call(
      signedPost(validBody(submissionId), { shop: SHOP, logged_in_customer_id: "111111" })
    );
    // The SAME response as "no such submission", so this cannot be used as an
    // oracle for which submission ids exist.
    expect(response.status).toBe(422);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.error).toBe("submission_unresolved");

    expect(await prisma.warrantyClaimUploadDestination.count({ where: { ownerId: submissionId } })).toBe(0);
  });

  it("REFUSES an unsigned request", async () => {
    __setBeatQuoteUploadPortResolverForTests(configuredPort);
    const url = new URL("https://shop.example.com/apps/carat/beat-quote-upload-destination");
    url.searchParams.set("shop", SHOP);
    const response = await call(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody(randomUUID())),
      })
    );
    expect(response.status).toBe(401);
  });
});

describe("storage that is not configured fails CLOSED", () => {
  /**
   * The storefront turns this 503 into "Attachments are unavailable right now.
   * You can still submit, and we will ask for the quote by email." Never a
   * silent failure, and never a fallback to some other store.
   */
  it("answers 503 uploads_unavailable and records nothing", async () => {
    __setBeatQuoteUploadPortResolverForTests(() => ({
      configured: false,
      reason: "STORAGE_BUCKET is not set",
    }));
    const submissionId = randomUUID();
    const response = await call(
      signedPost(validBody(submissionId), { shop: SHOP, logged_in_customer_id: CUSTOMER_ID })
    );
    expect(response.status).toBe(503);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.error).toBe("uploads_unavailable");
    expect(await prisma.warrantyClaimUploadDestination.count({ where: { ownerId: submissionId } })).toBe(0);
  });
});
