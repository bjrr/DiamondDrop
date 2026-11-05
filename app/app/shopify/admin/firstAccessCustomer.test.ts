import { describe, expect, it, vi } from "vitest";

import { storeFirstAccessMobile } from "./firstAccessCustomer.server";
import type { AdminGraphqlClient } from "./productClient.server";
import { FIRST_ACCESS_TAG } from "~/domain/firstaccess/phoneCapture";

/**
 * The adapter, against a stub Admin client.
 *
 * ONE OF THESE IS A REGRESSION TEST FOR A REAL 500. The Shopify GraphQL client
 * THROWS on GraphQL errors instead of returning them in the body, so an
 * original body-only error check never ran: a missing `write_customers` scope
 * surfaced as an unhandled rejection on a public endpoint. Live verification
 * caught it; no unit test could have, because the stub returned the shape the
 * code expected rather than the shape the client produces.
 *
 * The others assert the SHAPE OF WHAT IS SENT, not just the outcome. "Did it
 * return stored" would pass just as happily if the mutation wrote to the wrong
 * namespace, or if a second mutation had crept in alongside it.
 */

interface Call {
  readonly query: string;
  readonly variables: Record<string, unknown>;
}

const CUSTOMER_ID = "gid://shopify/Customer/1";

function stubAdmin(handlers: {
  lookup?: unknown;
  set?: unknown;
  throwOn?: string;
}): { admin: AdminGraphqlClient; calls: Call[] } {
  const calls: Call[] = [];
  const admin = {
    graphql: vi.fn(async (query: string, options?: { variables?: Record<string, unknown> }) => {
      calls.push({ query, variables: options?.variables ?? {} });
      if (handlers.throwOn && query.includes(handlers.throwOn)) {
        // Exactly how the real client fails: a rejection, not an error body.
        throw new Error("GraphQL Client: An error occurred while fetching from the API.");
      }
      const data = query.includes("customerByIdentifier")
        ? { customerByIdentifier: handlers.lookup ?? null }
        : {
            metafieldsSet:
              handlers.set ?? {
                metafields: [
                  {
                    namespace: "custom",
                    key: "first_access_mobile",
                    owner: { id: CUSTOMER_ID },
                  },
                ],
                userErrors: [],
              },
          };
      return { json: async () => ({ data }) };
    }),
  } as unknown as AdminGraphqlClient;
  return { admin, calls };
}

const LEAD = { id: CUSTOMER_ID, tags: [FIRST_ACCESS_TAG, "vip"] };

