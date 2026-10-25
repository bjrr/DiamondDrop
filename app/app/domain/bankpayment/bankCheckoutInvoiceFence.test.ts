import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * REGISTER D15 — the Bank Payment path must never hand the customer a
 * Shopify draft-order invoice again.
 *
 * ============================================================================
 * WHY A SOURCE FENCE AND NOT ONLY A BEHAVIOURAL TEST
 * ============================================================================
 * The behaviour is covered too: `checkoutResponseDto.test.ts` proves no
 * invoice URL survives into the response, and the integration suite proves
 * the route sends no invoice. But both of those test what the code currently
 * does. This file tests what the code is ALLOWED to do, because the defect
 * was not a wrong value — it was a navigation path that looked helpful.
 *
 * Shopify's invoice carries a **Confirm order** action. Handing it to the
 * customer let them advance a draft that must stay staff-controlled until
 * funds are verified, which is the single rule Buy Now's state machine
 * exists to enforce. Someone adding a "let them pay by card instead" link in
 * six months would be making a reasonable-looking change that reopens it.
 *
 * COMMENTS ARE STRIPPED BEFORE SCANNING. This project has repeatedly had
 * fences match their own documentation — the files below explain the defect
 * at length and necessarily name the thing they forbid.
 */

const APP = join(process.cwd(), "app");

function codeOf(relativePath: string): string {
  return readFileSync(join(APP, relativePath), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

const ROUTE = codeOf("routes/apps.carat.bank-checkout.tsx");
const DTO = codeOf("domain/bankpayment/checkoutResponseDto.ts");
const THEME = readFileSync(
  join(process.cwd(), "..", "theme", "assets", "bank-payment-checkout.js"),
  "utf8"
)
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/^\s*\/\/.*$/gm, " ");

describe("the comment stripper works", () => {
  it("removes the documentation that names the forbidden behaviour", () => {
    // Guard the guard: every assertion below would be meaningless if the
    // stripper returned the input unchanged, because these files discuss
    // invoices extensively.
    expect(readFileSync(join(APP, "routes/apps.carat.bank-checkout.tsx"), "utf8")).toContain(
      "NO SHOPIFY INVOICE IS SENT"
    );
    expect(ROUTE).not.toContain("NO SHOPIFY INVOICE IS SENT");
  });
});

describe("the Buy Now Bank Payment route sends no invoice", () => {
  it("never calls sendInvoice", () => {
    expect(ROUTE).not.toMatch(/\.sendInvoice\s*\(/);
  });

  it("never reads an invoice URL off the created draft", () => {
    expect(ROUTE).not.toMatch(/\.invoiceUrl/);
  });

  it("still creates the draft and still persists the local order", () => {
    // The fix removed the invoice, not the state machine. If these ever stop
    // being true the fence above would pass for the wrong reason.
    expect(ROUTE).toMatch(/createDraftOrder\s*\(/);
    expect(ROUTE).toMatch(/bankPaymentOrder\.create|tx\.bankPaymentOrder\.create/);
  });

  it("never completes the draft itself — that is the verification path's job", () => {
    // A customer-triggered completion is the same defect wearing different
    // clothes: it commits inventory before any human has seen the money.
    expect(ROUTE).not.toMatch(/completeDraftOrder|draftOrderComplete/);
  });
});

describe("the response contract carries no invoice", () => {
  it("declares no invoiceUrl field on any CURRENT type", () => {
    /**
     * Narrowed deliberately. `StoredBankCheckoutResult` names `invoiceUrl`
     * on purpose: payloads persisted before D15 still contain one, and that
     * union is how a replay reads them without crashing. Banning the word
     * outright would forbid the type whose whole job is to describe the
     * legacy shape safely.
     *
     * What must stay true is that no field a NEW result or a CUSTOMER
     * response can carry is called that.
     */
    const current = DTO.slice(0, DTO.indexOf("export type StoredBankCheckoutResult"));
    expect(current.length).toBeGreaterThan(200);
    expect(current).not.toMatch(/invoiceUrl/);

    // And the legacy union may only ever READ it — never hand it onward.
    const legacy = DTO.slice(DTO.indexOf("export type StoredBankCheckoutResult"));
    expect(legacy).not.toMatch(/invoiceUrl:\s*(result|stored)\./);
  });

  it("does not leak the Shopify draft handle to the customer", () => {
    // `draftOrderGid` stays on the PERSISTED result (replay and staff
    // reconciliation need it) but must not reach the browser envelope.
    const customerEnvelope = DTO.slice(DTO.indexOf("export function toCustomerResponse"));
    expect(customerEnvelope).not.toMatch(/draftOrderGid/);
  });
});

describe("the storefront never navigates to Shopify", () => {
  it("performs no redirect out of the confirmation", () => {
    expect(THEME).not.toMatch(/window\.location\.href\s*=/);
  });

  it("reads no invoice URL from the response", () => {
    expect(THEME).not.toMatch(/invoiceUrl/);
  });

  it("renders the instructions the server returned instead", () => {
    expect(THEME).toMatch(/renderPaymentInstructions\s*\(/);
    expect(THEME).toMatch(/dto\.instructions/);
  });
});
