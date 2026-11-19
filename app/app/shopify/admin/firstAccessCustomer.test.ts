import { describe, expect, it, vi } from "vitest";

import {
  lookupFirstAccessCustomer,
  recordFirstAccessSmsConsent,
  storeFirstAccessMobile,
} from "./firstAccessCustomer.server";
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
    const outcome = await storeFirstAccessMobile(admin, CUSTOMER_ID, "+12125550147");
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

  it("sends EXACTLY ONE operation, because the lookup is now its own function", async () => {
    // The scope grant is justified by this surface being small. A third
    // operation appearing here is the thing that would quietly widen it.
    const { admin, calls } = stubAdmin({ lookup: LEAD });
    await storeFirstAccessMobile(admin, CUSTOMER_ID, "+12125550147");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).toContain("metafieldsSet");
    // And it no longer performs its own lookup: one signup, one read, done by
    // the caller through `lookupFirstAccessCustomer`.
    expect(calls.some((c) => c.query.includes("customerByIdentifier"))).toBe(false);
  });

  it("touches no customer field other than the metafield", async () => {
    const { admin, calls } = stubAdmin({ lookup: LEAD });
    await storeFirstAccessMobile(admin, CUSTOMER_ID, "+12125550147");
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

  // The thrown-lookup case moved with the lookup itself; see
  // `lookupFirstAccessCustomer`'s own describe. What this function can still
  // have thrown at it is the WRITE, covered immediately below.

  it("contains a thrown error on the WRITE too, after a successful lookup", async () => {
    const { admin } = stubAdmin({ lookup: LEAD, throwOn: "metafieldsSet" });
    await expect(
      storeFirstAccessMobile(admin, CUSTOMER_ID, "+12125550147")
    ).resolves.toBe("unavailable");
  });

  // The gate and the absent-customer cases now belong to
  // `lookupFirstAccessCustomer`, which owns the lookup. See its own describe
  // below — moved rather than deleted, because each one still pins a rule.

  it("reports a Shopify userError as a rejected write, not as success", async () => {
    const { admin } = stubAdmin({
      lookup: LEAD,
      set: { metafields: [], userErrors: [{ message: "Value is invalid" }] },
    });
    const outcome = await storeFirstAccessMobile(admin, CUSTOMER_ID, "+12125550147");
    expect(outcome).toBe("write_rejected");
  });

  it("refuses to call a clean response with no confirmed metafield a success", async () => {
    // The Admin API can answer 200 with neither errors nor work done. A
    // silent no-op here loses the number for good.
    const { admin } = stubAdmin({ lookup: LEAD, set: { metafields: [], userErrors: [] } });
    const outcome = await storeFirstAccessMobile(admin, CUSTOMER_ID, "+12125550147");
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
    const outcome = await storeFirstAccessMobile(admin, CUSTOMER_ID, "+12125550147");
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
    const outcome = await storeFirstAccessMobile(admin, CUSTOMER_ID, "+12125550147");
    expect(outcome).toBe("unavailable");
  });

  it("has no code path that writes an empty value", async () => {
    // Erasure is unreachable by construction: the only exported call requires
    // a non-empty E.164 string, and the route never calls it without one.
    const { admin, calls } = stubAdmin({ lookup: LEAD });
    await storeFirstAccessMobile(admin, CUSTOMER_ID, "+12125550147");
    const set = calls.find((c) => c.query.includes("metafieldsSet"));
    const written = (set?.variables.metafields as { value: string }[] | undefined)?.[0];
    expect(written?.value).not.toBe("");
    expect(written?.value).toMatch(/^\+\d+$/);
  });
});

/**
 * ============================================================================
 * THE LOOKUP AND ITS GATE, now a function of its own
 * ============================================================================
 * Extracted so one signup performs one read instead of up to three. The gate
 * moved with it, and that is the part worth testing: it returns a KIND rather
 * than an id for a customer this route may not touch, so there is no way for a
 * caller to obtain an id it should not have.
 */
