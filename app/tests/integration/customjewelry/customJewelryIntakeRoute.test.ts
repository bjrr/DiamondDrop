import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { action } from "~/routes/apps.carat.custom-jewelry-intake";

/**
 * The Custom Jewelry intake route against real Postgres.
 *
 * THE ANONYMOUS CASE IS THE ONE THAT MATTERS MOST HERE. This is the only
 * customer-facing `apps.carat.*` action that accepts a signed-out visitor, so
 * the tests have to prove BOTH directions: that signing out does not block an
 * enquiry, and that being signed out does not quietly grant anything either.
 */

const SHOP = "caratforus-dev.myshopify.com";
let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${++seq}`;

function signedPost(query: Record<string, string>, body: unknown): Request {
  const secret = process.env.SHOPIFY_API_SECRET as string;
  const message = Object.entries(query)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("");
  const signature = createHmac("sha256", secret).update(message, "utf8").digest("hex");

  const url = new URL("https://shop.example.com/apps/carat/custom-jewelry-intake");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  url.searchParams.set("signature", signature);

  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function baseBody(overrides: Record<string, unknown> = {}) {
  return {
    firstName: "Ada",
    lastName: "Lovelace",
    email: `ada-${uniq()}@example.com`,
    phone: "+1 555 0100",
    startingPoint: "from_scratch",
    promptText: "A signet ring reworked from my grandmother's, keeping the original stone.",
    followUpPreference: "contact_me",
    ...overrides,
  };
}

function call(request: Request) {
  return action({ request, params: {}, context: {} } as never);
}

describe("intake is open to signed-out visitors, by design", () => {
  it("ACCEPTS an enquiry with no logged_in_customer_id", async () => {
    const response = await call(signedPost({ shop: SHOP }, baseBody()));
    expect(response.status).toBe(201);

    const body = (await response.json()) as { projectReference: string; status: string };
    expect(body.projectReference).toMatch(/^CJ-/);
    expect(body.status).toBe("submitted");

    const row = await prisma.customJewelryProject.findUniqueOrThrow({
      where: { projectReference: body.projectReference },
    });
    expect(row.customerRef).toBeNull();
  });

  it("links the project when the proxy DOES assert a customer", async () => {
    const response = await call(signedPost({ shop: SHOP, logged_in_customer_id: "445566" }, baseBody()));
    expect(response.status).toBe(201);
    const { projectReference } = (await response.json()) as { projectReference: string };

    const row = await prisma.customJewelryProject.findUniqueOrThrow({ where: { projectReference } });
    expect(row.customerRef).toBe("gid://shopify/Customer/445566");
  });

  it("STILL REFUSES AN UNSIGNED REQUEST — 'no account' is not 'no caller authentication'", async () => {
    // Without this the endpoint would be reachable from the open internet,
    // not merely from the storefront.
    const url = new URL("https://shop.example.com/apps/carat/custom-jewelry-intake?shop=" + SHOP);
    const response = await call(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(baseBody()),
      })
    );
    expect(response.status).toBe(401);
  });

  it("NEVER takes the customer identity from the body", async () => {
    // A signed-out visitor claiming to be someone must not become them. The
    // schema is `.strict()`, so the smuggled field is refused outright rather
    // than ignored — "ignored" and "honoured" look identical from outside.
    const response = await call(
      signedPost({ shop: SHOP }, baseBody({ customerRef: "gid://shopify/Customer/999999" }))
    );
    expect(response.status).toBe(400);
  });
});

describe("intake records the enquiry without touching money", () => {
  it("accepts a budget as MINOR UNITS IN A STRING, never a JSON number", async () => {
    const response = await call(
      signedPost(
        { shop: SHOP },
        baseBody({ approximateBudgetMinorUnits: "350000", approximateBudgetCurrency: "usd" })
      )
    );
    expect(response.status).toBe(201);
    const { projectReference } = (await response.json()) as { projectReference: string };

    const row = await prisma.customJewelryProject.findUniqueOrThrow({ where: { projectReference } });
    expect(row.approximateBudgetMinorUnits).toBe(350000n);
    // Normalised, so "usd" and "USD" cannot become two currencies.
    expect(row.approximateBudgetCurrency).toBe("USD");
  });

  it("refuses a budget sent as a JSON number", async () => {
    // A JSON number is an IEEE double. Money is not.
    const response = await call(
      signedPost({ shop: SHOP }, baseBody({ approximateBudgetMinorUnits: 350000, approximateBudgetCurrency: "USD" }))
    );
    expect(response.status).toBe(400);
  });

  it("refuses half a budget, with a readable reason rather than a constraint name", async () => {
    const response = await call(signedPost({ shop: SHOP }, baseBody({ approximateBudgetMinorUnits: "5000" })));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { reason: string };
    expect(body.reason).toMatch(/amount and a currency/);
  });

  it("refuses a date AND no-deadline together", async () => {
    const response = await call(
      signedPost({ shop: SHOP }, baseBody({ desiredCompletionDate: "2027-06-01", hasNoDeadline: true }))
    );
    expect(response.status).toBe(400);
  });

  it("stores a desired date as the day the customer chose, not the day before", async () => {
    // Parsed as UTC midnight. Local-time parsing shifts a DATE column by a day
    // whenever the server sits west of the customer — quiet, and wrong.
    const response = await call(signedPost({ shop: SHOP }, baseBody({ desiredCompletionDate: "2027-06-01" })));
    expect(response.status).toBe(201);
    const { projectReference } = (await response.json()) as { projectReference: string };

    const row = await prisma.customJewelryProject.findUniqueOrThrow({ where: { projectReference } });
    expect(row.desiredCompletionDate?.toISOString().slice(0, 10)).toBe("2027-06-01");
  });

  it("keeps inspiration links as text and creates no order of any kind", async () => {
    const before = await prisma.customJewelryProject.count();
    const response = await call(
      signedPost({ shop: SHOP }, baseBody({ inspirationLinks: "https://example.com/a\nhttps://example.com/b" }))
    );
    expect(response.status).toBe(201);
    const { projectReference } = (await response.json()) as { projectReference: string };

    const row = await prisma.customJewelryProject.findUniqueOrThrow({ where: { projectReference } });
    expect(row.inspirationLinks).toContain("https://example.com/a");
    expect(row.status).toBe("submitted");
    expect(await prisma.customJewelryProject.count()).toBe(before + 1);
  });

  it("returns only the reference and status — no internal fields leak to the customer", async () => {
    const response = await call(signedPost({ shop: SHOP }, baseBody()));
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["projectReference", "status"]);
  });
});
