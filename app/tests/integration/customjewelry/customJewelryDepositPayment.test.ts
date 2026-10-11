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
/**
 * Returned as a FACTORY, matching the handler's lazy dependency. `calls`
 * counts how many times the factory was invoked, so a test can assert the
 * Admin client was never built for an order that is none of our business.
 */
function fakeAdmin(
  resultingOrderGidByDraft: Map<string, string | null>,
  options: { fail?: boolean } = {}
): (() => Promise<AdminGraphqlClient>) & { calls: () => number } {
  let calls = 0;
  const client: AdminGraphqlClient = {
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
  const factory = async () => {
    calls += 1;
    return client;
  };
  return Object.assign(factory, { calls: () => calls });
}

function fakeDraftOrders(gid: string): DraftOrderPort {
  return {
    // The fallback-benefit redemption path. Refused rather than stubbed
    // permissively: no Bank Payment, deposit or admin flow should ever create a
    // redemption draft order, so a call here is a defect worth failing on.
    async createRedemptionDraftOrder(): Promise<never> {
      throw new Error("createRedemptionDraftOrder is not expected in this test");
    },
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

describe("the project status only ever moves forward", () => {
  it("records the payment but does NOT drag a project backwards from a later status", async () => {
    // REACHABLE AS SOON AS A STAFF ACTION SETS `awaiting_approval`: a delayed
    // or redelivered `orders/paid` would arrive after it, and an
    // unconditional write would move the project back to `deposit_charged`.
    // A status silently going backwards on a money path is the kind of thing
    // a confused customer discovers for us.
    const fixture = await seedInvoicedProject();
    const orderGid = `gid://shopify/Order/${Date.now()}${++seq}`;

    // Simulates that staff action, which is the only way to reach this state.
    await prisma.customJewelryProject.update({
      where: { id: fixture.projectId },
      data: { status: "awaiting_approval" },
    });

    await handleCustomJewelryDepositOrderPaidWebhook(
      orderPaidEvent({
        orderGid,
        tags: [CUSTOM_JEWELRY_DEPOSIT_CLASS_TAG, `carat-project-${fixture.projectReference}`],
      }),
      { adminGraphql: fakeAdmin(new Map([[fixture.draftOrderGid, orderGid]])) }
    );

    // THE MONEY IS STILL RECORDED. Refusing the receipt because the project
    // had moved on would lose the fact that payment arrived, which is worse
    // than a status a human needs to look at.
    const payment = await prisma.customJewelryDepositPayment.findUniqueOrThrow({
      where: { invoiceId: fixture.invoiceId },
    });
    expect(payment.orderGid).toBe(orderGid);

    // AND THE STATUS IS UNTOUCHED.
    const project = await prisma.customJewelryProject.findUniqueOrThrow({ where: { id: fixture.projectId } });
    expect(project.status).toBe("awaiting_approval");

    // Surfaced for a human rather than silently absorbed.
    const audit = await prisma.auditEvent.findMany({
      where: { entityType: "custom_jewelry_deposit_payment", entityId: orderGid },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.reason).toContain("awaiting_approval");
  });

  it("still advances a project that IS at submitted — the guard is conditional, not a block", async () => {
    // Without this, the guard could be "never advance" and the case above
    // would still pass.
    const fixture = await seedInvoicedProject();
    const orderGid = `gid://shopify/Order/${Date.now()}${++seq}`;

    await handleCustomJewelryDepositOrderPaidWebhook(
      orderPaidEvent({
        orderGid,
        tags: [CUSTOM_JEWELRY_DEPOSIT_CLASS_TAG, `carat-project-${fixture.projectReference}`],
      }),
      { adminGraphql: fakeAdmin(new Map([[fixture.draftOrderGid, orderGid]])) }
    );

    const project = await prisma.customJewelryProject.findUniqueOrThrow({ where: { id: fixture.projectId } });
    expect(project.status).toBe("deposit_charged");
    // No anomaly for the normal path.
    expect(
      await prisma.auditEvent.count({
        where: { entityType: "custom_jewelry_deposit_payment", entityId: orderGid },
      })
    ).toBe(0);
  });
});

describe("duplicate delivery is inert, including after a refused advancement", () => {
  it("a redelivery after a REFUSED advancement writes no SECOND anomaly", async () => {
    // THE SUBTLE ONE. The first delivery records the payment and declines to
    // move the status, writing one anomaly. On every later delivery the status
    // STILL does not equal `submitted` — so a handler that re-derived the
    // anomaly from "status != predecessor" would write a fresh entry each
    // time, and a human triaging them would see a growing pile describing one
    // event. The `invoice.payment` check returns before the status logic is
    // reached, which is what prevents it.
    const fixture = await seedInvoicedProject();
    const orderGid = `gid://shopify/Order/${Date.now()}${++seq}`;
    const admin = fakeAdmin(new Map([[fixture.draftOrderGid, orderGid]]));
    const makeEvent = () =>
      orderPaidEvent({
        orderGid,
        tags: [CUSTOM_JEWELRY_DEPOSIT_CLASS_TAG, `carat-project-${fixture.projectReference}`],
      });

    await prisma.customJewelryProject.update({
      where: { id: fixture.projectId },
      data: { status: "awaiting_approval" },
    });

    await handleCustomJewelryDepositOrderPaidWebhook(makeEvent(), { adminGraphql: admin });
    // Two more deliveries with FRESH event ids — i.e. reaching the handler
    // rather than being deduped upstream by the receive layer.
    await handleCustomJewelryDepositOrderPaidWebhook(makeEvent(), { adminGraphql: admin });
    await handleCustomJewelryDepositOrderPaidWebhook(makeEvent(), { adminGraphql: admin });

    expect(
      await prisma.auditEvent.count({
        where: { entityType: "custom_jewelry_deposit_payment", entityId: orderGid },
      }),
      "one event produced one anomaly, however many times it was delivered"
    ).toBe(1);
    expect(await prisma.customJewelryDepositPayment.count({ where: { invoiceId: fixture.invoiceId } })).toBe(1);
    expect((await prisma.customJewelryProject.findUniqueOrThrow({ where: { id: fixture.projectId } })).status).toBe(
      "awaiting_approval"
    );
  });

  it("an already-deposit_charged project neither regresses nor advances again", async () => {
    const fixture = await seedInvoicedProject();
    const orderGid = `gid://shopify/Order/${Date.now()}${++seq}`;
    const admin = fakeAdmin(new Map([[fixture.draftOrderGid, orderGid]]));
    const makeEvent = () =>
      orderPaidEvent({
        orderGid,
        tags: [CUSTOM_JEWELRY_DEPOSIT_CLASS_TAG, `carat-project-${fixture.projectReference}`],
      });

    await handleCustomJewelryDepositOrderPaidWebhook(makeEvent(), { adminGraphql: admin });
    expect((await prisma.customJewelryProject.findUniqueOrThrow({ where: { id: fixture.projectId } })).status).toBe(
      "deposit_charged"
    );

    await handleCustomJewelryDepositOrderPaidWebhook(makeEvent(), { adminGraphql: admin });

    expect((await prisma.customJewelryProject.findUniqueOrThrow({ where: { id: fixture.projectId } })).status).toBe(
      "deposit_charged"
    );
    expect(await prisma.customJewelryDepositPayment.count({ where: { invoiceId: fixture.invoiceId } })).toBe(1);
    // No anomaly on the normal redelivery path — the status equalling
    // `deposit_charged` is exactly what the first delivery achieved.
    expect(
      await prisma.auditEvent.count({
        where: { entityType: "custom_jewelry_deposit_payment", entityId: orderGid },
      })
    ).toBe(0);
  });

  it("TWO CONCURRENT deliveries record one payment, with no error and no anomaly", async () => {
    // Both pass the `invoice.payment` check before either writes, so the
    // UNIQUE indexes decide it. The loser used to let P2002 propagate, which
    // returned 500 and asked Shopify to redeliver a payment that had already
    // been recorded correctly — noise shaped exactly like a money-path error.
    const fixture = await seedInvoicedProject();
    const orderGid = `gid://shopify/Order/${Date.now()}${++seq}`;
    const admin = fakeAdmin(new Map([[fixture.draftOrderGid, orderGid]]));
    const makeEvent = () =>
      orderPaidEvent({
        orderGid,
        tags: [CUSTOM_JEWELRY_DEPOSIT_CLASS_TAG, `carat-project-${fixture.projectReference}`],
      });

    // NEITHER may reject — the race is routine, not a failure.
    await expect(
      Promise.all([
        handleCustomJewelryDepositOrderPaidWebhook(makeEvent(), { adminGraphql: admin }),
        handleCustomJewelryDepositOrderPaidWebhook(makeEvent(), { adminGraphql: admin }),
      ])
    ).resolves.toBeDefined();

    expect(await prisma.customJewelryDepositPayment.count({ where: { invoiceId: fixture.invoiceId } })).toBe(1);
    expect((await prisma.customJewelryProject.findUniqueOrThrow({ where: { id: fixture.projectId } })).status).toBe(
      "deposit_charged"
    );
    expect(
      await prisma.auditEvent.count({
        where: { entityType: "custom_jewelry_deposit_payment", entityId: orderGid },
      }),
      "a routine race must not produce an entry a human has to triage"
    ).toBe(0);
  });

  it("the same ORDER cannot be used to pay a SECOND invoice", async () => {
    // `order_gid` is UNIQUE independently of `invoice_id`: one payment, one
    // order. Asserted by direct SQL because no code path should be able to
    // reach it, which is precisely why the index rather than a check is what
    // guarantees it.
    const paid = await seedInvoicedProject();
    const other = await seedInvoicedProject();
    const orderGid = `gid://shopify/Order/${Date.now()}${++seq}`;

    await handleCustomJewelryDepositOrderPaidWebhook(
      orderPaidEvent({
        orderGid,
        tags: [CUSTOM_JEWELRY_DEPOSIT_CLASS_TAG, `carat-project-${paid.projectReference}`],
      }),
      { adminGraphql: fakeAdmin(new Map([[paid.draftOrderGid, orderGid]])) }
    );

    await expect(
      prisma.$executeRaw`
        INSERT INTO "custom_jewelry_deposit_payment"
          ("id", "invoice_id", "order_gid", "amount_minor_units", "currency", "paid_at")
        VALUES (gen_random_uuid(), ${other.invoiceId}::uuid, ${orderGid}, 4900, 'USD', now())`
    ).rejects.toThrow();
  });
});

describe("orders that are not ours are ignored silently, and cost nothing", () => {
  it("does nothing for an order with no deposit tag, and NEVER builds an Admin client", async () => {
    // THIS ASSERTION EXISTS BECAUSE A LIVE TEST DELIVERY FOUND THE BUG. The
    // route originally built the Admin client before the handler ran, so every
    // Buy Now and Group Buy order depended on a session lookup it never needed
    // — and a delivery for an unknown shop returned 500, asking Shopify to
    // redeliver an order the handler would have ignored. A transient session
    // problem would have done the same to real customer orders.
    //
    // Counting factory invocations is what makes the fix provable: a lazily
    // resolved client that is still resolved eagerly looks identical from the
    // outside until something upstream fails.
    const before = await prisma.customJewelryDepositPayment.count();
    const admin = fakeAdmin(new Map(), { fail: true });

    await handleCustomJewelryDepositOrderPaidWebhook(
      orderPaidEvent({ orderGid: `gid://shopify/Order/${Date.now()}`, tags: ["carat-group-buy"] }),
      { adminGraphql: admin }
    );

    expect(admin.calls(), "an order that is not a deposit must not cost a Shopify session lookup").toBe(0);
    expect(await prisma.customJewelryDepositPayment.count()).toBe(before);
  });

  it("does not build an Admin client for a deposit-tagged order with no invoice either", async () => {
    // The lookup is only needed to VERIFY an invoice. With no invoice there is
    // nothing to verify, so this must also stay free.
    const admin = fakeAdmin(new Map(), { fail: true });
    await handleCustomJewelryDepositOrderPaidWebhook(
      orderPaidEvent({
        orderGid: `gid://shopify/Order/${Date.now()}${++seq}`,
        tags: [CUSTOM_JEWELRY_DEPOSIT_CLASS_TAG, "carat-project-CJ-NOSUCHREF2"],
      }),
      { adminGraphql: admin }
    );
    expect(admin.calls()).toBe(0);
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
