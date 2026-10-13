import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { prisma } from "~/db/client.server";

// Lets one test force the route's 503 branch WITHOUT touching the database.
// policy_version is append-only at the DB level, so deleting the row to
// simulate a misprovisioned environment is not possible — and should not be.
// vi.hoisted, NOT a plain `let`: vi.mock factories are hoisted above module
// scope, so a factory closing over an ordinary top-level variable cannot see
// later assignments to it.
//
// AND IT TARGETS getLatestPolicyVersion, which cost me two runs to get right.
// The route defines `recordReturnPolicyAcknowledgment` LOCALLY — it is not
// imported — so mocking the rma repository intercepted nothing: the factory
// ran, replaced a function nobody calls, and the test failed with the real
// 201 as though the route were broken. A mock pointed at the wrong module
// does not error, it silently does nothing. The 503 branch actually depends
// on getLatestPolicyVersion returning null, which is what this replaces.
const mockState = vi.hoisted(() => ({ acknowledgmentUnavailable: false }));
vi.mock("~/db/repositories/policyVersionRepository.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/db/repositories/policyVersionRepository.server")>();
  return {
    ...actual,
    getLatestPolicyVersion: async (...args: Parameters<typeof actual.getLatestPolicyVersion>) =>
      mockState.acknowledgmentUnavailable ? null : actual.getLatestPolicyVersion(...args),
  };
});
import * as rmaIntakeRoute from "~/routes/apps.carat.rma-intake";
import { __setRmaOrderLookupPortForTests, action } from "~/routes/apps.carat.rma-intake";
import { RecordingRmaOrderLookupPort } from "~/shopify/admin/rmaOrderLookupAdapter.server";

/**
 * Slice 4 — the Buy Now RMA intake endpoint against real Postgres
 * (docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md, docs/specs/
 * SLICE-4-BUY-NOW-RMA.md criteria 180-191, 198). Mirrors
 * `warrantyClaimRoute.test.ts`'s shape: real HMAC signing, `action()` called
 * directly, evidence asserted against the database rather than mocked.
 *
 * THE ACKNOWLEDGMENT HAS NO APPROVED COPY (see
 * `~/domain/rma/acknowledgmentText.ts`'s header) — unlike the warranty
 * suite, this file's tests run in TWO PHASES, in FILE ORDER (this suite runs
 * with `fileParallelism: false`, and hooks scoped to a `describe` only
 * affect that describe's own children — nothing before the fixture-seeding
 * `describe` below observes it):
 *
 *   1. Every test before the fixture `describe` runs against a database with
 *      NO `policy_version` row under `RMA_RETURN_POLICY_ACKNOWLEDGMENT_POLICY_SLUG`
 *      — the real, un-migrated state of every actual deployment today — and
 *      proves the route's fail-closed 503.
 *   2. The fixture `describe` seeds ONE test-only `policy_version` row
 *      directly (never a migration — `policy_version` is append-only and no
 *      migration provisions this slug on purpose) so the remaining tests can
 *      exercise the rest of the route. That seeded text is explicitly a TEST
 *      FIXTURE, not an assertion that it is the approved copy.
 */

let seq = 0;
function uniqNumeric(): string {
  return `${Date.now()}${(seq += 1)}`;
}

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

/**
 * AUTHENTICATED BY DEFAULT, deliberately.
 *
 * docs/REQUIRED-CUSTOMER-ACCOUNTS.md §5 made RMA self-service require a
 * signed Shopify customer identity, and the route now refuses an anonymous
 * caller with 401 BEFORE it parses the body — which is the correct order,
 * since untrusted input from an unauthenticated caller should not be
 * processed at all.
 *
 * That order has a consequence for tests: every "hostile body is refused"
 * case below would otherwise 401 before reaching the validation it exists to
 * exercise, and would pass for the wrong reason while proving nothing about
 * body handling. So the default request carries an authenticated customer,
 * and anonymity is asserted explicitly in its own cases (see "requires an
 * authenticated customer") rather than being an accidental property of every
 * other test.
 */
const AUTHENTICATED_CUSTOMER_NUMERIC_ID = "111111";

