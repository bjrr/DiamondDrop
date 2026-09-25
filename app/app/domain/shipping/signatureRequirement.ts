/**
 * Shipment signature requirement — D31 (docs/ARCHITECTURE-MVP1.md, resolved
 * 2026-09-25), docs/specs/SLICE-11-SHIPMENT-EVIDENCE.md criteria 174-175.
 *
 * PURE — no database access, no I/O, no ambient clock.
 *
 * HISTORY, FOR CONTEXT. This module previously refused to derive
 * `signatureRequired` from any amount at all: `docs/specs/
 * SLICE-11-READINESS.md` G1 had left "order value" undefined, so a
 * threshold function here would have had to invent an answer to exist. D29
 * (see `merchandiseValue.ts`) resolved that: "order value" is SHIPMENT
 * MERCHANDISE VALUE, computed by `computeShipmentMerchandiseValue`. D31 then
 * resolved the threshold itself. Both questions are answered now, so the
 * derivation this file previously refused to write is the file's job.
 *
 * THE RULE (D31), literally:
 *   - shipment merchandise value <= $100.00  -> standard signature NOT required
 *   - shipment merchandise value >  $100.00  -> STANDARD signature required
 *   - never adult-signature-required by the rule alone — that is a staff
 *     override, never the MVP1 default.
 *   - the customer may not waive a required signature.
 *
 * THE THRESHOLD LIVES IN EXACTLY ONE PLACE:
 * `STANDARD_SIGNATURE_MERCHANDISE_VALUE_THRESHOLD` below, expressed in
 * minor units. Nothing else in this codebase may restate the figure $100 /
 * 10000 as its own literal — import this constant instead. `
 * thresholdFence.test.ts` enforces that structurally.
 *
 * THREE DISTINCT FACTS, NEVER COLLAPSED INTO ONE BOOLEAN:
 *   1. What the RULE says, from merchandise value alone
 *      (`decideStandardSignatureRequirementByRule`).
 *   2. What is ACTUALLY REQUIRED for this shipment, which is the rule's
 *      answer UNLESS a staff member recorded a stricter override
 *      (`resolveShipmentSignatureRequirement`) — "staff may manually
 *      require a stricter service when risk warrants; that is an override,
 *      not the default" (D31). An override is recorded AS an override —
 *      who, when, distinguishable from the rule firing on its own — never
 *      merged into the rule's own result so that fact is lost.
 *   3. What service was ACTUALLY USED when the shipment went out
 *      (`SignatureServiceUsed`) — evidence of what happened, which may
 *      differ from what was required (a carrier substituting a service, a
 *      staff mistake, whatever the real world produced). This is a fact to
 *      RECORD, not a decision to derive — no function here computes it.
 */

import { Money } from "~/domain/money/money";

// ---------------------------------------------------------------------------
// 1. The rule
// ---------------------------------------------------------------------------

/**
 * D31 — the ONE place the $100.00 figure lives, expressed in minor units.
 * USD only: the rule's dollar figure is stated in USD everywhere it is
 * written down (README, D31), and no multi-currency conversion rule exists
 * anywhere in this codebase. A shipment in another currency is refused
 * (`UnsupportedSignatureThresholdCurrencyError`) rather than guessed at —
 * see that error's own doc comment.
 */
export const STANDARD_SIGNATURE_MERCHANDISE_VALUE_THRESHOLD = Money.fromMinorUnits(10000n, "USD");

export class UnsupportedSignatureThresholdCurrencyError extends Error {
  constructor(readonly currency: string) {
    super(
      `The standard-signature threshold (D31) is defined only in ${STANDARD_SIGNATURE_MERCHANDISE_VALUE_THRESHOLD.currency}; ` +
        `a shipment merchandise value in "${currency}" cannot be compared against it without inventing a conversion rate, ` +
        "which this module refuses to do."
    );
    this.name = "UnsupportedSignatureThresholdCurrencyError";
  }
}

