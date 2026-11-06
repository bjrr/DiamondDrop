import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { describeApprovalOutcome } from "./app.price-approvals";

/**
 * The price approval queue.
 *
 * ===========================================================================
 * THE OUTCOME MAPPING IS THE PART THAT MATTERS
 * ===========================================================================
 * Everything else on this screen is a table. The one thing that can cause
 * real harm is telling an operator a price is live when it is not: they stop
 * looking, the storefront keeps the old price, and nobody finds out until a
 * customer is quoted the wrong number.
 *
 * `decideAndSyncIntent` returns the decision and the publish attempt
 * SEPARATELY because they genuinely disagree: the approval commits in its own
 * transaction, and a Shopify failure afterwards neither un-approves it nor
 * means it published. So these tests assert the mapping directly rather than
 * through rendered markup, and the load-bearing assertion is the negative
 * one: no failure path may ever carry the success tone.
 */

const INTENT = { id: "intent-1" } as never;

describe("approval outcomes are reported as what actually happened", () => {
  it("reports a real publish as success", () => {
    const result = describeApprovalOutcome({
      intent: INTENT,
      sync: {
        kind: "synced",
        intentId: "intent-1",
        regularCardPriceMinorUnits: "12500",
        currency: "USD",
      },
    });
    expect(result.tone).toBe("success");
    expect(result.message).toMatch(/published/i);
  });

  it("NEVER reports success when Shopify publishing threw", () => {
    const result = describeApprovalOutcome({
      intent: INTENT,
      syncError: new Error("Admin API 503"),
    });
    expect(result.tone).toBe("error");
    // The two facts an operator needs, and both must be present: the approval
    // is real, and the price is not live.
    expect(result.message).toMatch(/approved/i);
    expect(result.message).toMatch(/not live/i);
    expect(result.message).toMatch(/failed/i);
  });

  it("does not describe a failed publish as merely 'Approved'", () => {
    const result = describeApprovalOutcome({ intent: INTENT, syncError: new Error("boom") });
    expect(result.message.trim()).not.toBe("Approved");
    expect(result.message.trim()).not.toBe("Approved.");
  });

  it("distinguishes already synced from a fresh publish", () => {
    const result = describeApprovalOutcome({
      intent: INTENT,
      sync: { kind: "already_synced", intentId: "intent-1" },
    });
    expect(result.tone).toBe("warning");
    expect(result.message).toMatch(/already synced/i);
  });

  it("distinguishes superseded", () => {
    const result = describeApprovalOutcome({
      intent: INTENT,
      sync: { kind: "superseded", intentId: "intent-1" },
    });
    expect(result.tone).toBe("warning");
    expect(result.message).toMatch(/superseded/i);
    expect(result.message).toMatch(/nothing was published/i);
  });

  it("reports a placeholder-profile refusal as an error, with what to do", () => {
    const result = describeApprovalOutcome({
      intent: INTENT,
      sync: { kind: "placeholder_refused", intentId: "intent-1" },
    });
    expect(result.tone).toBe("error");
    expect(result.message).toMatch(/placeholder/i);
    expect(result.message).toMatch(/Pricing Settings/);
  });

  it("reports a concurrent state change as not applicable, with the reason", () => {
    const result = describeApprovalOutcome({
      intent: INTENT,
      sync: { kind: "not_applicable", intentId: "intent-1", reason: "intent no longer approved" },
    });
    expect(result.tone).toBe("warning");
    expect(result.message).toMatch(/not applicable/i);
    expect(result.message).toMatch(/intent no longer approved/);
  });

  it("does not claim a publish happened when none was attempted", () => {
    const result = describeApprovalOutcome({ intent: INTENT });
    expect(result.tone).not.toBe("success");
    expect(result.message).toMatch(/no publish was attempted/i);
  });

  it("gives every non-synced outcome a non-success tone", () => {
    // The invariant behind all of the above, stated once so a new SyncOutcome
    // kind cannot be added with a success tone by accident.
    const nonSynced = [
      { intent: INTENT, sync: { kind: "already_synced", intentId: "i" } },
      { intent: INTENT, sync: { kind: "superseded", intentId: "i" } },
      { intent: INTENT, sync: { kind: "placeholder_refused", intentId: "i" } },
      { intent: INTENT, sync: { kind: "not_applicable", intentId: "i", reason: "r" } },
      { intent: INTENT, syncError: new Error("x") },
      { intent: INTENT },
    ];
    for (const result of nonSynced) {
      expect(describeApprovalOutcome(result as never).tone).not.toBe("success");
    }
  });
});

