import { createHmac, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  BEAT_QUOTE_AUTHENTICITY_TEXT,
  BEAT_QUOTE_GROUP_BUY_TEXT,
  BEAT_QUOTE_OLDER_QUOTE_TEXT,
  BEAT_QUOTE_ONLINE_LISTING_TEXT,
  BEAT_QUOTE_RECENT_QUOTE_TEXT,
  BEAT_QUOTE_WHAT_WE_MATCH_TEXT,
} from "~/domain/beatyourquote/acknowledgmentText";
import { action as intakeAction } from "~/routes/apps.carat.beat-quote-submission";
import {
  __setStoreTimezoneOverrideForTests,
  businessCalendarDate,
} from "~/shopify/admin/shopTimezone.server";

/**
 * The intake route, against real Postgres.
 *
 * THE PROPERTY UNDER TEST THROUGHOUT IS THAT THE CUSTOMER CANNOT CHOOSE THEIR
 * OWN TREATMENT. A guarantee carries a match-or-beat promise and a $100
 * benefit, so a request that could assert its own eligibility would be a
 * self-service discount. Every case below either proves a tampered field is
 * refused, or proves the derived value is the one that got stored.
 */

const SHOP = "caratforus-dev.myshopify.com";
const CUSTOMER = "551717";

let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${++seq}`;

/**
 * The store's real configured zone, pinned for these tests.
 *
 * Set as an OVERRIDE rather than letting the route resolve it from Shopify:
 * the integration environment has no Admin session, and a test that depended
 * on one would be testing Shopify's availability. The override also makes the
 * boundary cases below possible at all — they need a KNOWN zone to compute
 * 23:59 and 00:00 against.
 */
const BUSINESS_ZONE = "America/New_York";
beforeAll(() => __setStoreTimezoneOverrideForTests(BUSINESS_ZONE));
afterAll(() => __setStoreTimezoneOverrideForTests(null));

/** Today in the business calendar, derived the same way the route derives it. */
const TODAY = businessCalendarDate(new Date(), BUSINESS_ZONE);

function daysBefore(n: number): string {
  const ms = Date.parse(`${TODAY}T00:00:00.000Z`) - n * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

function signedPost(body: unknown, options: { authenticated?: boolean } = {}): Request {
  const secret = process.env.SHOPIFY_API_SECRET as string;
  const query: Record<string, string> = { shop: SHOP };
  if (options.authenticated) query.logged_in_customer_id = CUSTOMER;
  const message = Object.entries(query)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("");
  const signature = createHmac("sha256", secret).update(message, "utf8").digest("hex");
  const url = new URL("https://shop.example.com/apps/carat/beat-quote-submission");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  url.searchParams.set("signature", signature);
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function call(request: Request) {
  return intakeAction({ request, params: {}, context: {} } as never);
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    submissionId: randomUUID(),
    firstName: "Ada",
    lastName: "Lovelace",
    email: `ada-${uniq()}@example.com`,
    kind: "custom_quote",
    quoteIssuedOn: daysBefore(2),
    competitorSellerName: "Some Jeweller",
    competitorPriceMinorUnits: "450000",
    competitorPriceCurrency: "USD",
    specifications: "14k gold solitaire, 1.2ct lab round, size 6",
    whatWeMatchAccepted: true,
    authenticityConfirmed: true,
    pathAcknowledgmentAccepted: true,
    ...overrides,
  };
}

async function submit(overrides: Record<string, unknown> = {}, options: { authenticated?: boolean } = {}) {
  const response = await call(signedPost(validBody(overrides), options));
  const json = (await response.json()) as Record<string, unknown>;
  return { status: response.status, json };
}

describe("a client-supplied treatment CANNOT override the derived one", () => {
  it("REFUSES a request carrying treatment=guarantee outright", async () => {
    // Not "accepts and ignores". The schema is `.strict()`, so an attempt to
    // send the field is a 400 — a field that is merely ignored is a field
    // somebody later wires up.
    const result = await submit({ kind: "online_listing", quoteIssuedOn: undefined, treatment: "guarantee" });
    expect(result.status).toBe(400);
    expect(result.json.error).toBe("invalid_request");
  });

  it("REFUSES guaranteeEligible, quoteAgeCalendarDays, and an acknowledgment id", async () => {
    // Every value a tamperer would reach for. None is in the contract.
    for (const injected of [
      { guaranteeEligible: true },
      { quoteAgeCalendarDays: 0 },
      { acknowledgmentId: "recent_quote" },
      { acknowledgmentVersion: 1 },
      { pathAcknowledgmentText: BEAT_QUOTE_RECENT_QUOTE_TEXT },
    ]) {
      const result = await submit(injected);
      expect(result.status, JSON.stringify(injected)).toBe(400);
    }
  });

  it("stores the DERIVED treatment, not anything the request hinted at", async () => {
    const { status, json } = await submit({ quoteIssuedOn: daysBefore(2) });
    expect(status).toBe(201);
    expect(json.treatment).toBe("guarantee");

    const row = await prisma.beatQuoteSubmission.findUniqueOrThrow({
      where: { id: (json.submissionId as string) },
    });
    expect(row.treatment).toBe("guarantee");
    expect(row.quoteAgeCalendarDays).toBe(2);
  });
});

describe("a non-custom-quote cannot obtain guarantee treatment", () => {
  it.each(["online_listing", "competing_group_buy"] as const)(
    "%s is stored as review_only, and is ACCEPTED rather than rejected",
    async (kind) => {
      // Amendment §1 and §4 case 4. Accepted for review is the point — the
      // spec wants these submissions, just without a promise.
      const { status, json } = await submit({ kind, quoteIssuedOn: undefined });
      expect(status).toBe(201);
      expect(json.treatment).toBe("review_only");

      const row = await prisma.beatQuoteSubmission.findUniqueOrThrow({
        where: { id: json.submissionId as string },
      });
      expect(row.treatment).toBe("review_only");
      // No age at all for these kinds.
      expect(row.quoteAgeCalendarDays).toBeNull();
      expect(row.quoteIssuedOn).toBeNull();
    }
  );

  it("REFUSES a quoteIssuedOn on a kind that has no age rule", async () => {
    // Accepting it would store an age against a kind where comparing it to 7
    // means nothing, which is the shape of a future bug.
    const result = await submit({ kind: "online_listing", quoteIssuedOn: daysBefore(1) });
    expect(result.status).toBe(400);
  });
});

describe("an over-age custom quote cannot obtain guarantee treatment", () => {
  it("is review_only at 8 days and guarantee at 7 — the boundary, through the real route", async () => {
    const eight = await submit({ quoteIssuedOn: daysBefore(8) });
    expect(eight.status).toBe(201);
    expect(eight.json.treatment).toBe("review_only");

    const seven = await submit({ quoteIssuedOn: daysBefore(7) });
    expect(seven.status).toBe(201);
    expect(seven.json.treatment).toBe("guarantee");
  });

  it("REFUSES an impossible calendar date rather than letting it roll forward", async () => {
    // `2026-02-30` passes the regex. V8's Date.parse rolls it to March 2, which
    // would shift the age by two days across the guarantee boundary.
    const result = await submit({ quoteIssuedOn: "2026-02-30" });
    expect(result.status).toBe(400);
    expect(String(result.json.reason)).toMatch(/real calendar date/i);
  });

  it("is review_only for a quote dated in the FUTURE", async () => {
    const ms = Date.parse(`${TODAY}T00:00:00.000Z`) + 3 * 86_400_000;
    const future = new Date(ms).toISOString().slice(0, 10);
    const { json } = await submit({ quoteIssuedOn: future });
    expect(json.treatment).toBe("review_only");
  });
});

describe("the acknowledgment ALWAYS matches the derived treatment", () => {
  it.each([
    ["custom_quote", 2, BEAT_QUOTE_RECENT_QUOTE_TEXT, "recent_quote"],
    ["custom_quote", 20, BEAT_QUOTE_OLDER_QUOTE_TEXT, "older_quote"],
  ] as const)("a %s aged %s days gets the %s variant", async (kind, age, expectedText, expectedId) => {
    const { json } = await submit({ kind, quoteIssuedOn: daysBefore(age) });
    const ack = json.acknowledgment as Record<string, unknown>;
    expect(ack.id).toBe(expectedId);
    expect(ack.text).toBe(expectedText);

    // And the EVIDENCE row carries that exact text, not the response's.
    const rows = await prisma.acknowledgment.findMany({
      where: { submissionRef: json.submissionId as string },
      include: { policyVersion: true },
    });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.exactText)).toContain(expectedText);
  });

  it("an online listing gets the AMENDMENT's variant, never the 3A guarantee text", async () => {
    // The specific regression the amendment creates: the original spec has no
    // online-listing acknowledgment, so a naive implementation reuses 3A —
    // which promises exactly the guarantee the amendment withdrew.
    const { json } = await submit({ kind: "online_listing", quoteIssuedOn: undefined });
    const ack = json.acknowledgment as Record<string, unknown>;
    expect(ack.text).toBe(BEAT_QUOTE_ONLINE_LISTING_TEXT);
    expect(ack.text).not.toBe(BEAT_QUOTE_RECENT_QUOTE_TEXT);
  });

  it("a competing Group Buy gets 3C", async () => {
    const { json } = await submit({ kind: "competing_group_buy", quoteIssuedOn: undefined });
    expect((json.acknowledgment as Record<string, unknown>).text).toBe(BEAT_QUOTE_GROUP_BUY_TEXT);
  });

  it("records all THREE acknowledgments with their exact text and policy version", async () => {
    const { json } = await submit({ quoteIssuedOn: daysBefore(1) });
    const rows = await prisma.acknowledgment.findMany({
      where: { submissionRef: json.submissionId as string },
      include: { policyVersion: true },
    });
    const texts = rows.map((r) => r.exactText);
    expect(texts).toContain(BEAT_QUOTE_WHAT_WE_MATCH_TEXT);
    expect(texts).toContain(BEAT_QUOTE_AUTHENTICITY_TEXT);
    expect(texts).toContain(BEAT_QUOTE_RECENT_QUOTE_TEXT);
    // Each names the version it was shown under, so a later wording change
    // cannot restate what this customer agreed to.
    for (const row of rows) {
      expect(row.policyVersion.version).toBe(1);
      expect(row.exactText).toBe(row.policyVersion.text);
      expect(row.acknowledgedAt).toBeInstanceOf(Date);
    }
  });
});

describe("acceptance must be affirmative and unchecked — never inferred", () => {
  it.each([
    ["whatWeMatchAccepted omitted", { whatWeMatchAccepted: undefined }],
    ["whatWeMatchAccepted false", { whatWeMatchAccepted: false }],
    ["authenticityConfirmed false", { authenticityConfirmed: false }],
    ["pathAcknowledgmentAccepted omitted", { pathAcknowledgmentAccepted: undefined }],
    ["pathAcknowledgmentAccepted the string 'true'", { pathAcknowledgmentAccepted: "true" }],
  ])("REFUSES when %s, and stores nothing", async (_label, override) => {
    const body = validBody(override);
    if ((override as Record<string, unknown>).whatWeMatchAccepted === undefined && "whatWeMatchAccepted" in override) {
      delete (body as Record<string, unknown>).whatWeMatchAccepted;
    }
    if (
      (override as Record<string, unknown>).pathAcknowledgmentAccepted === undefined &&
      "pathAcknowledgmentAccepted" in override
    ) {
      delete (body as Record<string, unknown>).pathAcknowledgmentAccepted;
    }
    const response = await call(signedPost(body));
    expect(response.status).toBe(400);
    expect(
      await prisma.beatQuoteSubmission.count({ where: { id: body.submissionId as string } })
    ).toBe(0);
  });
});

describe("retries converge on one submission", () => {
  it("a repeat with the same submissionId returns 200 and creates nothing new", async () => {
    const submissionId = randomUUID();
    const body = validBody({ submissionId });

    const first = await call(signedPost(body));
    expect(first.status).toBe(201);
    const second = await call(signedPost(body));
    expect(second.status).toBe(200);

    expect(await prisma.beatQuoteSubmission.count({ where: { id: submissionId } })).toBe(1);
    // AND the acknowledgments are not duplicated — writing them again would
    // imply the customer agreed twice.
    expect(await prisma.acknowledgment.count({ where: { submissionRef: submissionId } })).toBe(3);
  });

  it("a retry cannot REWRITE the frozen treatment by changing the quote date", async () => {
    // The tampering this guards: submit as an over-age quote, then retry the
    // same id claiming a fresh date. The first submission's facts stand.
    const submissionId = randomUUID();
    await call(signedPost(validBody({ submissionId, quoteIssuedOn: daysBefore(30) })));
    const retry = await call(signedPost(validBody({ submissionId, quoteIssuedOn: daysBefore(1) })));
    expect(retry.status).toBe(200);

    const row = await prisma.beatQuoteSubmission.findUniqueOrThrow({ where: { id: submissionId } });
    expect(row.treatment).toBe("review_only");
    expect(row.quoteAgeCalendarDays).toBe(30);
  });

  it("CONCURRENT identical requests produce exactly one submission and three acknowledgments", async () => {
    const submissionId = randomUUID();
    const body = validBody({ submissionId });
    const [a, b] = await Promise.all([call(signedPost(body)), call(signedPost(body))]);

    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(await prisma.beatQuoteSubmission.count({ where: { id: submissionId } })).toBe(1);
    expect(await prisma.acknowledgment.count({ where: { submissionRef: submissionId } })).toBe(3);
  });
});

describe("intake issues NO benefit, whatever the derived treatment", () => {
  it("a guarantee-eligible submission has no fallback benefit", async () => {
    // The spec's Implementation Principle: review is manual. Deriving
    // `guarantee` means "capable of carrying the guarantee", not that anything
    // is owed — a benefit requires a human to verify and to conclude we cannot
    // beat the price.
    const { json } = await submit({ quoteIssuedOn: daysBefore(0) });
    expect(json.treatment).toBe("guarantee");
    expect(
      await prisma.beatQuoteFallbackBenefit.count({ where: { submissionId: json.submissionId as string } })
    ).toBe(0);
  });

  it("and the submission starts unverified, in 'submitted'", async () => {
    const { json } = await submit({ quoteIssuedOn: daysBefore(0) });
    const row = await prisma.beatQuoteSubmission.findUniqueOrThrow({
      where: { id: json.submissionId as string },
    });
    expect(row.verification).toBe("pending");
    expect(row.status).toBe("submitted");
    expect(row.verifiedAt).toBeNull();
  });
});

describe("identity and transport", () => {
  it("refuses an unsigned request before anything else", async () => {
    const url = new URL(`https://shop.example.com/apps/carat/beat-quote-submission?shop=${SHOP}`);
    const response = await call(
      new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    );
    expect(response.status).toBe(401);
  });

  it("accepts a signed-out visitor — this is an acquisition feature", async () => {
    const { status, json } = await submit();
    expect(status).toBe(201);
    const row = await prisma.beatQuoteSubmission.findUniqueOrThrow({
      where: { id: json.submissionId as string },
    });
    expect(row.customerRef).toBeNull();
  });

  it("takes the customer identity from the SIGNED parameter, never the body", async () => {
    const { json } = await submit({ customerRef: undefined }, { authenticated: true });
    const row = await prisma.beatQuoteSubmission.findUniqueOrThrow({
      where: { id: json.submissionId as string },
    });
    expect(row.customerRef).toBe(`gid://shopify/Customer/${CUSTOMER}`);
  });

  it("REFUSES a body that tries to supply its own customerRef", async () => {
    const result = await submit({ customerRef: "gid://shopify/Customer/999999" });
    expect(result.status).toBe(400);
  });
});