export interface SignatureRuleDecision {
  /** Whether the D31 threshold rule, by itself, requires STANDARD signature confirmation. Never adult-signature — the rule never produces that. */
  readonly required: boolean;
}

/**
 * D31's rule, and nothing else — a pure function of shipment merchandise
 * value (D29), never an order's paid/charged amount (see
 * `merchandiseValue.ts`'s header for why that distinction is load-bearing).
 * Boundary is exact: exactly $100.00 does NOT require a signature — this is
 * `>`, not `>=`.
 */
export function decideStandardSignatureRequirementByRule(merchandiseValue: Money): SignatureRuleDecision {
  if (merchandiseValue.currency !== STANDARD_SIGNATURE_MERCHANDISE_VALUE_THRESHOLD.currency) {
    throw new UnsupportedSignatureThresholdCurrencyError(merchandiseValue.currency);
  }
  return {
    required: merchandiseValue.amountMinorUnits > STANDARD_SIGNATURE_MERCHANDISE_VALUE_THRESHOLD.amountMinorUnits,
  };
}

// ---------------------------------------------------------------------------
// 2. The actual requirement for this shipment — rule, or a recorded override
// ---------------------------------------------------------------------------

/**
 * D31 — "staff may manually require a stricter service when risk warrants;
 * that is an override, not the default." An override only ever makes the
 * requirement STRICTER (true); nothing here lets staff waive a requirement
 * the rule produced — D31 says the customer may not waive it, and nothing
 * authorizes staff to on the customer's behalf either.
 */
export interface StaffSignatureOverride {
  readonly overriddenByActorRef: string;
  readonly overriddenAt: Date;
  readonly reason?: string;
}

export type SignatureRequirementSource = "rule" | "staff_override";

export interface ResolvedSignatureRequirement {
  readonly required: boolean;
  /** Distinguishes "the rule fired on its own" from "a staff override" — never collapsed into the boolean alone (D31's own requirement). */
  readonly source: SignatureRequirementSource;
  readonly override: StaffSignatureOverride | null;
}

export type ResolveSignatureRequirementResult =
  | { readonly ok: true; readonly value: ResolvedSignatureRequirement }
  | { readonly ok: false; readonly reason: string };

/**
 * Combines the rule's answer with an optional staff override into the
 * single fact that is actually required for this shipment — while keeping
 * WHICH of the two produced it fully legible on the result (criterion: "the
 * override path must be recorded as an override"). Validates the override's
 * provenance (who, when) the same way the pre-D31 version of this module
 * validated every staff decision — that discipline did not go away, it
 * moved to gate the override specifically rather than every requirement.
 */
export function resolveShipmentSignatureRequirement(
  ruleDecision: SignatureRuleDecision,
  override: StaffSignatureOverride | null
): ResolveSignatureRequirementResult {
  if (override !== null) {
    if (override.overriddenByActorRef.trim().length === 0) {
      return { ok: false, reason: "a signature override must record who required it" };
    }
    if (Number.isNaN(override.overriddenAt.getTime())) {
      return { ok: false, reason: "a signature override must record a valid timestamp" };
    }
    return { ok: true, value: { required: true, source: "staff_override", override } };
  }
  return { ok: true, value: { required: ruleDecision.required, source: "rule", override: null } };
}

// ---------------------------------------------------------------------------
// 3. What was actually used — evidence, not a decision. No derivation here;
// this is a closed set of values a later recording layer (schema/repository
// — not owned by this module) writes down as a fact about what happened.
// ---------------------------------------------------------------------------

export const SIGNATURE_SERVICES_USED = ["none", "standard", "adult_signature_required"] as const;
export type SignatureServiceUsed = (typeof SIGNATURE_SERVICES_USED)[number];

export function isSignatureServiceUsed(value: string): value is SignatureServiceUsed {
  return (SIGNATURE_SERVICES_USED as readonly string[]).includes(value);
}