/**
 * Source-level guarantees.
 *
 * These read the route rather than run it: the route's action needs a live
 * Shopify session, and the properties below are structural. Each one is a
 * thing that would still pass every behavioural test if it broke.
 */
describe("the route delegates instead of reimplementing", () => {
  const source = readFileSync(
    join(process.cwd(), "app", "routes", "app.price-approvals.tsx"),
    "utf8"
  );

  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

  it("approves through decideAndSyncIntent", () => {
    expect(code).toMatch(/decideAndSyncIntent\(/);
  });

  it("rejects through decideIntent, and never publishes on a rejection", () => {
    expect(code).toMatch(/decideIntent\(\{[\s\S]*?status: "rejected"/);
    // The sync port is only constructed on the approve branch.
    const rejectBranch = code.slice(code.indexOf('decision === "reject"'), code.indexOf('decision === "approve"'));
    expect(rejectBranch).not.toMatch(/createProductionPriceSyncPort|decideAndSyncIntent/);
  });

  it("requires a reason before rejecting", () => {
    expect(code).toMatch(/if \(!reason\)/);
    expect(code).toMatch(/rejection reason is required/i);
  });

  it("takes the actor from the session and never from the form", () => {
    expect(code).toMatch(/resolveStaffActorRef\(session\)/);
    expect(code).toMatch(/associated_user/);
    // The specific thing that must never appear.
    expect(code).not.toMatch(/form\.get\(\s*["']actor["']\s*\)/);
    expect(code).not.toMatch(/actor:\s*String\(form/);
  });

  it("refuses to act without an associated staff user", () => {
    expect(code).toMatch(/if \(!actor\)/);
  });

  it("authenticates both the loader and the action", () => {
    const loader = code.slice(code.indexOf("export async function loader"), code.indexOf("export async function action"));
    const action = code.slice(code.indexOf("export async function action"));
    expect(loader).toMatch(/authenticate\.admin\(request\)/);
    expect(action).toMatch(/authenticate\.admin\(request\)/);
  });

  it("lists only intents awaiting approval", () => {
    // The repository filters to pending_approval; the route must not widen it.
    expect(code).toMatch(/listPendingIntents\(\)/);
    expect(code).not.toMatch(/findMany|where:\s*\{/);
  });

  it("exposes no cost, margin or internal pricing component to the browser", () => {
    /**
     * Scoped to the VIEW MODEL and the loader that fills it, which is the
     * actual contract for what leaves the server. Scanning the whole file
     * instead matched the CSS property `margin:` in a style object, which is
     * not a profit margin: a test that fails on that invites someone to drop
     * the most important word from the list to make it pass.
     */
    const viewModel = code.slice(
      code.indexOf("export interface ApprovalRowView"),
      code.indexOf("interface LoaderData")
    );
    for (const forbidden of ["landedcost", "costcomponent", "margin", "supplier", "uplift"]) {
      expect(viewModel.toLowerCase(), `view model field named ${forbidden}`).not.toContain(
        forbidden
      );
    }

    /**
     * The loader may TOUCH the profile's uplift rate, because
     * `deriveRegularCardPrice` takes it and that is the same call the publish
     * path makes. What it may not do is put the record into the response: the
     * row is assembled field by field so a spread cannot carry landed cost
     * along with the price.
     */
    const loaderBody = code.slice(
      code.indexOf("export async function loader"),
      code.indexOf("export async function action")
    );
    expect(loaderBody).not.toMatch(/\.\.\.(calc|intent|row)\b/);
    expect(loaderBody).not.toMatch(/landedCost/);
  });

  it("computes no price of its own beyond the approved card-price derivation", () => {
    expect(code).toMatch(/deriveRegularCardPrice\(/);
    // No arithmetic on money in the route.
    expect(code).not.toMatch(/bankPaymentPriceMinorUnits\s*[*+/-]/);
  });

  it("formats money from BigInt minor units, never floats", () => {
    expect(code).toMatch(/amountMinorUnits: bigint/);
    expect(code).not.toMatch(/parseFloat|Number\(.*MinorUnits/);
  });
});