describe("lookupFirstAccessCustomer", () => {
  it("returns the id for a first-access customer", async () => {
    const { admin } = stubAdmin({ lookup: LEAD });
    await expect(lookupFirstAccessCustomer(admin, "lead@example.test")).resolves.toEqual({
      kind: "found",
      customerId: CUSTOMER_ID,
    });
  });

  it("refuses a customer without the first-access tag, and hands back NO id", () => {
    // THE BLAST-RADIUS GATE. A real order-placing customer who never signed up
    // here must be unreachable through this route, and the way that is
    // guaranteed is that no id comes back at all.
    return (async () => {
      const { admin, calls } = stubAdmin({ lookup: { id: CUSTOMER_ID, tags: ["vip"] } });
      const result = await lookupFirstAccessCustomer(admin, "lead@example.test");
      expect(result).toEqual({ kind: "not_first_access" });
      expect(result).not.toHaveProperty("customerId");
      // And nothing was written on the way to finding out.
      expect(calls.filter((c) => c.query.includes("mutation"))).toHaveLength(0);
    })();
  });

  it("reports an absent customer without creating one", async () => {
    const { admin, calls } = stubAdmin({ lookup: null });
    await expect(lookupFirstAccessCustomer(admin, "nobody@example.test")).resolves.toEqual({
      kind: "customer_absent",
    });
    expect(calls.filter((c) => c.query.includes("mutation"))).toHaveLength(0);
  });

  it("tolerates a customer with a null tag list rather than throwing", async () => {
    const { admin } = stubAdmin({ lookup: { id: CUSTOMER_ID, tags: null } });
    await expect(lookupFirstAccessCustomer(admin, "lead@example.test")).resolves.toEqual({
      kind: "not_first_access",
    });
  });

  it("contains a THROWN client error instead of letting it reach the route", async () => {
    const { admin } = stubAdmin({ lookup: LEAD, throwOn: "customerByIdentifier" });
    await expect(lookupFirstAccessCustomer(admin, "lead@example.test")).resolves.toEqual({
      kind: "unavailable",
    });
  });
});

/**
 * ============================================================================
 * SMS CONSENT (owner decision 2026-11-18)
 * ============================================================================
 * Two writes in a fixed order, because Shopify refuses SMS marketing consent
 * for an account with no phone number. The order is not a preference and the
 * failure directions matter: a phone with no consent is the safe half, and a
 * consent we think we hold but Shopify does not is the dangerous one.
 */
