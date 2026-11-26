import { createHmac, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  BEAT_QUOTE_AUTHENTICITY_POLICY_VERSION,
  BEAT_QUOTE_AUTHENTICITY_TEXT,
  BEAT_QUOTE_GROUP_BUY_TEXT,
  BEAT_QUOTE_OLDER_QUOTE_TEXT,
  BEAT_QUOTE_ONLINE_LISTING_TEXT,
  BEAT_QUOTE_POLICY_SLUGS,
  BEAT_QUOTE_POLICY_VERSION,
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
  /**
   * OWNER DECISION 2026-11-26: THE RECENT-QUOTE PATH CARRIES NO PATH
   * ACKNOWLEDGMENT. The storefront shows no third checkbox for a quote inside
   * the 7 day window, so there is nothing to record, and a row written anyway
   * would assert an acceptance that never happened. The 7 day term itself is
   * unchanged and is still quoted on the page from its policy row.
   *
   * These two cases used to be one `it.each`. They are separate now because
   * the shapes genuinely differ, and a parameterised test that papered over
   * that would be asserting the weaker of the two.
   */
  it("a recent custom quote records NO path acknowledgment and echoes none back", async () => {
    const { status, json } = await submit({ kind: "custom_quote", quoteIssuedOn: daysBefore(2) });
    expect(status).toBe(201);

    // Nothing echoed, because nothing was shown or accepted.
    expect(json.acknowledgment).toBeUndefined();

    const rows = await prisma.acknowledgment.findMany({
      where: { submissionRef: json.submissionId as string },
      include: { policyVersion: true },
    });
    expect(rows).toHaveLength(2);
    const texts = rows.map((r) => r.exactText);
    expect(texts).toContain(BEAT_QUOTE_WHAT_WE_MATCH_TEXT);
    expect(texts).toContain(BEAT_QUOTE_AUTHENTICITY_TEXT);
    // THE ASSERTION THAT MATTERS. The 7 day wording must not be filed against
    // a submission whose customer was never shown it.
    expect(texts).not.toContain(BEAT_QUOTE_RECENT_QUOTE_TEXT);
    expect(rows.some((r) => r.policyVersion.slug === BEAT_QUOTE_POLICY_SLUGS.recentQuote)).toBe(false);
  });

  it("an older custom quote still gets the older-quote variant, recorded", async () => {
    const { json } = await submit({ kind: "custom_quote", quoteIssuedOn: daysBefore(20) });
    const ack = json.acknowledgment as Record<string, unknown>;
    expect(ack.id).toBe("older_quote");
    expect(ack.text).toBe(BEAT_QUOTE_OLDER_QUOTE_TEXT);

    // And the EVIDENCE row carries that exact text, not the response's.
    const rows = await prisma.acknowledgment.findMany({
      where: { submissionRef: json.submissionId as string },
      include: { policyVersion: true },
    });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.exactText)).toContain(BEAT_QUOTE_OLDER_QUOTE_TEXT);
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

  it("records each acknowledgment with its exact text and policy version", async () => {
    // A REVIEW-ONLY path, so all three are present. The recent-quote path's
    // two-row shape is asserted above.
    const { json } = await submit({ kind: "competing_group_buy", quoteIssuedOn: undefined });
    const rows = await prisma.acknowledgment.findMany({
      where: { submissionRef: json.submissionId as string },
      include: { policyVersion: true },
    });
    const texts = rows.map((r) => r.exactText);
    expect(texts).toContain(BEAT_QUOTE_WHAT_WE_MATCH_TEXT);
    expect(texts).toContain(BEAT_QUOTE_AUTHENTICITY_TEXT);
    expect(texts).toContain(BEAT_QUOTE_GROUP_BUY_TEXT);
    // Each names the version it was shown under, so a later wording change
    // cannot restate what this customer agreed to. THE SIX SLUGS VERSION
    // INDEPENDENTLY: the authenticity term was revised on 2026-11-25 and is at
    // version 2, the rest have never moved. Asserting a flat "1" here would
    // have failed on the revision, and asserting nothing would let a
    // submission record the OLD version's id against the NEW text, which is
    // the one outcome this whole acknowledgment system exists to prevent.
    for (const row of rows) {
      const expectedVersion =
        row.policyVersion.slug === BEAT_QUOTE_POLICY_SLUGS.authenticity
          ? BEAT_QUOTE_AUTHENTICITY_POLICY_VERSION
          : BEAT_QUOTE_POLICY_VERSION;
      expect(row.policyVersion.version, row.policyVersion.slug).toBe(expectedVersion);
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
    ["authenticityConfirmed omitted", { authenticityConfirmed: undefined }],
    // STILL REFUSED EVERYWHERE. The path box became optional in the schema so
    // the requirement could be decided from the derived treatment, but an
    // explicit `false` is an UNTICKED box and must never read as agreement on
    // any path.
    ["pathAcknowledgmentAccepted false", { pathAcknowledgmentAccepted: false }],
    ["pathAcknowledgmentAccepted the string 'true'", { pathAcknowledgmentAccepted: "true" }],
  ])("REFUSES when %s, and stores nothing", async (_label, override) => {
    const body = validBody(override);
    for (const key of ["whatWeMatchAccepted", "authenticityConfirmed", "pathAcknowledgmentAccepted"]) {
      if (key in override && (override as Record<string, unknown>)[key] === undefined) {
        delete (body as Record<string, unknown>)[key];
      }
    }
    const response = await call(signedPost(body));
    expect(response.status).toBe(400);
    expect(
      await prisma.beatQuoteSubmission.count({ where: { id: body.submissionId as string } })
    ).toBe(0);
  });

  /**
   * THE THREE REVIEW-ONLY PATHS STILL REQUIRE THE BOX. Each of them withdraws
   * something, and a customer who is not told plainly that there is no
   * guarantee and no fallback may reasonably believe there is one. Only the
   * recent-quote path lost its checkbox.
   */
  it.each([
    ["an older custom quote", { kind: "custom_quote", quoteIssuedOn: daysBefore(20) }],
    ["an online listing", { kind: "online_listing", quoteIssuedOn: undefined }],
    ["a competing Group Buy", { kind: "competing_group_buy", quoteIssuedOn: undefined }],
  ])("REFUSES %s with the path box omitted, and stores nothing", async (_label, override) => {
    const body = validBody(override);
    delete (body as Record<string, unknown>).pathAcknowledgmentAccepted;

    const response = await call(signedPost(body));
    expect(response.status).toBe(422);
    const json = (await response.json()) as Record<string, unknown>;

    // A DISTINGUISHABLE code, so the storefront can show the checkbox rather
    // than tell the customer to try again.
    expect(json.error).toBe("path_acknowledgment_required");

    // And it hands back the exact text to display, so the customer can read
    // what they are being asked to accept.
    const ack = json.acknowledgment as Record<string, unknown>;
    expect(typeof ack.text).toBe("string");
    expect((ack.text as string).length).toBeGreaterThan(0);
    expect(typeof ack.version).toBe("number");
    expect(typeof ack.affirmativeActionLabel).toBe("string");

    // NOTHING WAS WRITTEN. Not the submission, and above all not an
    // acknowledgment the customer never ticked.
    expect(
      await prisma.beatQuoteSubmission.count({ where: { id: body.submissionId as string } })
    ).toBe(0);
    expect(
      await prisma.acknowledgment.count({ where: { submissionRef: body.submissionId as string } })
    ).toBe(0);
  });

  /**
   * THE BOUNDARY CASE THE NEW ERROR EXISTS FOR. The storefront picks which
   * checkbox to show from the VISITOR's clock; the server derives the
   * treatment from the STORE's calendar. At the 7 day boundary they can
   * disagree by a day, so a customer can omit the box in good faith believing
   * their quote is recent while the server derives `older_quote`.
   *
   * The refusal names the older-quote wording specifically, which is what lets
   * the storefront show that exact checkbox and let them resubmit on the same
   * id.
   */
  it("names the older-quote wording when the server disagrees about recency", async () => {
    const body = validBody({ kind: "custom_quote", quoteIssuedOn: daysBefore(8) });
    delete (body as Record<string, unknown>).pathAcknowledgmentAccepted;

    const response = await call(signedPost(body));
    expect(response.status).toBe(422);
    const json = (await response.json()) as Record<string, unknown>;
    const ack = json.acknowledgment as Record<string, unknown>;
    expect(ack.id).toBe("older_quote");
    expect(ack.text).toBe(BEAT_QUOTE_OLDER_QUOTE_TEXT);
    // Never the guarantee wording. Handing that back on a refusal would show
    // the customer a promise this submission cannot carry.
    expect(ack.text).not.toBe(BEAT_QUOTE_RECENT_QUOTE_TEXT);
  });

  /**
   * AND IT ACCEPTS THE KEY BEING ABSENT ON THE PATH THAT NO LONGER SENDS IT,
   * which is the whole point of the change. Asserted together with "stores no
   * third row" because accepting the submission while quietly filing the 7 day
   * acknowledgment anyway would be the worst of both.
   */
  it("ACCEPTS a recent custom quote with the path box absent, and files no third row", async () => {
    const body = validBody({ kind: "custom_quote", quoteIssuedOn: daysBefore(1) });
    delete (body as Record<string, unknown>).pathAcknowledgmentAccepted;

    const response = await call(signedPost(body));
    expect(response.status).toBe(201);
    expect(
      await prisma.acknowledgment.count({ where: { submissionRef: body.submissionId as string } })
    ).toBe(2);
  });

  /**
   * THE ROLLOUT CASE. The deployed storefront still sends `true` for a recent
   * quote, and it keeps sending it until the theme is pushed. Accepted and
   * DISCARDED: the submission succeeds, and no 7 day acknowledgment is filed
   * from it. If this refused, every live submission would break between the
   * app deploy and the theme push.
   */
  it("accepts and DISCARDS a path affirmation sent for a recent quote", async () => {
    const { status, json } = await submit({
      kind: "custom_quote",
      quoteIssuedOn: daysBefore(1),
      pathAcknowledgmentAccepted: true,
    });
    expect(status).toBe(201);
    const rows = await prisma.acknowledgment.findMany({
      where: { submissionRef: json.submissionId as string },
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.exactText)).not.toContain(BEAT_QUOTE_RECENT_QUOTE_TEXT);
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
    // imply the customer agreed twice. TWO, not three: the default body is a
    // recent custom quote, which carries no path acknowledgment.
    expect(await prisma.acknowledgment.count({ where: { submissionRef: submissionId } })).toBe(2);
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

  it("CONCURRENT identical requests produce exactly one submission and one set of acknowledgments", async () => {
    const submissionId = randomUUID();
    const body = validBody({ submissionId });
    const [a, b] = await Promise.all([call(signedPost(body)), call(signedPost(body))]);

    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(await prisma.beatQuoteSubmission.count({ where: { id: submissionId } })).toBe(1);
    expect(await prisma.acknowledgment.count({ where: { submissionRef: submissionId } })).toBe(2);
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
