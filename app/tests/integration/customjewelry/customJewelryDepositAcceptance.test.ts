import { createHmac, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  CUSTOM_JEWELRY_DEPOSIT_ACKNOWLEDGMENT_TEXT,
  CUSTOM_JEWELRY_DEPOSIT_AFFIRMATIVE_ACTION_LABEL,
  CUSTOM_JEWELRY_DEPOSIT_POLICY_SLUG,
} from "~/domain/customjewelry/designDepositAcknowledgmentText";
import { action as acceptanceAction } from "~/routes/apps.carat.custom-jewelry-deposit-acceptance";
import { action as intakeAction } from "~/routes/apps.carat.custom-jewelry-intake";

/**
 * The Design Deposit acceptance path, against real Postgres.
 *
 * This is the record that a customer agreed to a charge. Every assertion here
 * is about whether that record can be trusted afterwards: that it names the
 * text actually shown, that it cannot be created for someone else's project,
 * that it cannot exist twice, and that it cannot be altered once written.
 */

const SHOP = "caratforus-dev.myshopify.com";
const CUSTOMER_A = "881111";
const CUSTOMER_A_GID = `gid://shopify/Customer/${CUSTOMER_A}`;
const CUSTOMER_B = "882222";

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

  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function call(fn: typeof intakeAction, request: Request) {
  return fn({ request, params: {}, context: {} } as never);
}

/** Creates a project owned by `customerId` and returns its primary key. */
async function seedProject(customerId: string): Promise<{ id: string; projectReference: string }> {
  const response = await call(
    intakeAction,
    signedPost("/apps/carat/custom-jewelry-intake", { shop: SHOP, logged_in_customer_id: customerId }, {
      firstName: "Ada",
      lastName: "Lovelace",
      email: `ada-${uniq()}@example.com`,
      phone: "+1 555 0100",
      startingPoint: "from_scratch",
      promptText: "A signet ring reworked from my grandmother's.",
      followUpPreference: "contact_me",
    })
  );
  expect(response.status).toBe(201);
  const { projectReference } = (await response.json()) as { projectReference: string };
  const project = await prisma.customJewelryProject.findUniqueOrThrow({ where: { projectReference } });
  return { id: project.id, projectReference };
}

function accept(customerId: string | null, body: unknown) {
  return call(
    acceptanceAction,
    signedPost(
      "/apps/carat/custom-jewelry-deposit-acceptance",
      customerId ? { shop: SHOP, logged_in_customer_id: customerId } : { shop: SHOP },
      body
    )
  );
}

describe("accepting the deposit terms records trustworthy evidence", () => {
  it("records the EXACT pinned text, the policy version, the label clicked, and the frozen amount", async () => {
    const project = await seedProject(CUSTOMER_A);

    const response = await accept(CUSTOMER_A, { projectId: project.id, depositTermsAccepted: true });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { projectReference: string; alreadyAccepted: boolean };
    expect(body.projectReference).toBe(project.projectReference);
    expect(body.alreadyAccepted).toBe(false);

    const acceptance = await prisma.customJewelryDepositAcceptance.findUniqueOrThrow({
      where: { projectId: project.id },
      include: { acknowledgment: { include: { policyVersion: true } } },
    });

    // THE TEXT IS THE EVIDENCE. Asserted against the constant, so a reworded
    // acknowledgment cannot pass by matching whatever the route happened to
    // write.
    expect(acceptance.acknowledgment.exactText).toBe(CUSTOM_JEWELRY_DEPOSIT_ACKNOWLEDGMENT_TEXT);
    expect(acceptance.acknowledgment.affirmativeActionLabel).toBe(CUSTOM_JEWELRY_DEPOSIT_AFFIRMATIVE_ACTION_LABEL);
    expect(acceptance.acknowledgment.policyVersion.slug).toBe(CUSTOM_JEWELRY_DEPOSIT_POLICY_SLUG);
    expect(acceptance.acknowledgment.customerRef).toBe(CUSTOMER_A_GID);

    // THE AMOUNT IS FROZEN. Integer minor units, matching the $49 the
    // disclosure states.
    expect(acceptance.amountMinorUnits).toBe(4900n);
    expect(acceptance.currency).toBe("USD");
    expect(acceptance.customerRef).toBe(CUSTOMER_A_GID);
  });

  it("stores the acknowledgment's text, not a value the browser supplied", async () => {
    const project = await seedProject(CUSTOMER_A);
    // A client claiming weaker terms must not be able to substitute them.
    // `.strict()` refuses the unknown field outright, which is the stronger
    // outcome: the attempt never reaches the writer at all.
    const response = await accept(CUSTOMER_A, {
      projectId: project.id,
      depositTermsAccepted: true,
      exactText: "I agree to nothing in particular.",
    });
    expect(response.status).toBe(400);
    expect(await prisma.customJewelryDepositAcceptance.findUnique({ where: { projectId: project.id } })).toBeNull();
  });

  it("does NOT advance the project status — this authorizes, it does not charge", async () => {
    const project = await seedProject(CUSTOMER_A);
    await accept(CUSTOMER_A, { projectId: project.id, depositTermsAccepted: true });

    const after = await prisma.customJewelryProject.findUniqueOrThrow({ where: { id: project.id } });
    // `deposit_charged` means money arrived. Setting it here would start
    // design work against funds that may never be collected.
    expect(after.status).toBe("submitted");
  });
});

