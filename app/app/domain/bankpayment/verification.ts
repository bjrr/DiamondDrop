import { Money } from "~/domain/money/money";
import { DEFAULT_ROUNDING_RULE_ID } from "~/domain/money/rounding";

/**
 * Manual Bank Payment verification — the PURE decision layer (owner §23,
 * `docs/specs/SLICE-2C-BANK-PAYMENT-CHECKOUT.md` §5.4/§14/§19, phase 2C-c
 * criteria 87-88, 103-104, 112-124).
 *
 * NO DATABASE ACCESS, NO I/O, NO AMBIENT CLOCK — same discipline as
 * `guaranteeDecision.ts`: the admin route (`app/routes/app.bank-payments.$id.tsx`)
 * and its server-side companion (`verification.server.ts`) gather everything
 * real (the order, its lines, Shopify's live availability answer, the
 * submitted form, the authenticated Shopify staff identity) and hand it to
 * the functions below as plain values, which is what makes field-level
 * validation and the expected/received comparison exhaustively table-testable
 * with no database.
 *
 * WHY THIS FILE VALIDATES AGAIN EVEN THOUGH THE FORM HAS ITS OWN
 * `required`/`pattern` ATTRIBUTES. `CLAUDE.md`'s "validate server-side
 * inputs" and the assigning message's own instruction: the browser is not
 * the only way to reach the action (a hand-crafted POST skips it entirely),
 * so the refusal must be enforceable from server code that never trusts the
 * client's own validation.
 *
 * THE VERIFYING IDENTITY IS DELIBERATELY NOT A FIELD HERE (D23, criteria
 * 112-114). It used to be a typed `verifiedBy` string on
 * `VerificationSubmission`; the owner ruled that a field nobody could
 * attribute is worse than no field, because it still looks like evidence.
 * The authenticated Shopify staff identity (user id + email, from the online
 * session `useOnlineTokens` requests — see `app/shopify.server.ts`) is
 * resolved by the route from `session.onlineAccessInfo` and passed straight
 * into `verification.server.ts`'s `verifyAndCompleteBankPaymentOrder`,
 * never through this form-validation layer — there is no form field for it
 * to come from, and adding one would recreate the exact hazard D23 closed.
 */

/**
 * `CLAUDE.md` #14: eligible Bank Payment methods are electronic only. Kept
 * as a plain string-literal union (not imported from `@prisma/client`) for
 * the same reason `guaranteeDecision.ts`'s `GuaranteeOrderStatus` is: this
 * file stays importable and testable with zero database dependency. The
 * Prisma `BankPaymentMethod` enum (see `prisma/schema.prisma`) is required
 * to have exactly these four members in this exact spelling — a mismatch
 * would surface immediately as a Prisma type error at the one call site
 * (`verification.server.ts`) that writes a validated value into a
 * `bankPaymentOrder.verifiedPaymentMethod` field typed against the real enum.
 */
export const BANK_PAYMENT_METHODS = ["zelle", "ach", "bank_transfer", "wire"] as const;
export type BankPaymentMethod = (typeof BANK_PAYMENT_METHODS)[number];

export function isBankPaymentMethod(value: string): value is BankPaymentMethod {
  return (BANK_PAYMENT_METHODS as readonly string[]).includes(value);
}

/** Raw string inputs exactly as they arrive from an HTML form (`FormData.get` returns `string | null`). No identity field — see this module's header comment (D23). */
export interface RawVerificationSubmission {
  readonly amountReceived: string | null;
  readonly currency: string | null;
  readonly method: string | null;
  /** The one field permitted to stay blank — owner §8.7 calls it "where available". */
  readonly reference: string | null;
}

/**
 * Extracts the four raw fields from a submitted `FormData` — the ONE place
 * that knows the form's field names, so the route's action calls this
 * (pure, no request/session needed) rather than reading `formData.get(...)`
 * inline. `FormData.get` returns `File | string | null`; a `File` (a field
 * renamed/mistyped in the HTML) is treated the same as absent rather than
 * coerced, so a malformed submission fails validation instead of throwing.
 */
export function parseVerificationFormData(formData: FormData): RawVerificationSubmission {
  const getString = (name: string): string | null => {
    const value = formData.get(name);
    return typeof value === "string" ? value : null;
  };
  return {
    amountReceived: getString("amountReceived"),
    currency: getString("currency"),
    method: getString("method"),
    reference: getString("reference"),
  };
}