function rmaRequest(overrides: Partial<{ query: Record<string, string>; body: unknown; rawBody: string }> = {}) {
  return signedPost(
    "/apps/carat/rma-intake",
    overrides.query ?? { shop: SHOP, logged_in_customer_id: AUTHENTICATED_CUSTOMER_NUMERIC_ID },
    overrides.body,
    overrides.rawBody !== undefined ? { rawBody: overrides.rawBody } : {}
  );
}

function callAction(request: Request) {
  return action({ request, params: {}, context: {} } as never);
}

/**
 * `YYYY-MM-DD` for `daysAgo` calendar days before the REAL current time —
 * never a fixed calendar date. The route always computes `requestedAt` from
 * its own server-side `new Date()` (never a client-supplied value, by
 * design — see the route's own header), so a fixture pinned to an absolute
 * past date silently drifts out of the intended window every day this suite
 * runs on a later date. Every window-dependent fixture in this file must be
 * anchored to wall-clock "now" this same way.
 */
function daysAgoDateOnly(daysAgo: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

/** delivery 3 days before "now" -> standard window. */
function baseRmaBody(overrides: Record<string, unknown> = {}) {
  const orderNumber = uniqNumeric();
  const lineNumber = uniqNumeric();
  return {
    orderRef: `gid://shopify/Order/${orderNumber}`,
    lineRef: `gid://shopify/LineItem/${lineNumber}`,
    // NO purchaserEmail. The route's schema is .strict() and deliberately has
    // no such field: the stored email is the ORDER's own, read from Shopify,
    // never a client-supplied value a caller could set to anything. Sending
    // it here produced a 400 and made four unrelated tests fail for a reason
    // that had nothing to do with what they were testing.
    itemConfigurationDescription: "14k gold solitaire ring, size 7",
    carrierConfirmedDeliveryDate: daysAgoDateOnly(3),
    reasonCategory: "buyer_remorse",
    reasonExplanation: "Changed my mind about the style.",
    confirmsUnwornBeyondInspection: true,
    confirmsUndamaged: true,
    confirmsUnalteredAfterDelivery: true,
    confirmsOriginalPackagingIncluded: true,
    isPersonalizedOrAltered: false,
    returnPolicyAcknowledgmentAccepted: true,
    ...overrides,
  };
}

/** Wires a fake order-lookup port pre-seeded to resolve exactly this order/line. */
function useResolvableOrderLookup(
  orderGid: string,
  lineGid: string,
  extra: { customerGid?: string | null; eligibleMerchandiseAmountMinorUnits?: bigint; currency?: string } = {}
) {
  const port = new RecordingRmaOrderLookupPort();
  port.seed(orderGid, lineGid, {
    orderName: "#1001",
    // Defaults to the AUTHENTICATED customer, because ownership is now a
    // mandatory equality check (REQUIRED-CUSTOMER-ACCOUNTS.md §5): a resolved
    // order whose customer is null, or anyone else's, is refused. Pass an
    // explicit customerGid to exercise those refusals.
    customerGid:
      extra.customerGid === undefined
        ? `gid://shopify/Customer/${AUTHENTICATED_CUSTOMER_NUMERIC_ID}`
        : extra.customerGid,
    orderEmail: "purchaser@example.com",
    eligibleMerchandiseAmountMinorUnits: extra.eligibleMerchandiseAmountMinorUnits ?? 250_00n,
    eligibleMerchandiseAmountCurrency: extra.currency ?? "USD",
  });
  __setRmaOrderLookupPortForTests(port);
  return port;
}

afterEach(() => {
  __setRmaOrderLookupPortForTests(null);
});

describe("resource-route shape", () => {
  it("has no default export (F-23 — a default export would 400 every real caller in production)", () => {
    expect("default" in rmaIntakeRoute).toBe(false);
    expect(typeof rmaIntakeRoute.action).toBe("function");
  });
});

describe("requires an authenticated customer (REQUIRED-CUSTOMER-ACCOUNTS.md §5, §9 cases 3-5)", () => {
  // These exist because the guarantee is NOT "a valid signature was
  // presented". A valid App Proxy signature proves a request came through
  // Shopify's proxy; it says nothing about WHO sent it. The route shipped
  // once accepting a null customer, and the ownership check it had only
  // blocked when both sides were already known — so an anonymous caller
  // skipped it entirely and could file against any order gid, which are
  // guessable. Signature-validity tests would not have caught that; these do.

  it("refuses a correctly SIGNED but anonymous request with 401, before any body validation", async () => {
    const response = await callAction(
      rmaRequest({ query: { shop: SHOP }, body: baseRmaBody() })
    );
    expect(response.status).toBe(401);
  });

  it("refuses an anonymous request even when the body is invalid — authentication is checked FIRST", async () => {
    // Order matters: untrusted input from an unauthenticated caller should
    // never be parsed. If this ever returns 400, validation has moved ahead
    // of the auth gate.
    const response = await callAction(
      rmaRequest({ query: { shop: SHOP }, rawBody: "{ not json" })
    );
    expect(response.status).toBe(401);
  });

  it("creates NO RmaRequest row for an anonymous caller", async () => {
    const before = await prisma.rmaRequest.count();
    await callAction(rmaRequest({ query: { shop: SHOP }, body: baseRmaBody() }));
    expect(await prisma.rmaRequest.count()).toBe(before);
  });
});

describe("method and signature guards", () => {
  it("rejects a non-POST request with 405", async () => {
    const url = new URL(`https://shop.example.com/apps/carat/rma-intake?shop=${SHOP}`);
    const response = await callAction(new Request(url, { method: "GET" }));
    expect(response.status).toBe(405);
  });

  it("rejects an unsigned request with 401, before any body validation", async () => {
    const url = new URL(`https://shop.example.com/apps/carat/rma-intake?shop=${SHOP}`);
    const request = new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const response = await callAction(request);
    expect(response.status).toBe(401);
  });

  it("rejects a tampered signature with 401", async () => {
    const url = new URL(`https://shop.example.com/apps/carat/rma-intake?shop=${SHOP}`);
    url.searchParams.set("signature", "0".repeat(64));
    const request = new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(baseRmaBody()),
    });
    const response = await callAction(request);
    expect(response.status).toBe(401);
  });
});

