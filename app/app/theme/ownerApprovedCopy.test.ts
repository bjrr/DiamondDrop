import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CUSTOM_JEWELRY_DESIGN_DEPOSIT_DISCLOSURE,
  CUSTOM_JEWELRY_FOLLOW_UP_CHOICES,
  CUSTOM_JEWELRY_INTAKE_CONFIRMATION_TEMPLATE,
} from "../domain/customjewelry/intakeCopy";

/**
 * OWNER-APPROVED CUSTOMER-FACING COPY, PINNED CHARACTER FOR CHARACTER.
 *
 * These four strings are material pricing communication. The owner approved
 * this exact wording on 2026-09-21; nobody may reword them without going back
 * for approval, and a well-meant edit is the likeliest way that happens by
 * accident.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE OTHER THEME GUARDS. The existing
 * tests assert what must NOT appear — no internal percentage, no "cash", no
 * "card fee", no "surcharge", no error/warning framing. That is a necessary
 * check and it is not this one. A string can satisfy every prohibition and
 * still not be the sentence the owner signed off. Slice 1's Group Buy block
 * established the pattern of pinning approved copy verbatim; these four had
 * only the prohibitions, so a rewording would have passed silently.
 *
 * The copy changed once already: the owner revised the reprice notice and the
 * switch note away from the drafted versions. That is exactly the event this
 * file makes visible in a diff rather than invisible in a locale blob.
 */

const LOCALES = join(process.cwd(), "..", "theme", "locales", "en.default.json");

function locale(): Record<string, unknown> {
  return JSON.parse(readFileSync(LOCALES, "utf8")) as Record<string, unknown>;
}

/** Walks a dotted path, so a moved key fails loudly rather than reading undefined. */
function at(path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => {
    if (node === null || typeof node !== "object") return undefined;
    return (node as Record<string, unknown>)[key];
  }, locale());
}