/** No identity field — see this module's header comment (D23). The verifying identity is the AUTHENTICATED Shopify staff user, supplied separately by the route from the online session, never by this validated form value. */
export interface VerificationSubmission {
  readonly amountReceivedMinorUnits: bigint;
  readonly currency: string;
  readonly method: BankPaymentMethod;
  readonly reference: string | null;
}

export interface VerificationFieldError {
  readonly field: "amountReceived" | "currency" | "method";
  readonly message: string;
}

export type VerificationValidationResult =
  | { readonly ok: true; readonly value: VerificationSubmission }
  | { readonly ok: false; readonly errors: readonly VerificationFieldError[] };

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
/**
 * A dollars-and-cents amount as a person would write it: digits, optionally
 * followed by a decimal point and one or two digits. No symbol, no thousands
 * separators, no more than two decimals.
 *
 * THE FORM USED TO ASK FOR MINOR UNITS — "150000" for $1,500.00 — and that is
 * a money-critical trap however clearly it is labelled: a staff member typing
 * the amount they are reading off a bank statement records one hundredth of
 * it, and what they have recorded is the evidence that the customer paid.
 * Asking for the number that appears on the statement removes the conversion
 * from the human entirely.
 */
const MAJOR_UNIT_AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;

const WHOLE_NUMBER_PATTERN = /^\d+$/;

/**
 * Server-side authoritative validation of a verification submission
 * (criterion 87: "amount, method, reference where available, timestamp and
 * verifying admin"). Timestamp is never taken from the client — it is the
 * server clock at the moment `verification.server.ts` commits the write —
 * so it has no field here.
 *
 * Collects every field error rather than stopping at the first, so a staff
 * member correcting a rejected submission sees every problem at once
 * instead of one round trip per field.
 */
export function validateVerificationSubmission(raw: RawVerificationSubmission): VerificationValidationResult {
  const errors: VerificationFieldError[] = [];

  let amountReceivedMinorUnits: bigint | null = null;
  const amountText = (raw.amountReceived ?? "").trim();
  if (amountText === "") {
    errors.push({ field: "amountReceived", message: "Amount received is required." });
  } else if (!MAJOR_UNIT_AMOUNT_PATTERN.test(amountText)) {
    // REJECTED, NEVER ROUNDED. Everywhere else in this codebase a rounding
    // rule turns a computed decimal into minor units; here the number is not
    // computed, it is a REPORTED FACT about money that arrived. Silently
    // rounding "1500.005" would record a receipt nobody observed, so an
    // amount that is not exactly representable is sent back to the human who
    // typed it.
    errors.push({
      field: "amountReceived",
      message:
        "Amount received must be an amount in dollars and cents, with at most two decimal places " +
        "and no currency symbol or separators — for example 1500 or 1500.00.",
    });
  } else {
    amountReceivedMinorUnits = Money.fromDecimalMajorUnits(
      amountText,
      "USD", // placeholder; the real currency is validated below and never affects the magnitude
      DEFAULT_ROUNDING_RULE_ID
    ).amountMinorUnits;
    if (amountReceivedMinorUnits <= 0n) {
      errors.push({ field: "amountReceived", message: "Amount received must be greater than zero." });
    }
  }

  const currency = (raw.currency ?? "").trim().toUpperCase();
  if (currency === "") {
    errors.push({ field: "currency", message: "Currency is required." });
  } else if (!CURRENCY_PATTERN.test(currency)) {
    errors.push({ field: "currency", message: "Currency must be a 3-letter ISO 4217 code (e.g. USD)." });
  }

  const methodText = (raw.method ?? "").trim();
  if (methodText === "") {
    errors.push({ field: "method", message: "Payment method is required." });
  } else if (!isBankPaymentMethod(methodText)) {
    errors.push({
      field: "method",
      message: `Payment method must be one of: ${BANK_PAYMENT_METHODS.join(", ")}.`,
    });
  }

  const referenceText = (raw.reference ?? "").trim();

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      // Non-null: every branch above that leaves `errors` empty also set this.
      amountReceivedMinorUnits: amountReceivedMinorUnits as bigint,
      currency,
      method: methodText as BankPaymentMethod,
      reference: referenceText === "" ? null : referenceText,
    },
  };
}

/** The subset of a `BankPaymentOrderLine` needed to work out what was actually charged and owed. */
export interface QuotedLineForExpectedTotal {
  readonly quantity: number;
  readonly eligibleAtQuoteTime: boolean;
  readonly quotedBankPaymentPriceMinorUnits: bigint;
  readonly quotedRegularCardPriceMinorUnits: bigint;
}

