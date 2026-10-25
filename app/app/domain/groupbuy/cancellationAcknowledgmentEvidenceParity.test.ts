import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL,
  GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_POLICY_SLUG,
  GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_TEXT,
} from "./cancellationAcknowledgmentText";

/**
 * GROUP BUY CANCELLATION ACKNOWLEDGMENT — CARD AND BANK MUST MEET THE SAME
 * EVIDENCE STANDARD, BY DIFFERENT MECHANISMS.
 *
 * ============================================================================
 * THE DISTINCTION THIS FILE EXISTS TO PROTECT
 * ============================================================================
 * The two MECHANISMS are deliberately different, and must not be unified:
 *
 *   CARD  `apps.carat.group-buy-cancellation-acknowledgment.tsx` captures
 *         the acknowledgment up front and returns its id, because NATIVE
 *         Shopify checkout creates the order — the evidence has to exist
 *         before the order does, and travel with it on the cart line.
 *
 *   BANK  `apps.carat.group-buy-bank-checkout.tsx` captures nothing up
 *         front. It takes a literal `true`, and writes the Acknowledgment
 *         row itself, inside the order transaction, behind a NOT NULL FK.
 *         It must NOT accept an acknowledgment id from the browser: a
 *         caller could present one they did not earn.
 *
 * Making the Bank path call the capture endpoint first would weaken it.
 * Making the Card path skip pre-capture would break native checkout. So the
 * mechanisms stay apart — and this file pins the seven things that must NOT
 * differ, because "different mechanism" is exactly the excuse under which
 * an evidence gap would be easiest to introduce without anyone noticing.
 *
 * ============================================================================
 * WHY A SOURCE-LEVEL COMPARISON
 * ============================================================================
 * Behavioural coverage exists for both routes in
 * `tests/integration/groupbuy/`. What that cannot express is a RELATIONSHIP
 * between two files — "whatever the Card route requires, the Bank route
 * requires too". A future edit that relaxed one side would keep both routes'
 * own tests green, because each would still be internally consistent.
 *
 * COMMENTS ARE STRIPPED BEFORE SCANNING. This project has repeatedly had
 * fences match their own documentation, and both routes discuss these
 * concepts at length in prose.
 */

const ROUTES = join(process.cwd(), "app", "routes");

