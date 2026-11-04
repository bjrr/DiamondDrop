import { describe, expect, it, vi } from "vitest";

import { applyFirstAccessSignup } from "./firstAccessCustomer.server";
import type { AdminGraphqlClient } from "./productClient.server";
import { FIRST_ACCESS_TAG, type SubmittedSignup } from "~/domain/firstaccess/phoneCapture";

/**
 * The adapter, against a stub Admin client.
 *
 * ONE OF THESE IS A REGRESSION TEST FOR A REAL 500. The Shopify GraphQL client
 * THROWS on GraphQL errors instead of returning them in the body, so the
 * original body-only error check never ran: a missing `write_customers` scope
 * surfaced as an unhandled rejection on a public endpoint. Live verification
 * caught it; no unit test could have, because the stub returned the shape the
 * code expected rather than the shape the client produces.
 *
 * The others assert the SHAPE OF WHAT IS SENT, not just the outcome. "Did it
 * return updated" would pass just as happily if the mutation had included a
 * replacing `tags` list and wiped the customer's other tags on the way.
 */

interface Call {
  readonly query: string;
  readonly variables: Record<string, unknown>;
}

function stubAdmin(
  handlers: { lookup?: unknown; update?: unknown; tagsAdd?: unknown; throwOn?: string }
): { admin: AdminGraphqlClient; calls: Call[] } {
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
        : query.includes("customerUpdate")
          ? { customerUpdate: handlers.update ?? { customer: { id: "gid://x" }, userErrors: [] } }
          : { tagsAdd: handlers.tagsAdd ?? { userErrors: [] } };
      return { json: async () => ({ data }) };
    }),
  } as unknown as AdminGraphqlClient;
  return { admin, calls };
}

const LEAD = {
  id: "gid://shopify/Customer/1",
  firstName: "Verify",
  lastName: "Lead",
  tags: [FIRST_ACCESS_TAG, "vip"],
  defaultPhoneNumber: null,
};

function submitted(overrides: Partial<SubmittedSignup> = {}): SubmittedSignup {
  return {
    firstName: "Verify",
    lastName: "Lead",
    phoneE164: "+12125550147",
    interests: [],
    ...overrides,
  };
}

describe("applyFirstAccessSignup", () => {
  it("contains a THROWN client error instead of letting it reach the route", () => {
    // The 500. `unavailable` is the contained outcome; a rejection here would
    // become a 500 on a public endpoint again.
    return expect(
      applyFirstAccessSignup(
        stubAdmin({ throwOn: "customerByIdentifier" }).admin,
        "lead@example.test",
        submitted()
      )
    ).resolves.toBe("unavailable");
  });

  it("contains a thrown error on the WRITE too, after a successful lookup", async () => {
    const { admin } = stubAdmin({ lookup: LEAD, throwOn: "customerUpdate" });
    await expect(
      applyFirstAccessSignup(admin, "lead@example.test", submitted())
    ).resolves.toBe("unavailable");
  });

  it("writes the phone and never a replacing tag list", async () => {
    const { admin, calls } = stubAdmin({ lookup: LEAD });
    const outcome = await applyFirstAccessSignup(admin, "lead@example.test", submitted());
    expect(outcome).toBe("updated");

    const update = calls.find((c) => c.query.includes("customerUpdate"));
    expect(update?.variables.input).toEqual({
      id: LEAD.id,
      phone: "+12125550147",
    });
    // THE GUARANTEE: no `tags` key in the mutation input, ever.
    expect(Object.keys(update?.variables.input as object)).not.toContain("tags");
  });

  it("adds only the new interest tags, leaving unrelated ones untouched", async () => {
    const { admin, calls } = stubAdmin({ lookup: LEAD });
    await applyFirstAccessSignup(
      admin,
      "lead@example.test",
      submitted({ interests: ["loose-diamonds"] })
    );
    const tags = calls.find((c) => c.query.includes("tagsAdd"));
    expect(tags?.variables.tags).toEqual(["loose-diamonds"]);
  });

  it("sends no phone key when the optional field was skipped", async () => {
    const existing = { ...LEAD, defaultPhoneNumber: { phoneNumber: "+12125550147" } };
    const { admin, calls } = stubAdmin({ lookup: existing });
    const outcome = await applyFirstAccessSignup(
      admin,
      "lead@example.test",
      submitted({ phoneE164: null })
    );
    // Nothing left to change, so nothing is sent at all.
    expect(outcome).toBe("already_current");
    expect(calls.filter((c) => c.query.includes("customerUpdate"))).toHaveLength(0);
  });

  it("refuses a customer without the first-access tag, before any write", async () => {
    const { admin, calls } = stubAdmin({ lookup: { ...LEAD, tags: ["vip"] } });
    const outcome = await applyFirstAccessSignup(admin, "lead@example.test", submitted());
    expect(outcome).toBe("not_first_access");
    expect(calls).toHaveLength(1); // the lookup, and nothing else
  });

  it("reports an absent customer without creating one", async () => {
    const { admin, calls } = stubAdmin({ lookup: null });
    const outcome = await applyFirstAccessSignup(admin, "nobody@example.test", submitted());
    expect(outcome).toBe("customer_absent");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).not.toContain("customerCreate");
  });

  it("reports a Shopify userError as a rejected write, not as success", async () => {
    const { admin } = stubAdmin({
      lookup: LEAD,
      update: { customer: null, userErrors: [{ field: ["phone"], message: "Phone is invalid" }] },
    });
    const outcome = await applyFirstAccessSignup(admin, "lead@example.test", submitted());
    expect(outcome).toBe("write_rejected");
  });

  it("reads the phone from the non-deprecated field", async () => {
    // Reading `Customer.phone` still works but is deprecated in 2026-10; this
    // fails if someone reverts to it, since the stub only serves the new shape.
    const existing = { ...LEAD, defaultPhoneNumber: { phoneNumber: "+12125550147" } };
    const { admin, calls } = stubAdmin({ lookup: existing });
    await applyFirstAccessSignup(admin, "lead@example.test", submitted());
    expect(calls[0]?.query).toContain("defaultPhoneNumber");
  });
});