describe("an account is required, and the project must be the caller's", () => {
  it("REFUSES an anonymous caller", async () => {
    const project = await seedProject(CUSTOMER_A);
    const response = await accept(null, { projectId: project.id, depositTermsAccepted: true });
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toBe("authentication_required");
    expect(await prisma.customJewelryDepositAcceptance.findUnique({ where: { projectId: project.id } })).toBeNull();
  });

  it("REFUSES someone else's project, indistinguishably from one that does not exist", async () => {
    const project = await seedProject(CUSTOMER_A);

    const stolen = await accept(CUSTOMER_B, { projectId: project.id, depositTermsAccepted: true });
    expect(stolen.status).toBe(422);
    expect(((await stolen.json()) as { error: string }).error).toBe("project_unresolved");

    const absent = await accept(CUSTOMER_B, { projectId: randomUUID(), depositTermsAccepted: true });
    expect(absent.status).toBe(422);
    expect(((await absent.json()) as { error: string }).error).toBe("project_unresolved");

    expect(await prisma.customJewelryDepositAcceptance.findUnique({ where: { projectId: project.id } })).toBeNull();
  });

  it("refuses an unsigned request before anything else", async () => {
    const url = new URL(`https://shop.example.com/apps/carat/custom-jewelry-deposit-acceptance?shop=${SHOP}`);
    const response = await call(
      acceptanceAction,
      new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    );
    expect(response.status).toBe(401);
  });
});

describe("acceptance must be affirmative — never inferred, never defaulted", () => {
  it.each([
    ["omitted", {}],
    ["false", { depositTermsAccepted: false }],
    ["the string 'true'", { depositTermsAccepted: "true" }],
    ["1", { depositTermsAccepted: 1 }],
  ])("REFUSES when the acceptance flag is %s", async (_label, extra) => {
    const project = await seedProject(CUSTOMER_A);
    const response = await accept(CUSTOMER_A, { projectId: project.id, ...extra });
    expect(response.status).toBe(400);
    expect(await prisma.customJewelryDepositAcceptance.findUnique({ where: { projectId: project.id } })).toBeNull();
  });
});