/** Owner-approved 2026-09-21. Do not edit without owner approval. */
const APPROVED: ReadonlyArray<readonly [string, string]> = [
  [
    "sections.cart.pricing.card_checkout_reprice_notice",
    "Your cart is now set to Card pricing. The Card Total above is the amount you'll pay if you continue to Card Checkout. To use Bank Payment pricing, switch back to Bank Payment.",
  ],
  ["sections.cart.card_checkout_confirm", "Continue to Card Checkout"],
  ["sections.cart.pricing.switch_to_bank_payment", "Switch to Bank Payment Pricing"],
  [
    "sections.cart.pricing.switch_to_bank_payment_note",
    "Eligible items will update to their Bank Payment Price.",
  ],
  // Slice 2C phase 2C-6, owner-approved 2026-09-22. The Bank Payment
  // checkout surface: what the button promises, what the customer is told
  // before submitting, the two errors that need to be actionable rather than
  // generic, and what success actually means.
  //
  // The success string is the owner's own correction: the screen used to say
  // "Your order was submitted" while simultaneously disclosing that no order
  // exists until payment is verified. Two contradictory claims on one screen
  // is worse than either alone, so the wording now says a REQUEST was
  // submitted.
  ["sections.cart.bank_payment_checkout_note", "Choosing Bank Payment switches your entire cart to Bank Payment pricing. Eligible items will use their Bank Payment Price."],
  [
    "sections.cart.bank_payment_checkout_form.not_committed_disclosure",
    "Your Bank Payment Price is guaranteed for 24 hours. Submitting this form does not complete your order or reserve your items. Your order is not committed and availability is not guaranteed until your Bank Payment is received and verified. We’ll email you an invoice with payment instructions, and nothing is charged when you submit this form.",
  ],
  [
    "sections.cart.bank_payment_checkout_form.error_unpurchasable_lines",
    "One or more items in your cart are no longer available for Bank Payment Checkout. Please refresh your cart to see the latest availability and pricing before continuing.",
  ],
  [
    "sections.cart.bank_payment_checkout_form.error_group_buy_variant_present",
    "Your cart includes a Group Buy item. Group Buy purchases are placed separately and can’t be combined with Buy Now Bank Payment Checkout. Please remove the Group Buy item from this cart to continue.",
  ],
  [
    "sections.cart.bank_payment_checkout_form.success_check_email",
    "Your Bank Payment request was submitted. We’ve emailed you an invoice with payment instructions. Your order is not committed and your items are not reserved until your Bank Payment is received and verified.",
  ],
  // docs/REQUIRED-CUSTOMER-ACCOUNTS.md §4, owner-approved 2026-09-26. Two
  // independent renders of the SAME sentence — the Bank Payment Checkout
  // dialog's sign-in gate and the Warranty Claim Form's sign-in gate
  // (theme/sections/warranty-claim-form.liquid). Pinned together so the two
  // can never quietly drift apart from each other or from the doc.
  [
    "sections.cart.bank_payment_checkout_form.sign_in_required_message",
    "Please sign in or create a CaratForUs account to continue.",
  ],
  [
    "templates.warranty_claim.form.sign_in_required_message",
    "Please sign in or create a CaratForUs account to continue.",
  ],
  // docs/REQUIRED-CUSTOMER-ACCOUNTS.md §4, owner-approved 2026-09-26. A
  // third independent render of the SAME sentence, this time gating the
  // Group Buy campaign page's order action
  // (sections/group-buy-campaign.liquid). Pinned alongside its two twins
  // above so all three can never quietly drift apart from each other or
  // from the doc.
  [
    "templates.group_buy_campaign.sign_in_required_message",
    "Please sign in or create a CaratForUs account to continue.",
  ],
  // Owner-approved 2026-09-27, docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md.
  // The Group Buy cancellation-policy disclosure/checkbox/label. Source of
  // truth is `app/domain/groupbuy/cancellationAcknowledgmentText.ts`, whose
  // own test (`cancellationAcknowledgmentText.test.ts`) independently proves
  // this locale is byte-identical to it — pinned here too so a scan of this
  // one file still finds every piece of owner-approved copy in the theme.
  [
    "templates.group_buy_campaign.cancellation_disclosure",
    "Before the campaign closes, you may request a cancellation, but cancellation is not automatic and requires CaratForUs approval. Once the campaign closes, your Group Buy order is committed and cannot be canceled or returned because you change your mind. This does not affect claims for defects, incorrect items or specifications, shipping damage, warranty issues, fulfillment problems, or other rights required by law.",
  ],
  [
    "templates.group_buy_campaign.cancellation_checkbox_label",
    "I understand that cancellation requests before the campaign closes require CaratForUs approval, and that once the campaign closes my Group Buy order is committed and is not eligible for discretionary cancellation or return.",
  ],
  ["templates.group_buy_campaign.cancellation_affirm_label", "I Understand & Agree"],
  // Owner-approved 2026-09-29, docs/specs/STOREFRONT-COPY-DECISIONS.md §2.2.
  //
  // The examples sentence is the OWNER'S OWN WORDING, not the draft. A first
  // attempt offered "a stone coming loose from a setting that wasn't damaged"
  // and was rejected for implying that any loose stone is automatically
  // covered — a claim the policy does not make. The replacement names
  // workmanship failures rather than symptoms.
  //
  // The WHOLE paragraph is pinned, coverage and exclusions together, because
  // the exclusions are what stop the examples reading as an open promise.
  // Editing either half in isolation is what would do damage, so neither can
  // move without this failing.
  // Owner-approved 2026-09-28, docs/specs/STOREFRONT-COPY-DECISIONS.md §2.4,
  // reconciled onto the live page 2026-10-04.
  //
  // THE PAGE PREVIOUSLY CARRIED A PARAPHRASE: "CaratForUs reviews every claim
  // before authorizing an inspection. Please do not send your jewelry to us
  // until we have reviewed your claim and provided authorization and
  // instructions." Substantively the same, separately approved nowhere, and
  // pinned nowhere — which is exactly how a second wording of a material
  // instruction survives. Replaced with the approved sentence and pinned so
  // there is one wording, not two that drift.
  //
  // A FIRST-PERSON FORM OF THE SAME INSTRUCTION EXISTS ON PURPOSE, inside
  // `acknowledgment_text` ("I will not send my jewelry until..."), where the
  // customer is certifying rather than being told. That one is pinned by
  // `app/domain/warranty/acknowledgmentText.ts` and its own test. Two
  // grammatical persons for two different speech acts is not two variants of
  // one instruction — but a third wording would be, so do not add one.
  [
    "templates.warranty_claim.form.notice_body",
    "Do not send your jewelry until CaratForUs authorizes an inspection and provides shipping instructions.",
  ],
  [
    "templates.warranty_claim.form.intro",
    "Use this form to report a suspected manufacturing defect covered by CaratForUs's 1-year limited manufacturing warranty. " +
      "The warranty covers defects in materials, construction, setting, or assembly under normal use. " +
      "Examples may include defective solder joints, structural workmanship failures, setting defects, and defective clasps or mechanisms under normal use. " +
      "It does not cover normal wear, scratches, dents, impact damage, worn or bent prongs, stone loss caused by damage or wear, misuse, improper care, sizing changes, or unauthorized repairs, alterations, or modifications.",
  ],
];

/**
 * SLICE 9 — CUSTOM JEWELRY. Pinned differently from everything above, and
 * deliberately so.
 *
 * The strings above are literals in this file, which is right when the theme
 * is the only place they live. These two ALSO exist as TypeScript constants,
 * because the server needs them (the confirmation is returned to the browser;
 * the deposit disclosure will be re-shown on the deposit step). A third copy
 * here would be a third thing to keep in step. So instead of restating them,
 * this asserts the locale file EQUALS the constant — `intakeCopy.test.ts`
 * pins the constant against the owner's approved wording, and this pins the
 * storefront against the constant. Two links, no loose ends.
 */
