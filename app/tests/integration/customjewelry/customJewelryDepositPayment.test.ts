import { createHmac, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { CUSTOM_JEWELRY_DEPOSIT_CLASS_TAG } from "~/domain/customjewelry/depositInvoice";
import { issueCustomJewelryDepositInvoice } from "~/jobs/customjewelry/issueDepositInvoice.server";
import { action as acceptanceAction } from "~/routes/apps.carat.custom-jewelry-deposit-acceptance";
import { action as intakeAction } from "~/routes/apps.carat.custom-jewelry-intake";
import { handleCustomJewelryDepositOrderPaidWebhook } from "~/shopify/webhooks/customJewelryDepositPaymentHandler.server";
import type { AdminGraphqlClient } from "~/shopify/admin/productClient.server";
import type { CreateServiceDraftOrderInput, CreatedDraftOrder, DraftOrderPort } from "~/shopify/admin/draftOrderAdapter.server";

/**
 * Recording that a Design Deposit was actually paid.
 *
 * The behaviour worth proving is the FAILURE TAXONOMY. A webhook handler that
 * throws on an un-retryable anomaly loops Shopify forever and buries the
 * anomaly in redelivery noise; one that stays silent on a real mismatch marks
 * the wrong deposit paid. So each case asserts both the outcome AND that
 * nothing was written.
 */

const SHOP = "caratforus-dev.myshopify.com";
const CUSTOMER = "771717";

let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${++seq}`;

function signedPost(path: string, query: Record<string, string>, body: unknown): Request {
  const secret = process.env.SHOPIFY_API_SECRET as string;
  const message = Object.entries(query)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("");
  const signature = createHmac("sha256", secret).update(message, "utf8").digest("hex");
  const url = new URL(`https://shop.example.com${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  url.searchParams.set("signature", signature);
  return new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function call(fn: typeof intakeAction, request: Request) {
  return fn({ request, params: {}, context: {} } as never);
}

/** An admin client that answers "which order did this draft order become?". */
function fakeAdmin(resultingOrderGidByDraft: Map<string, string | null>, options: { fail?: boolean } = {}): AdminGraphqlClient {
  return {
    async graphql(_query: string, opts?: { variables?: Record<string, unknown> }) {
      const id = String(opts?.variables?.id ?? "");
      if (options.fail) {
        // Shopify reports failures on HTTP 200 with a top-level `errors`.
        return { json: async () => ({ errors: [{ message: "Throttled" }] }) };
      }
      const order = resultingOrderGidByDraft.get(id) ?? null;
      return { json: async () => ({ data: { draftOrder: { id, order: order ? { id: order } : null } } }) };
    },
  };
}

function fakeDraftOrders(gid: string): DraftOrderPort {
  return {
    async createServiceDraftOrder(_input: CreateServiceDraftOrderInput): Promise<CreatedDraftOrder> {
      return { draftOrderGid: gid, invoiceUrl: null };
    },
    async createDraftOrder(): Promise<never> {
      throw new Error("not expected");
    },
    async sendInvoice(): Promise<never> {
      throw new Error("not expected");
    },
    async completeDraftOrder(): Promise<never> {
      throw new Error("not expected");
    },
    async cancelDraftOrder(): Promise<never> {
      throw new Error("not expected");
    },
  };
}

interface Fixture {
  projectId: string;
  projectReference: string;
  invoiceId: string;
  draftOrderGid: string;
}

/** A project with an accepted deposit and an issued invoice. */
async function seedInvoicedProject(): Promise<Fixture> {
  const response = await call(
    intakeAction,
    signedPost("/apps/carat/custom-jewelry-intake", { shop: SHOP, logged_in_customer_id: CUSTOMER }, {
      firstName: "Ada",
      lastName: "Lovelace",
      email: `paid-${uniq()}@example.com`,
      phone: "+1 555 0133",
      startingPoint: "from_scratch",
      promptText: "A signet ring.",
      followUpPreference: "contact_me",
    })
  );
  expect(response.status).toBe(201);
  const { projectReference } = (await response.json()) as { projectReference: string };
  const project = await prisma.customJewelryProject.findUniqueOrThrow({ where: { projectReference } });

  const accepted = await call(
    acceptanceAction,
    signedPost(
      "/apps/carat/custom-jewelry-deposit-acceptance",
      { shop: SHOP, logged_in_customer_id: CUSTOMER },
      { projectId: project.id, depositTermsAccepted: true }
    )
  );
  expect(accepted.status).toBe(201);

  const draftOrderGid = `gid://shopify/DraftOrder/${Date.now()}${++seq}`;
  const issued = await issueCustomJewelryDepositInvoice({
    projectId: project.id,
    issuedByActorRef: "staff:tester",
    draftOrders: fakeDraftOrders(draftOrderGid),
  });
  expect(issued.outcome).toBe("issued");

  const invoice = await prisma.customJewelryDepositInvoice.findUniqueOrThrow({ where: { draftOrderGid } });
  return { projectId: project.id, projectReference, invoiceId: invoice.id, draftOrderGid };
}

function orderPaidEvent(options: {
  orderGid: string;
  tags: string[];
  total?: string;
  currency?: string;
  processedAt?: string | null;
}) {
  const payload = {
    admin_graphql_api_id: options.orderGid,
    tags: options.tags.join(", "),
    current_total_price: options.total ?? "49.00",
    currency: options.currency ?? "USD",
    processed_at: options.processedAt === undefined ? "2026-10-09T12:00:00Z" : options.processedAt,
  };
  const rawBody = JSON.stringify(payload);
  return {
    shopifyEventId: randomUUID(),
    topic: "orders/paid",
    shopDomain: SHOP,
    rawBody,
    payload: JSON.parse(rawBody) as unknown,
  };
}

describe("a paid deposit order is recorded and advances the project", () => {
  it("records the OBSERVED amount and Shopify's own timestamp, and sets deposit_charged", async () => {
    const fixture = await seedInvoicedProject();
    const orderGid = `gid://shopify/Order/${Date.now()}${++seq}`;

    await handleCustomJewelryDepositOrderPaidWebhook(
      orderPaidEvent({
        orderGid,
        tags: [CUSTOM_JEWELRY_DEPOSIT_CLASS_TAG, `carat-project-${fixture.projectReference}`],
      }),
      { adminGraphql: fakeAdmin(new Map([[fixture.draftOrderGid, orderGid]])) }
    );

    const payment = await prisma.customJewelryDepositPayment.findUniqueOrThrow({
      where: { invoiceId: fixture.invoiceId },
    });
    expect(payment.orderGid).toBe(orderGid);
    expect(payment.amountMinorUnits).toBe(4900n);
    expect(payment.currency).toBe("USD");
    // SHOPIFY'S TIMESTAMP, not ours.
    expect(payment.paidAt.toISOString()).toBe("2026-10-09T12:00:00.000Z");

    const project = await prisma.customJewelryProject.findUniqueOrThrow({ where: { id: fixture.projectId } });
    expect(project.status).toBe("deposit_charged");
  });

  it("is idempotent under redelivery — a second delivery writes nothing new", async () => {
    const fixture = await seedInvoicedProject();
    const orderGid = `gid://shopify/Order/${Date.now()}${++seq}`;
    const admin = fakeAdmin(new Map([[fixture.draftOrderGid, orderGid]]));
    const makeEvent = () =>
      orderPaidEvent({
        orderGid,
        tags: [CUSTOM_JEWELRY_DEPOSIT_CLASS_TAG, `carat-project-${fixture.projectReference}`],
      });

    await handleCustomJewelryDepositOrderPaidWebhook(makeEvent(), { adminGraphql: admin });
    // A DIFFERENT event id, same order — i.e. a genuine redelivery reaching
    // the handler, not one the receive layer already deduped.
    await handleCustomJewelryDepositOrderPaidWebhook(makeEvent(), { adminGraphql: admin });

    expect(await prisma.customJewelryDepositPayment.count({ where: { invoiceId: fixture.invoiceId } })).toBe(1);
  });
});

describe("orders that are not ours are ignored silently", () => {
  it("does nothing for an order with no deposit tag", async () => {
    const before = await prisma.customJewelryDepositPayment.count();
    await handleCustomJewelryDepositOrderPaidWebhook(
      orderPaidEvent({ orderGid: `gid://shopify/Order/${Date.now()}`, tags: ["carat-group-buy"] }),
      // The admin client must never be consulted: most orders on the store are
      // not deposits, and a Shopify round trip per order would be waste.
      { adminGraphql: fakeAdmin(new Map(), { fail: true }) }
    );
    expect(await prisma.customJewelryDepositPayment.count()).toBe(before);
  });
});

describe("anomalies are recorded, not retried — a loop would bury them", () => {
  it("records NOTHING and writes an audit event when the draft order resolved to a DIFFERENT order", async () => {
    // The case the tag check cannot catch: tags are editable in the Shopify
    // admin, so they are a hint and Shopify is the authority.
    const fixture = await seedInvoicedProject();
    const realOrder = `gid://shopify/Order/${Date.now()}A`;
    const impostor = `gid://shopify/Order/${Date.now()}B`;

    await handleCustomJewelryDepositOrderPaidWebhook(
      orderPaidEvent({
        orderGid: impostor,
        tags: [CUSTOM_JEWELRY_DEPOSIT_CLASS_TAG, `carat-project-${fixture.projectReference}`],
      }),
      { adminGraphql: fakeAdmin(new Map([[fixture.draftOrderGid, realOrder]])) }
    );

    expect(await prisma.customJewelryDepositPayment.count({ where: { invoiceId: fixture.invoiceId } })).toBe(0);
    const project = await prisma.customJewelryProject.findUniqueOrThrow({ where: { id: fixture.projectId } });
    expect(project.status, "the project must not advance on an unverified order").toBe("submitted");

    const audit = await prisma.auditEvent.findMany({
      where: { entityType: "custom_jewelry_deposit_payment", entityId: impostor },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.reason).toContain(fixture.draftOrderGid);
  });

  it("records NOTHING when the paid amount differs from the invoice", async () => {
    // A draft order can be edited before the customer pays. Design work must
    // not start because something resembling the deposit arrived.
    const fixture = await seedInvoicedProject();
    const orderGid = `gid://shopify/Order/${Date.now()}${++seq}`;

    await handleCustomJewelryDepositOrderPaidWebhook(
      orderPaidEvent({
        orderGid,
        tags: [CUSTOM_JEWELRY_DEPOSIT_CLASS_TAG, `carat-project-${fixture.projectReference}`],
        total: "29.00",
      }),
      { adminGraphql: fakeAdmin(new Map([[fixture.draftOrderGid, orderGid]])) }
    );

    expect(await prisma.customJewelryDepositPayment.count({ where: { invoiceId: fixture.invoiceId } })).toBe(0);
    expect((await prisma.customJewelryProject.findUniqueOrThrow({ where: { id: fixture.projectId } })).status).toBe(
      "submitted"
    );
    const audit = await prisma.auditEvent.findMany({
      where: { entityType: "custom_jewelry_deposit_payment", entityId: orderGid },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.reason).toContain("29.00");
  });

  it("records NOTHING when the currency differs, even if the number matches", async () => {
    const fixture = await seedInvoicedProject();
    const orderGid = `gid://shopify/Order/${Date.now()}${++seq}`;

    await handleCustomJewelryDepositOrderPaidWebhook(
      orderPaidEvent({
        orderGid,
        tags: [CUSTOM_JEWELRY_DEPOSIT_CLASS_TAG, `carat-project-${fixture.projectReference}`],
        currency: "CAD",
      }),
      { adminGraphql: fakeAdmin(new Map([[fixture.draftOrderGid, orderGid]])) }
    );

    expect(await prisma.customJewelryDepositPayment.count({ where: { invoiceId: fixture.invoiceId } })).toBe(0);
  });

  it("records NOTHING for a deposit-tagged order with TWO project tags — ambiguity is not guessed at", async () => {
    const a = await seedInvoicedProject();
    const b = await seedInvoicedProject();
    const orderGid = `gid://shopify/Order/${Date.now()}${++seq}`;

    await handleCustomJewelryDepositOrderPaidWebhook(
      orderPaidEvent({
        orderGid,
        tags: [
          CUSTOM_JEWELRY_DEPOSIT_CLASS_TAG,
          `carat-project-${a.projectReference}`,
          `carat-project-${b.projectReference}`,
        ],
      }),
      { adminGraphql: fakeAdmin(new Map([[a.draftOrderGid, orderGid], [b.draftOrderGid, orderGid]])) }
    );

    expect(await prisma.customJewelryDepositPayment.count({ where: { invoiceId: a.invoiceId } })).toBe(0);
    expect(await prisma.customJewelryDepositPayment.count({ where: { invoiceId: b.invoiceId } })).toBe(0);
  });

  it("records NOTHING for a deposit-tagged order whose project has no invoice", async () => {
    const orderGid = `gid://shopify/Order/${Date.now()}${++seq}`;
    const before = await prisma.customJewelryDepositPayment.count();

    await handleCustomJewelryDepositOrderPaidWebhook(
      orderPaidEvent({ orderGid, tags: [CUSTOM_JEWELRY_DEPOSIT_CLASS_TAG, "carat-project-CJ-NOSUCHREF"] }),
      { adminGraphql: fakeAdmin(new Map()) }
    );

    expect(await prisma.customJewelryDepositPayment.count()).toBe(before);
    const audit = await prisma.auditEvent.findMany({
      where: { entityType: "custom_jewelry_deposit_payment", entityId: orderGid },
    });
    expect(audit).toHaveLength(1);
  });
});

describe("a transient Shopify failure DOES retry", () => {
  it("THROWS so Shopify redelivers, and records nothing in the meantime", async () => {
    // The one case where throwing is right: the next delivery can succeed.
    const fixture = await seedInvoicedProject();
    const orderGid = `gid://shopify/Order/${Date.now()}${++seq}`;

    await expect(
      handleCustomJewelryDepositOrderPaidWebhook(
        orderPaidEvent({
          orderGid,
          tags: [CUSTOM_JEWELRY_DEPOSIT_CLASS_TAG, `carat-project-${fixture.projectReference}`],
        }),
        { adminGraphql: fakeAdmin(new Map(), { fail: true }) }
      )
    ).rejects.toThrow(/could not resolve the draft order/i);

    expect(await prisma.customJewelryDepositPayment.count({ where: { invoiceId: fixture.invoiceId } })).toBe(0);
    expect((await prisma.customJewelryProject.findUniqueOrThrow({ where: { id: fixture.projectId } })).status).toBe(
      "submitted"
    );
  });
});

describe("the payment record cannot be altered once written", () => {
  it("rejects UPDATE and DELETE, and still carries all three guards", async () => {
    const fixture = await seedInvoicedProject();
    const orderGid = `gid://shopify/Order/${Date.now()}${++seq}`;
    await handleCustomJewelryDepositOrderPaidWebhook(
      orderPaidEvent({
        orderGid,
        tags: [CUSTOM_JEWELRY_DEPOSIT_CLASS_TAG, `carat-project-${fixture.projectReference}`],
      }),
      { adminGraphql: fakeAdmin(new Map([[fixture.draftOrderGid, orderGid]])) }
    );

    await expect(
      prisma.$executeRaw`UPDATE "custom_jewelry_deposit_payment" SET "amount_minor_units" = 1 WHERE "order_gid" = ${orderGid}`
    ).rejects.toThrow(/append-only/i);
    await expect(
      prisma.$executeRaw`DELETE FROM "custom_jewelry_deposit_payment" WHERE "order_gid" = ${orderGid}`
    ).rejects.toThrow(/append-only/i);
    await expect(prisma.$executeRawUnsafe(`TRUNCATE TABLE "custom_jewelry_deposit_payment"`)).rejects.toThrow();

    // Asserted explicitly, for the reason the acceptance table taught: a
    // foreign key from some future table would refuse the TRUNCATE before the
    // trigger ran, so a message match alone would stop proving the guard
    // exists.
    const triggers = await prisma.$queryRaw<{ tgname: string }[]>`
      SELECT t.tgname
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.relname = 'custom_jewelry_deposit_payment'
         AND NOT t.tgisinternal`;
    const names = triggers.map((t) => t.tgname);
    expect(names).toContain("custom_jewelry_deposit_payment_no_update");
    expect(names).toContain("custom_jewelry_deposit_payment_no_delete");
    expect(names).toContain("custom_jewelry_deposit_payment_no_truncate");
  });
});