describe("recordFirstAccessSmsConsent", () => {
  const CONSENTED_AT = new Date("2026-11-18T12:00:00.000Z");

  function smsAdmin(overrides: { phone?: unknown; consent?: unknown; throwOn?: string } = {}) {
    const calls: Call[] = [];
    const admin = {
      graphql: vi.fn(async (query: string, options?: { variables?: Record<string, unknown> }) => {
        calls.push({ query, variables: options?.variables ?? {} });
        if (overrides.throwOn && query.includes(overrides.throwOn)) {
          throw new Error("GraphQL Client: An error occurred while fetching from the API.");
        }
        if (query.includes("customerSmsMarketingConsentUpdate")) {
          return {
            json: async () => ({
              data: {
                customerSmsMarketingConsentUpdate:
                  overrides.consent ?? {
                    customer: {
                      id: CUSTOMER_ID,
                      defaultPhoneNumber: {
                        phoneNumber: "+12125550147",
                        smsMarketingConsent: {
                          state: "SUBSCRIBED",
                          optInLevel: "SINGLE_OPT_IN",
                          updatedAt: CONSENTED_AT.toISOString(),
                        },
                      },
                    },
                    userErrors: [],
                  },
              },
            }),
          };
        }
        return {
          json: async () => ({
            data: {
              customerUpdate:
                overrides.phone ?? {
                  customer: { id: CUSTOMER_ID, defaultPhoneNumber: { phoneNumber: "+12125550147" } },
                  userErrors: [],
                },
            },
          }),
        };
      }),
    } as unknown as AdminGraphqlClient;
    return { admin, calls };
  }

  it("writes the phone FIRST, then the consent", async () => {
    const { admin, calls } = smsAdmin();
    const outcome = await recordFirstAccessSmsConsent(admin, CUSTOMER_ID, "+12125550147", CONSENTED_AT);

    expect(outcome).toBe("stored");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.query).toContain("customerUpdate");
    expect(calls[1]!.query).toContain("customerSmsMarketingConsentUpdate");
  });

  it("sends the phone and NOTHING else on the customer input", async () => {
    // `customerUpdate` is a broad mutation; the input is what keeps the blast
    // radius to one field.
    const { admin, calls } = smsAdmin();
    await recordFirstAccessSmsConsent(admin, CUSTOMER_ID, "+12125550147", CONSENTED_AT);

    const input = calls[0]!.variables.input as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual(["id", "phone"]);
    expect(input.phone).toBe("+12125550147");
  });

  it("subscribes at SINGLE_OPT_IN with the caller's own timestamp", async () => {
    // The SAME instant our acknowledgment row carries, so the native record
    // and the evidence cannot disagree by a second.
    const { admin, calls } = smsAdmin();
    await recordFirstAccessSmsConsent(admin, CUSTOMER_ID, "+12125550147", CONSENTED_AT);

    const input = calls[1]!.variables.input as {
      customerId: string;
      smsMarketingConsent: Record<string, unknown>;
    };
    expect(input.customerId).toBe(CUSTOMER_ID);
    expect(input.smsMarketingConsent).toEqual({
      marketingState: "SUBSCRIBED",
      marketingOptInLevel: "SINGLE_OPT_IN",
      consentUpdatedAt: CONSENTED_AT.toISOString(),
    });
  });

  it("stops after a rejected phone, without attempting the consent", async () => {
    // A number Shopify will not accept is a consent that cannot exist. Trying
    // the consent anyway would just produce a second, more confusing error.
    const { admin, calls } = smsAdmin({
      phone: { customer: null, userErrors: [{ field: ["phone"], message: "Phone is invalid" }] },
    });
    const outcome = await recordFirstAccessSmsConsent(admin, CUSTOMER_ID, "+1", CONSENTED_AT);

    expect(outcome).toBe("sms_consent_rejected");
    expect(calls).toHaveLength(1);
  });

  it("reports a rejected consent rather than calling it stored", async () => {
    const { admin } = smsAdmin({
      consent: { customer: null, userErrors: [{ field: ["smsMarketingConsent"], message: "nope" }] },
    });
    await expect(
      recordFirstAccessSmsConsent(admin, CUSTOMER_ID, "+12125550147", CONSENTED_AT)
    ).resolves.toBe("sms_consent_rejected");
  });

  it("refuses to call a clean response that did NOT subscribe a success", async () => {
    // THE DANGEROUS CASE. The Admin API can answer without userErrors and
    // without having done the work; believing we may text someone is far worse
    // than knowing we may not.
    const { admin } = smsAdmin({
      consent: {
        customer: {
          id: CUSTOMER_ID,
          defaultPhoneNumber: { smsMarketingConsent: { state: "NOT_SUBSCRIBED" } },
        },
        userErrors: [],
      },
    });
    await expect(
      recordFirstAccessSmsConsent(admin, CUSTOMER_ID, "+12125550147", CONSENTED_AT)
    ).resolves.toBe("unavailable");
  });

  it("contains a thrown client error on either write", async () => {
    for (const throwOn of ["customerUpdate", "customerSmsMarketingConsentUpdate"]) {
      const { admin } = smsAdmin({ throwOn });
      await expect(
        recordFirstAccessSmsConsent(admin, CUSTOMER_ID, "+12125550147", CONSENTED_AT)
      ).resolves.toBe("unavailable");
    }
  });

  it("performs NO lookup of its own, so the gate is the caller's single read", async () => {
    const { admin, calls } = smsAdmin();
    await recordFirstAccessSmsConsent(admin, CUSTOMER_ID, "+12125550147", CONSENTED_AT);
    expect(calls.some((c) => c.query.includes("customerByIdentifier"))).toBe(false);
  });
});