describe("malformed or hostile bodies are refused, not partially processed", () => {
  it("rejects invalid JSON with 400 and creates no RMA", async () => {
    const before = await prisma.rmaRequest.count();
    const response = await callAction(rmaRequest({ rawBody: "{not json" }));
    expect(response.status).toBe(400);
    await expect(prisma.rmaRequest.count()).resolves.toBe(before);
  });

  it("rejects a body missing required fields with 400", async () => {
    const response = await callAction(rmaRequest({ body: { orderRef: "gid://shopify/Order/1" } }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  it("rejects returnPolicyAcknowledgmentAccepted: false (not literal true) with 400", async () => {
    const response = await callAction(rmaRequest({ body: baseRmaBody({ returnPolicyAcknowledgmentAccepted: false }) }));
    expect(response.status).toBe(400);
  });

  it("rejects returnPolicyAcknowledgmentAccepted missing entirely with 400 — never inferred", async () => {
    const body = baseRmaBody();
    delete (body as Record<string, unknown>).returnPolicyAcknowledgmentAccepted;
    const response = await callAction(rmaRequest({ body }));
    expect(response.status).toBe(400);
  });

  it("rejects malformed orderRef/lineRef that do not look like Shopify GIDs", async () => {
    const response = await callAction(
      rmaRequest({ body: baseRmaBody({ orderRef: "not-a-gid-at-all!!", lineRef: "also-not-one" }) })
    );
    expect(response.status).toBe(400);
  });

  it("rejects an unrecognised extra field — hasProductSpecificReturnOverride is not an accepted input", async () => {
    const response = await callAction(
      rmaRequest({ body: baseRmaBody({ hasProductSpecificReturnOverride: true }) })
    );
    expect(response.status).toBe(400);
  });

  it("rejects an unrecognised reasonCategory", async () => {
    const response = await callAction(rmaRequest({ body: baseRmaBody({ reasonCategory: "not_a_real_category" }) }));
    expect(response.status).toBe(400);
  });
});

describe("phase 1 — cheap eligibility pre-checks, no I/O, no RMA row created", () => {
  it("refuses a claim-workflow reason category with 422 requires_claim_workflow", async () => {
    const before = await prisma.rmaRequest.count();
    const response = await callAction(rmaRequest({ body: baseRmaBody({ reasonCategory: "alleged_defect" }) }));
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("requires_claim_workflow");
    await expect(prisma.rmaRequest.count()).resolves.toBe(before);
  });

  it("refuses a request past day 30 with 422 past_return_window", async () => {
    const before = await prisma.rmaRequest.count();
    const response = await callAction(
      rmaRequest({ body: baseRmaBody({ carrierConfirmedDeliveryDate: daysAgoDateOnly(45) }) })
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("past_return_window");
    await expect(prisma.rmaRequest.count()).resolves.toBe(before);
  });

  it("requires a remedy choice for a genuinely late-window request (8-30 days before today)", async () => {
    const response = await callAction(
      rmaRequest({ body: baseRmaBody({ carrierConfirmedDeliveryDate: daysAgoDateOnly(10) }) })
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string; windowKind: string };
    expect(body.error).toBe("remedy_choice_required");
    expect(body.windowKind).toBe("late");
  });

  it("rejects a remedy choice supplied in the standard window with 400", async () => {
    const response = await callAction(
      rmaRequest({ body: baseRmaBody({ requestedRemedyKind: "merchandise_credit" }) })
    );
    expect(response.status).toBe(400);
  });
});

describe("acknowledgment gate — the fail-closed guard for a MISPROVISIONED environment", () => {
  // WHAT THIS USED TO BE. Until the owner approved the RMA return-policy
  // copy, no policy version existed and this asserted the route's 503. The
  // copy is approved now and provisioned by migration 20260926040000, so the
  // branch is unreachable in a correctly provisioned environment.
  //
  // Deleting the test would have been the easy move and the wrong one: the
  // 503 guards against exactly the failure that once made Luxury Steals
  // unpurchasable in production — a policy version that existed only in the
  // seed, which never runs there.
  //
  // MY FIRST ATTEMPT WAS TO DELETE THE POLICY ROW AND RESTORE IT. Postgres
  // refused: "Table policy_version is append-only: DELETE is not permitted".
  // The evidence-integrity trigger was right and I was wrong — mutating an
  // append-only evidence table to set up a test is a bad pattern even when
  // it works. Forcing the route's actual branch condition is both safer and
  // a more direct test of the thing that matters.
  it("returns 503 acknowledgment_copy_pending_approval and creates no RMA when the acknowledgment cannot be recorded", async () => {
    const before = await prisma.rmaRequest.count();
    const claimBody = baseRmaBody();
    useResolvableOrderLookup(claimBody.orderRef, claimBody.lineRef);

    mockState.acknowledgmentUnavailable = true;
    try {
      const response = await callAction(rmaRequest({ body: claimBody }));
      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("acknowledgment_copy_pending_approval");
      await expect(prisma.rmaRequest.count()).resolves.toBe(before);
    } finally {
      mockState.acknowledgmentUnavailable = false;
    }
  });

  it("GUARDS THE GUARD — the same request succeeds once the acknowledgment is available", async () => {
    // Without this, the test above would pass even if the route returned 503
    // unconditionally, or if the override leaked and never turned off.
    const claimBody = baseRmaBody();
    useResolvableOrderLookup(claimBody.orderRef, claimBody.lineRef);

    const response = await callAction(rmaRequest({ body: claimBody }));
    expect(response.status).toBe(201);
  });
});

describe("with the RMA return-policy acknowledgment provisioned (TEST FIXTURE, not approved copy)", () => {
  // NO beforeAll CREATING THE POLICY. It used to insert a test fixture
  // because none existed. Migration 20260926040000 now provisions the
  // owner-approved copy, so creating it again violated the (slug, version)
  // unique constraint, the hook threw, and every test in this describe was
  // SKIPPED — reported as "10 skipped" next to a green "88 passed", which is
  // exactly the shape of a suite that looks fine while testing nothing.

  describe("criterion 181 — order/line resolution", () => {
    it("refuses an RMA whose order/line does not resolve, and creates no request", async () => {
      __setRmaOrderLookupPortForTests(new RecordingRmaOrderLookupPort()); // resolves nothing

      const before = await prisma.rmaRequest.count();
      const response = await callAction(rmaRequest({ body: baseRmaBody() }));

      expect(response.status).toBe(422);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("order_or_line_unresolved");
      await expect(prisma.rmaRequest.count()).resolves.toBe(before);
    });

    it("refuses when the resolved order belongs to a different logged-in customer", async () => {
      const rmaBody = baseRmaBody();
      useResolvableOrderLookup(rmaBody.orderRef, rmaBody.lineRef, { customerGid: "gid://shopify/Customer/999999" });

      const response = await callAction(
        rmaRequest({ query: { shop: SHOP, logged_in_customer_id: "111111" }, body: rmaBody })
      );
      expect(response.status).toBe(422);
    });

    it("succeeds when the resolved order's customer matches the logged-in customer", async () => {
      const rmaBody = baseRmaBody();
      useResolvableOrderLookup(rmaBody.orderRef, rmaBody.lineRef, { customerGid: "gid://shopify/Customer/111111" });

      const response = await callAction(
        rmaRequest({ query: { shop: SHOP, logged_in_customer_id: "111111" }, body: rmaBody })
      );
      expect(response.status).toBe(201);
    });

    // INVERTED 2026-09-26. This asserted that a guest submission SUCCEEDS,
    // which was true and intended until docs/REQUIRED-CUSTOMER-ACCOUNTS.md
    // §5 made an authenticated Shopify account mandatory for RMA
    // self-service. It is kept rather than deleted because the behaviour it
    // names is exactly what must never come back.
    it("REFUSES a guest (no logged-in customer at all) — inverted by REQUIRED-CUSTOMER-ACCOUNTS.md §5", async () => {
      const rmaBody = baseRmaBody();
      useResolvableOrderLookup(rmaBody.orderRef, rmaBody.lineRef);

      const before = await prisma.rmaRequest.count();
      const response = await callAction(rmaRequest({ query: { shop: SHOP }, body: rmaBody }));
      expect(response.status).toBe(401);
      await expect(prisma.rmaRequest.count()).resolves.toBe(before);
    });

    it("refuses when the resolved order belongs to a DIFFERENT customer", async () => {
      const rmaBody = baseRmaBody();
      useResolvableOrderLookup(rmaBody.orderRef, rmaBody.lineRef, {
        customerGid: "gid://shopify/Customer/999999",
      });

      const before = await prisma.rmaRequest.count();
      const response = await callAction(rmaRequest({ body: rmaBody }));
      expect(response.status).toBe(422);
      // Deliberately the SAME generic error as an order that does not exist —
      // distinguishing them would turn this into an enumeration oracle.
      expect(((await response.json()) as { error: string }).error).toBe("order_or_line_unresolved");
      await expect(prisma.rmaRequest.count()).resolves.toBe(before);
    });

    it("refuses when the resolved order has NO customer on file", async () => {
      const rmaBody = baseRmaBody();
      useResolvableOrderLookup(rmaBody.orderRef, rmaBody.lineRef, { customerGid: null });

      const before = await prisma.rmaRequest.count();
      const response = await callAction(rmaRequest({ body: rmaBody }));
      expect(response.status).toBe(422);
      await expect(prisma.rmaRequest.count()).resolves.toBe(before);
    });
  });

  describe("criteria 189-191 — the eligible merchandise amount comes ONLY from the resolved order line", () => {
    it("persists the order lookup's merchandise amount, never a client-supplied one", async () => {
      const rmaBody = baseRmaBody();
      useResolvableOrderLookup(rmaBody.orderRef, rmaBody.lineRef, {
        eligibleMerchandiseAmountMinorUnits: 199_99n,
        currency: "USD",
      });

      const response = await callAction(rmaRequest({ body: rmaBody }));
      expect(response.status).toBe(201);
      const dto = (await response.json()) as { rmaId: string };

      const stored = await prisma.rmaRequest.findUniqueOrThrow({ where: { id: dto.rmaId } });
      expect(stored.eligibleMerchandiseAmountMinorUnits).toBe(199_99n);
      expect(stored.eligibleMerchandiseAmountCurrency).toBe("USD");
    });

    it("rejects a client-supplied eligibleMerchandiseAmountMinorUnits outright — the strict schema has no such field", async () => {
      const rmaBody = baseRmaBody({ eligibleMerchandiseAmountMinorUnits: 1 });
      useResolvableOrderLookup(rmaBody.orderRef, rmaBody.lineRef, { eligibleMerchandiseAmountMinorUnits: 250_00n });

      const response = await callAction(rmaRequest({ body: rmaBody }));
      expect(response.status).toBe(400);
    });
  });

  describe("the success response is a closed allow-list", () => {
    it("contains only rmaId/rmaReference/status/windowKind/requestedRemedyKind", async () => {
      const rmaBody = baseRmaBody();
      useResolvableOrderLookup(rmaBody.orderRef, rmaBody.lineRef);

      const response = await callAction(rmaRequest({ body: rmaBody }));
      expect(response.status).toBe(201);
      const rawText = await response.text();
      expect(Object.keys(JSON.parse(rawText)).sort()).toEqual(
        ["requestedRemedyKind", "rmaId", "rmaReference", "status", "windowKind"].sort()
      );

      const dto = JSON.parse(rawText) as { status: string; windowKind: string; requestedRemedyKind: string | null };
      expect(dto.status).toBe("submitted");
      expect(dto.windowKind).toBe("standard");
      expect(dto.requestedRemedyKind).toBeNull();
    });

    it("reflects the late-window remedy choice in the response", async () => {
      const rmaBody = baseRmaBody({
        carrierConfirmedDeliveryDate: daysAgoDateOnly(10),
        requestedRemedyKind: "merchandise_credit",
      });
      useResolvableOrderLookup(rmaBody.orderRef, rmaBody.lineRef);

      const response = await callAction(rmaRequest({ body: rmaBody }));
      expect(response.status).toBe(201);
      const dto = (await response.json()) as { windowKind: string; requestedRemedyKind: string | null };
      expect(dto.windowKind).toBe("late");
      expect(dto.requestedRemedyKind).toBe("merchandise_credit");
    });
  });

  describe("hasProductSpecificReturnOverride is never customer-settable", () => {
    it("a personalized-item submission is always stored with the override false", async () => {
      const rmaBody = baseRmaBody({ isPersonalizedOrAltered: true });
      useResolvableOrderLookup(rmaBody.orderRef, rmaBody.lineRef);

      const response = await callAction(rmaRequest({ body: rmaBody }));
      expect(response.status).toBe(201);
      const dto = (await response.json()) as { rmaId: string };
      const stored = await prisma.rmaRequest.findUniqueOrThrow({ where: { id: dto.rmaId } });
      expect(stored.isPersonalizedOrAltered).toBe(true);
      expect(stored.hasProductSpecificReturnOverride).toBe(false);
    });
  });

  describe("records exactly one acknowledgment referencing this request", () => {
    it("returnPolicyAcknowledgmentId on the created row points at a real acknowledgment row", async () => {
      const rmaBody = baseRmaBody();
      useResolvableOrderLookup(rmaBody.orderRef, rmaBody.lineRef);

      const response = await callAction(rmaRequest({ body: rmaBody }));
      const dto = (await response.json()) as { rmaId: string };
      const stored = await prisma.rmaRequest.findUniqueOrThrow({ where: { id: dto.rmaId } });
      const acknowledgment = await prisma.acknowledgment.findUnique({ where: { id: stored.returnPolicyAcknowledgmentId } });
      expect(acknowledgment).not.toBeNull();
      expect(acknowledgment!.orderRef).toBe(stored.orderRef);
    });
  });
});