describe("one acceptance per project", () => {
  it("answers a repeat with the EXISTING acceptance and 200, not an error", async () => {
    const project = await seedProject(CUSTOMER_A);

    const first = await accept(CUSTOMER_A, { projectId: project.id, depositTermsAccepted: true });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { acceptedAt: string };

    const second = await accept(CUSTOMER_A, { projectId: project.id, depositTermsAccepted: true });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { acceptedAt: string; alreadyAccepted: boolean };
    expect(secondBody.alreadyAccepted).toBe(true);
    // The ORIGINAL timestamp. A second acceptance overwriting the first would
    // move the moment the customer agreed, which is the one thing this record
    // exists to establish.
    expect(secondBody.acceptedAt).toBe(firstBody.acceptedAt);

    expect(await prisma.customJewelryDepositAcceptance.count({ where: { projectId: project.id } })).toBe(1);
  });

  it("RACE SAFETY: of two concurrent acceptances, exactly one row is written", async () => {
    const project = await seedProject(CUSTOMER_A);

    // Both pass the route's existence read before either writes — which is
    // exactly why the UNIQUE index, not that read, is the authority.
    const [a, b] = await Promise.all([
      accept(CUSTOMER_A, { projectId: project.id, depositTermsAccepted: true }),
      accept(CUSTOMER_A, { projectId: project.id, depositTermsAccepted: true }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(await prisma.customJewelryDepositAcceptance.count({ where: { projectId: project.id } })).toBe(1);
    // And exactly one acknowledgment — the loser's transaction rolled back,
    // so it left no orphan behind in an append-only table that could never
    // be cleaned up.
    expect(
      await prisma.acknowledgment.count({
        where: { submissionRef: project.id, policyVersion: { slug: CUSTOM_JEWELRY_DEPOSIT_POLICY_SLUG } },
      })
    ).toBe(1);
  });
});

describe("the acceptance record cannot be altered once written", () => {
  it("rejects UPDATE at the database level", async () => {
    const project = await seedProject(CUSTOMER_A);
    await accept(CUSTOMER_A, { projectId: project.id, depositTermsAccepted: true });

    await expect(
      prisma.$executeRaw`UPDATE "custom_jewelry_deposit_acceptance" SET "amount_minor_units" = 100 WHERE "project_id" = ${project.id}::uuid`
    ).rejects.toThrow(/append-only/i);
  });

  it("rejects DELETE at the database level", async () => {
    const project = await seedProject(CUSTOMER_A);
    await accept(CUSTOMER_A, { projectId: project.id, depositTermsAccepted: true });

    await expect(
      prisma.$executeRaw`DELETE FROM "custom_jewelry_deposit_acceptance" WHERE "project_id" = ${project.id}::uuid`
    ).rejects.toThrow(/append-only/i);
  });

  it("rejects TRUNCATE at the database level, AND still carries its own guard", async () => {
    // The guard the first pass at append-only protection missed, because
    // TRUNCATE is neither an UPDATE nor a DELETE. Two of three guards looks
    // protected and is not.
    //
    // THIS ASSERTION USED TO READ `.rejects.toThrow(/append-only/i)` AND
    // BROKE WHEN THE INVOICE TABLE LANDED. Postgres refuses to truncate a
    // table referenced by a foreign key, and it checks that BEFORE firing
    // BEFORE TRUNCATE triggers — so the error became `0A000 cannot truncate
    // a table referenced in a foreign key constraint` and the trigger never
    // ran. The table is MORE protected than before, not less.
    //
    // But that is exactly how a guard disappears unnoticed: the FK now masks
    // the trigger, so deleting the trigger would change nothing observable
    // here, and dropping the invoice table later would silently remove the
    // protection with it. So this asserts both halves — that TRUNCATE is
    // refused for whatever reason, and that the trigger is still present.
    await expect(prisma.$executeRawUnsafe(`TRUNCATE TABLE "custom_jewelry_deposit_acceptance"`)).rejects.toThrow();

    const triggers = await prisma.$queryRaw<{ tgname: string }[]>`
      SELECT t.tgname
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.relname = 'custom_jewelry_deposit_acceptance'
         AND NOT t.tgisinternal`;
    const names = triggers.map((t) => t.tgname);
    expect(names, "the append-only TRUNCATE guard is missing — the FK is masking its absence").toContain(
      "custom_jewelry_deposit_acceptance_no_truncate"
    );
    expect(names).toContain("custom_jewelry_deposit_acceptance_no_update");
    expect(names).toContain("custom_jewelry_deposit_acceptance_no_delete");
  });

  it("refuses to delete a project that has an acceptance", async () => {
    const project = await seedProject(CUSTOMER_A);
    await accept(CUSTOMER_A, { projectId: project.id, depositTermsAccepted: true });

    // ON DELETE RESTRICT. Deleting a project must not be able to silently
    // destroy the record of a customer authorizing a charge.
    await expect(prisma.customJewelryProject.delete({ where: { id: project.id } })).rejects.toThrow();
  });
});

describe("a deposit of zero or less is unrepresentable", () => {
  it("the CHECK constraint refuses it even by direct SQL", async () => {
    const project = await seedProject(CUSTOMER_A);
    const acknowledgment = await prisma.acknowledgment.findFirst({ select: { id: true } });
    expect(acknowledgment, "no acknowledgment row to borrow for this probe").not.toBeNull();

    await expect(
      prisma.$executeRaw`
        INSERT INTO "custom_jewelry_deposit_acceptance"
          ("id", "project_id", "acknowledgment_id", "amount_minor_units", "currency", "customer_ref")
        VALUES (gen_random_uuid(), ${project.id}::uuid, ${acknowledgment!.id}::uuid, 0, 'USD', ${CUSTOMER_A_GID})`
    ).rejects.toThrow(/amount_positive/i);
  });
});