function codeOf(file: string): string {
  return readFileSync(join(ROUTES, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

const CARD = codeOf("apps.carat.group-buy-cancellation-acknowledgment.tsx");
const BANK = codeOf("apps.carat.group-buy-bank-checkout.tsx");

describe("the comment stripper works", () => {
  it("removes prose that names the things asserted below", () => {
    // Guard the guard: every assertion here would be meaningless if the
    // stripper returned the input unchanged.
    const rawBank = readFileSync(join(ROUTES, "apps.carat.group-buy-bank-checkout.tsx"), "utf8");
    expect(rawBank).toContain("CANCELLATION ACKNOWLEDGMENT");
    expect(BANK).not.toContain("CANCELLATION ACKNOWLEDGMENT");
  });
});

describe("evidence parity — the seven things Card and Bank must agree on", () => {
  it("1. the SAME policy slug", () => {
    for (const source of [CARD, BANK]) {
      expect(source).toContain("GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_POLICY_SLUG");
    }
    // And neither hardcodes a slug string of its own alongside it.
    for (const source of [CARD, BANK]) {
      expect(source).not.toContain(`"${GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_POLICY_SLUG}"`);
    }
  });

  it("2. the CURRENT policy version, resolved the same way", () => {
    // Not a pinned id, not a constant — both must read the live latest
    // version, or one route could keep recording evidence against a
    // superseded policy after the other moved on.
    for (const source of [CARD, BANK]) {
      expect(source).toMatch(
        /getLatestPolicyVersion\(\s*GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_POLICY_SLUG\s*\)/
      );
    }
  });

  it("3. the EXACT approved copy, taken from the resolved policy row — never retyped", () => {
    // `exactText` must come from `policyVersion.text` on both sides. A
    // route that passed its own in-code constant would drift the moment the
    // policy row was updated.
    expect(CARD).toMatch(/exactText:\s*policyVersion\.text/);
    expect(BANK).toMatch(/exactText:\s*input\.cancellationPolicyVersion\.text/);
    // Neither may inline the approved sentence as a literal.
    for (const source of [CARD, BANK]) {
      expect(source).not.toContain(GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_TEXT);
    }
  });

  it("4. the SAME affirmative-action label constant", () => {
    for (const source of [CARD, BANK]) {
      expect(source).toMatch(
        /affirmativeActionLabel:\s*GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL/
      );
      expect(source).not.toContain(`"${GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL}"`);
    }
  });

  it("5. the AUTHENTICATED Shopify customer, never a client-supplied identity", () => {
    // Both derive the identity from the SIGNED App Proxy parameters.
    for (const source of [CARD, BANK]) {
      expect(source).toContain("verifyAppProxySignature");
      expect(source).toContain("loggedInCustomerId");
    }
    // And both write that identity, not something off the request body.
    expect(CARD).toMatch(/customerRef:\s*customerGid/);
    expect(BANK).toMatch(/customerRef:\s*input\.customerGid/);

    // Neither may accept a customer identity from the parsed body. The
    // schemas are the place that would happen.
    for (const source of [CARD, BANK]) {
      expect(source).not.toMatch(/customerGid:\s*z\./);
      expect(source).not.toMatch(/customerId:\s*z\./);
    }
  });

  it("6. the campaign reference, recorded on both", () => {
    expect(CARD).toMatch(/campaignRef:\s*campaign\.code/);
    expect(BANK).toMatch(/campaignRef:\s*input\.campaignCode/);
  });

  it("7. the campaign must be OPEN — no evidence for a closed campaign", () => {
    for (const source of [CARD, BANK]) {
      expect(source).toMatch(/campaign\.status\s*!==\s*["']open["']/);
    }
  });
});

describe("both fail closed when policy configuration is unavailable", () => {
  it("neither proceeds without a resolved policy version", () => {
    // The shape differs (`policy_unavailable` 503 vs
    // `acknowledgment_copy_pending_approval` 503) because the two routes
    // return different contracts — what must match is that BOTH refuse.
    expect(CARD).toMatch(/if\s*\(!policyVersion\)/);
    expect(BANK).toMatch(/if\s*\(!cancellationPolicyVersion\)/);
    for (const source of [CARD, BANK]) {
      expect(source).toMatch(/status:\s*503/);
    }
  });

  it("the Bank route checks policy availability BEFORE any Shopify call", () => {
    // Otherwise a misprovisioned environment produces a live, real, unpaid,
    // participation-counting Shopify order with no acknowledgment behind
    // it — the one failure mode that cannot be cleaned up by retrying.
    const policyCheck = BANK.indexOf("cancellationPolicyVersion");
    const firstShopifyCall = BANK.indexOf("createDraftOrder");
    expect(policyCheck).toBeGreaterThan(-1);
    expect(firstShopifyCall).toBeGreaterThan(-1);
    expect(policyCheck).toBeLessThan(firstShopifyCall);
  });
});

describe("the mechanisms stay separate — this is the point, not an oversight", () => {
  it("the Bank route accepts NO acknowledgment id from the browser", () => {
    // A browser-supplied id would let a caller present evidence they did
    // not earn. The route builds its own row instead.
    expect(BANK).not.toMatch(/acknowledgmentId:\s*z\./);
    expect(BANK).not.toMatch(/cancellationAcknowledgmentId:\s*z\./);
  });

  it("the Bank route requires the LITERAL boolean true — never a default, never inferred", () => {
    expect(BANK).toMatch(/cancellationAcknowledgmentAccepted:\s*z\.literal\(true\)/);
    // `.optional()`, `.default(...)` or a plain `z.boolean()` would each
    // let an absent value through as acceptance.
    expect(BANK).not.toMatch(/cancellationAcknowledgmentAccepted:\s*z\.boolean\(\)/);
    expect(BANK).not.toMatch(/cancellationAcknowledgmentAccepted:[^\n]*\.optional\(\)/);
    expect(BANK).not.toMatch(/cancellationAcknowledgmentAccepted:[^\n]*\.default\(/);
  });

  it("the Bank route does not call the Card capture endpoint", () => {
    expect(BANK).not.toContain("group-buy-cancellation-acknowledgment");
  });

  it("the Bank storefront sends no acknowledgment id and calls no capture endpoint", () => {
    // The route refusing one is necessary but not sufficient: the theme
    // could still call the capture endpoint and silently create a second,
    // orphaned Acknowledgment row for every Bank order.
    const js = readFileSync(join(process.cwd(), "..", "theme", "assets", "group-buy-campaign.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*\/\/.*$/gm, " ");

    // It still has the Card capture — that path needs it.
    expect(js).toContain("/apps/carat/group-buy-cancellation-acknowledgment");
    // But the Bank body may not carry an id, and the capture must be
    // skipped when Bank is the selected payment type.
    expect(js).toMatch(/cancellationAcknowledgmentAccepted:/);
    expect(js).not.toMatch(/cancellationAcknowledgmentId:/);
    expect(js).toMatch(/paymentType\s*===\s*["']bank["']/);
  });
});