/**
 * The unit price actually charged for one line: the Bank Payment Price if
 * the line was Bank-Payment-Discount-eligible at quote time, the Regular/
 * Card Price otherwise (owner §18, criterion 71). Restated here rather than
 * imported from `apps.carat.bank-checkout.tsx`'s identical inline rule —
 * that route is out of this task's ownership, and that route's own comment
 * restates the cart pricing rule rather than importing it for the same
 * reason: each of these is "charge as if bank mode", never a re-derivation
 * of a tier, and the two call sites must not be coupled just to save one
 * ternary.
 */
export function chargedUnitPriceMinorUnits(line: QuotedLineForExpectedTotal): bigint {
  return line.eligibleAtQuoteTime ? line.quotedBankPaymentPriceMinorUnits : line.quotedRegularCardPriceMinorUnits;
}

/** Sum of every line's charged unit price × quantity — what the customer was actually quoted to pay in total. */
export function computeExpectedTotal(lines: readonly QuotedLineForExpectedTotal[], currency: string): Money {
  return lines.reduce(
    (total, line) =>
      total.add(Money.fromMinorUnits(chargedUnitPriceMinorUnits(line) * BigInt(line.quantity), currency)),
    Money.zero(currency)
  );
}

export interface AmountComparison {
  readonly expected: Money;
  readonly received: Money;
  /** True when the submitted currency differs from the order's own — a numeric difference across currencies is not a meaningful quantity, so `differenceMinorUnits` is null in that case. */
  readonly currencyMismatch: boolean;
  /** `received - expected`, in the order's minor units. Positive means overpaid, negative means underpaid. Null only when `currencyMismatch`. */
  readonly differenceMinorUnits: bigint | null;
  readonly matchesExactly: boolean;
}

/**
 * Compares what arrived against what was expected. Pure comparison only —
 * it never mutates anything and never decides on its own what a caller does
 * with the answer; that decision differs by caller and lives outside this
 * function:
 *
 *   - `verifyAndCompleteBankPaymentOrder` (D24, criteria 115-117) uses this
 *     to REFUSE a first-time verification submission BEFORE persisting
 *     anything, whenever `!matchesExactly || currencyMismatch`. That
 *     supersedes an earlier design where a mismatch was recorded and only
 *     completion was skipped — the owner ruled that stranded the order in
 *     exactly the state D25 exists to recover, and made a typo unrecoverable
 *     through the idempotency guard.
 *   - The admin route uses this to render the read-only comparison on an
 *     ALREADY-verified order, purely for display — nothing about a past,
 *     already-recorded verification is blocked by this function.
 */
export function compareReceivedToExpected(expected: Money, received: Money): AmountComparison {
  if (expected.currency !== received.currency) {
    return { expected, received, currencyMismatch: true, differenceMinorUnits: null, matchesExactly: false };
  }
  const difference = received.subtract(expected);
  return {
    expected,
    received,
    currencyMismatch: false,
    differenceMinorUnits: difference.amountMinorUnits,
    matchesExactly: difference.isZero(),
  };
}

/**
 * The state a Bank Payment order's verification/completion is in, as far as
 * the admin surface needs to distinguish for rendering (D25, criteria
 * 118-119).
 *
 *   - `unverified`      — open, never verified. Shows the verification form.
 *   - `verified_pending_completion` — open, verified, but no Shopify order
 *     recorded yet. `completeBankPaymentOrder` either has not been attempted
 *     since verification, or was attempted and failed. THE FORM MUST NOT
 *     REAPPEAR here (criterion 118) — recovery is the separate, explicit
 *     "Retry completion" action (criterion 119), never a second verification.
 *   - `completed`       — `status = "completed"`, a real Shopify order exists.
 *   - `cancelled`       — the guarantee sweep (or another reason) cancelled it.
 */
export type BankPaymentVerificationState =
  | "unverified"
  | "verified_pending_completion"
  | "completed"
  | "cancelled";

export function classifyBankPaymentOrderState(order: {
  readonly status: "open" | "cancelled" | "completed";
  readonly verifiedAt: Date | null;
}): BankPaymentVerificationState {
  if (order.status === "cancelled") return "cancelled";
  if (order.status === "completed") return "completed";
  // status === "open"
  return order.verifiedAt ? "verified_pending_completion" : "unverified";
}