const APPROVED_AGAINST_CONSTANT: ReadonlyArray<readonly [string, string]> = [
  ["templates.custom_jewelry.form.confirmation_template", CUSTOM_JEWELRY_INTAKE_CONFIRMATION_TEMPLATE],
  ["templates.custom_jewelry.form.deposit_disclosure", CUSTOM_JEWELRY_DESIGN_DEPOSIT_DISCLOSURE],
  [
    "templates.custom_jewelry.form.follow_up_schedule_consultation",
    CUSTOM_JEWELRY_FOLLOW_UP_CHOICES[0].label,
  ],
  ["templates.custom_jewelry.form.follow_up_contact_me", CUSTOM_JEWELRY_FOLLOW_UP_CHOICES[1].label],
];

describe("the Custom Jewelry storefront renders the same bytes as the approved constants", () => {
  it.each(APPROVED_AGAINST_CONSTANT)("%s equals its approved constant", (path, expected) => {
    expect(
      at(path),
      `${path} has drifted from app/domain/customjewelry/intakeCopy.ts. The constant is the ` +
        `approval record; the locale is what the customer reads. If the wording genuinely needs ` +
        `to change, take it to the owner and change BOTH in one commit.`
    ).toBe(expected);
  });

  it("guards the guard: a comparison against undefined cannot pass", () => {
    // Every expectation here comes from a constant rather than a literal, so a
    // typo'd PATH would compare undefined against a real string and fail —
    // but an empty constant would make the assertion vacuous in both
    // directions. Both sides are checked to be non-empty strings.
    for (const [path, expected] of APPROVED_AGAINST_CONSTANT) {
      expect(typeof expected, `the constant behind ${path} is not a string`).toBe("string");
      expect(expected.length, `the constant behind ${path} is empty`).toBeGreaterThan(0);
      expect(typeof at(path), `${path} is missing from the locale file`).toBe("string");
    }
  });

  it("the intake form carries NO abandonment rule and NO response-time promise", () => {
    // Owner instruction, verbatim: "Do not put the abandonment/non-response
    // rule on the initial intake form. Keep the intake welcoming." And: "Do
    // not add a response-time promise." `intakeCopy.test.ts` asserts this of
    // the constants; this asserts it of the WHOLE rendered locale block,
    // including the mechanical labels that no constant covers — which is
    // where such a sentence would most plausibly be added by someone trying
    // to be helpful.
    const block = at("templates.custom_jewelry.form");
    expect(typeof block, "templates.custom_jewelry.form is missing").toBe("object");
    const rendered = JSON.stringify(block).toLowerCase();
    for (const term of ["abandon", "stops responding", "stop responding", "unresponsive", "non-response"]) {
      expect(rendered.includes(term), `the intake copy mentions "${term}" — that rule belongs on the deposit step`).toBe(
        false
      );
    }
    for (const promise of ["shortly", "as soon as possible", "business day", "promptly", "right away"]) {
      expect(rendered.includes(promise), `the intake copy promises a response time ("${promise}")`).toBe(false);
    }
    expect(/within \d+/.test(rendered), "the intake copy promises a response time").toBe(false);
  });
});

describe("owner-approved customer-facing copy is pinned verbatim", () => {
  it.each(APPROVED)("%s matches the approved wording exactly", (path, expected) => {
    expect(
      at(path),
      `${path} does not match the wording the owner approved on 2026-09-21. This is ` +
        `material pricing communication: it tells a customer which basis they are ` +
        `about to pay on. If the wording genuinely needs to change, take the new ` +
        `text to the owner and update this file in the same commit — do not edit ` +
        `the locale alone, or the approval record and the storefront drift apart.`
    ).toBe(expected);
  });

  it("guards the guard: every pinned key actually resolves", () => {
    // A typo'd path would make every assertion above compare undefined to a
    // string and fail loudly — but a path that resolves to the WRONG node
    // could compare undefined and pass if the expectation were also undefined.
    // This asserts each key is a real, non-empty string in the locale.
    for (const [path] of APPROVED) {
      const value = at(path);
      expect(typeof value, `${path} is missing from the locale file`).toBe("string");
      expect((value as string).length, `${path} is empty`).toBeGreaterThan(0);
    }
  });

  it("the approved copy itself contains no forbidden terminology", () => {
    // The prohibitions apply to approved copy too. If an approved string ever
    // contained one of these, the conflict should surface here rather than in
    // the separate forbidden-terms sweep, where it would look like a drafting
    // slip rather than an approval that needs revisiting.
    const forbidden = /\b(cash|cash discount|card fee|credit card fee|surcharge)\b/i;
    for (const [path, text] of APPROVED) {
      expect(forbidden.test(text), `${path} contains forbidden terminology`).toBe(false);
    }
  });
});