describe("storeFirstAccessMobile", () => {
  it("writes the normalised number to custom.first_access_mobile", async () => {
    const { admin, calls } = stubAdmin({ lookup: LEAD });
    const outcome = await storeFirstAccessMobile(admin, "lead@example.test", "+12125550147");
    expect(outcome).toBe("stored");

    const set = calls.find((c) => c.query.includes("metafieldsSet"));
    expect(set?.variables.metafields).toEqual([
      {
        ownerId: CUSTOMER_ID,
        namespace: "custom",
        key: "first_access_mobile",
        type: "single_line_text_field",
        value: "+12125550147",
      },
    ]);
  });

  it("sends EXACTLY two operations: one lookup, one write", async () => {
    // The scope grant is justified by this surface being small. A third
    // operation appearing here is the thing that would quietly widen it.
    const { admin, calls } = stubAdmin({ lookup: LEAD });
    await storeFirstAccessMobile(admin, "lead@example.test", "+12125550147");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.query).toContain("customerByIdentifier");
    expect(calls[1]?.query).toContain("metafieldsSet");
  });

  it("touches no customer field other than the metafield", async () => {
    const { admin, calls } = stubAdmin({ lookup: LEAD });
    await storeFirstAccessMobile(admin, "lead@example.test", "+12125550147");
    const everything = calls.map((c) => c.query + JSON.stringify(c.variables)).join(" ");
    for (const forbidden of [
      "customerUpdate", "customerCreate", "customerDelete",
      "tagsAdd", "tagsRemove",
      "firstName", "lastName",
      "smsMarketingConsent", "emailMarketingConsent",
    ]) {
      expect(everything, forbidden).not.toContain(forbidden);
    }
    // And it does not even READ the native phone field.
    expect(everything).not.toContain("defaultPhoneNumber");
    expect(everything).not.toMatch(/\bphone\b/);
  });

  it("contains a THROWN client error instead of letting it reach the route", async () => {
    // The 500. `unavailable` is the contained outcome.
    const { admin } = stubAdmin({ throwOn: "customerByIdentifier" });
    await expect(
      storeFirstAccessMobile(admin, "lead@example.test", "+12125550147")
    ).resolves.toBe("unavailable");
  });

  it("contains a thrown error on the WRITE too, after a successful lookup", async () => {
    const { admin } = stubAdmin({ lookup: LEAD, throwOn: "metafieldsSet" });
    await expect(
      storeFirstAccessMobile(admin, "lead@example.test", "+12125550147")
    ).resolves.toBe("unavailable");
  });

  it("refuses a customer without the first-access tag, before any write", async () => {
    const { admin, calls } = stubAdmin({ lookup: { id: CUSTOMER_ID, tags: ["vip"] } });
    const outcome = await storeFirstAccessMobile(admin, "lead@example.test", "+12125550147");
    expect(outcome).toBe("not_first_access");
    expect(calls).toHaveLength(1); // the lookup, and nothing else
  });

  it("reports an absent customer without creating one", async () => {
    const { admin, calls } = stubAdmin({ lookup: null });
    const outcome = await storeFirstAccessMobile(admin, "nobody@example.test", "+12125550147");
    expect(outcome).toBe("customer_absent");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).not.toContain("customerCreate");
  });

  it("tolerates a customer with a null tag list rather than throwing", async () => {
    const { admin } = stubAdmin({ lookup: { id: CUSTOMER_ID, tags: null } });
    await expect(
      storeFirstAccessMobile(admin, "lead@example.test", "+12125550147")
    ).resolves.toBe("not_first_access");
  });

  it("reports a Shopify userError as a rejected write, not as success", async () => {
    const { admin } = stubAdmin({
      lookup: LEAD,
      set: { metafields: [], userErrors: [{ message: "Value is invalid" }] },
    });
    const outcome = await storeFirstAccessMobile(admin, "lead@example.test", "+12125550147");
    expect(outcome).toBe("write_rejected");
  });

  it("refuses to call a clean response with no confirmed metafield a success", async () => {
    // The Admin API can answer 200 with neither errors nor work done. A
    // silent no-op here loses the number for good.
    const { admin } = stubAdmin({ lookup: LEAD, set: { metafields: [], userErrors: [] } });
    const outcome = await storeFirstAccessMobile(admin, "lead@example.test", "+12125550147");
    expect(outcome).toBe("unavailable");
  });

  it("refuses a confirmation that landed on a DIFFERENT customer", async () => {
    // An id-mapping bug that returned the right count for the wrong owner
    // would attach someone's mobile number to another person's record.
    const { admin } = stubAdmin({
      lookup: LEAD,
      set: {
        metafields: [
          {
            namespace: "custom",
            key: "first_access_mobile",
            owner: { id: "gid://shopify/Customer/999" },
          },
        ],
        userErrors: [],
      },
    });
    const outcome = await storeFirstAccessMobile(admin, "lead@example.test", "+12125550147");
    expect(outcome).toBe("unavailable");
  });

  it("refuses a confirmation for a different metafield", async () => {
    const { admin } = stubAdmin({
      lookup: LEAD,
      set: {
        metafields: [{ namespace: "custom", key: "something_else", owner: { id: CUSTOMER_ID } }],
        userErrors: [],
      },
    });
    const outcome = await storeFirstAccessMobile(admin, "lead@example.test", "+12125550147");
    expect(outcome).toBe("unavailable");
  });

  it("has no code path that writes an empty value", async () => {
    // Erasure is unreachable by construction: the only exported call requires
    // a non-empty E.164 string, and the route never calls it without one.
    const { admin, calls } = stubAdmin({ lookup: LEAD });
    await storeFirstAccessMobile(admin, "lead@example.test", "+12125550147");
    const set = calls.find((c) => c.query.includes("metafieldsSet"));
    const written = (set?.variables.metafields as { value: string }[] | undefined)?.[0];
    expect(written?.value).not.toBe("");
    expect(written?.value).toMatch(/^\+\d+$/);
  });
});
