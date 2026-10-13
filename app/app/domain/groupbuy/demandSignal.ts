import { DEMAND_CAPTURE_NOTE_MAX_LENGTH } from "./demandCaptureCopy";

/**
 * VALIDATING AND NORMALISING A DEMAND SIGNAL before it reaches the database.
 *
 * ============================================================================
 * WHY NORMALISATION IS A DOMAIN CONCERN AND NOT AN INCIDENTAL `toLowerCase()`
 * ============================================================================
 * The whole deduplication guarantee rests on it. `group_buy_demand_signal` has
 * a partial UNIQUE index on (email, campaign_ref) for `bring_it_back`, so one
 * person registers once per campaign — but only if "Ada@Example.com" and
 * "ada@example.com" are the same string by the time they arrive. The database
 * also CHECKs it (`group_buy_demand_signal_email_normalised`), which means a
 * mistake here is a constraint violation rather than a duplicate. Both layers
 * on purpose; this one exists so the failure is a validation message instead.
 *
 * ============================================================================
 * WHAT IT DELIBERATELY DOES NOT DO
 * ============================================================================
 * It does not verify that the address is real, deliverable, or the sender's.
 * An email-verification round trip is friction the README explicitly rules out
 * ("low-friction interest capture"), and the consequence of a wrong address is
 * one unsent notification rather than anything that moves money.
 *
 * It does not validate the address against RFC 5322. A full-grammar regex
 * accepts things no mail server will and rejects things that work; the shape
 * check below is the cheap, honest subset — there is an @, something either
 * side of it, a dot in the domain, and no whitespace.
 */

export type DemandSignalKind = "bring_it_back" | "new_campaign_request";

export interface DemandSignalSubmission {
  readonly kind: DemandSignalKind;
  readonly email: string;
  readonly campaignRef: string | null;
  readonly note: string | null;
}

export type DemandSignalProblem =
  | "email_missing"
  | "email_malformed"
  | "email_too_long"
  | "campaign_required"
  | "campaign_not_allowed"
  | "note_required"
  | "note_too_long"
  | "unknown_kind";

export type DemandSignalParseResult =
  | { readonly ok: true; readonly value: DemandSignalSubmission }
  | { readonly ok: false; readonly problems: readonly DemandSignalProblem[] };

/**
 * 254 is the practical maximum length of an email address (RFC 5321's limit on
 * a forward path). Bounded here rather than left to the column so a very long
 * body is rejected as input instead of stored.
 */
const EMAIL_MAX_LENGTH = 254;

/** An @, something either side, a dot in the domain, no whitespace. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function normalizeDemandSignalEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function parseDemandSignal(input: {
  kind: string;
  email: string;
  campaignRef?: string | null;
  note?: string | null;
}): DemandSignalParseResult {
  const problems: DemandSignalProblem[] = [];

  const kind = input.kind as DemandSignalKind;
  if (kind !== "bring_it_back" && kind !== "new_campaign_request") {
    // Nothing else can be checked coherently without knowing the kind — the
    // required shape depends on it — so this returns immediately rather than
    // reporting a pile of consequential problems.
    return { ok: false, problems: ["unknown_kind"] };
  }

  const email = normalizeDemandSignalEmail(input.email ?? "");
  if (email.length === 0) problems.push("email_missing");
  else if (email.length > EMAIL_MAX_LENGTH) problems.push("email_too_long");
  else if (!EMAIL_SHAPE.test(email)) problems.push("email_malformed");

  const campaignRef = (input.campaignRef ?? "").trim();
  const note = (input.note ?? "").trim();

  // THE SAME SHAPE RULE THE DATABASE CHECKS. Stated twice on purpose: the
  // CHECK is the guarantee, this is the sentence a person reads.
  if (kind === "bring_it_back") {
    if (campaignRef.length === 0) problems.push("campaign_required");
  } else {
    // A new-campaign request that names an existing campaign is a
    // bring-it-back filed under the wrong kind, and would be counted as
    // demand for something that is not new.
    if (campaignRef.length > 0) problems.push("campaign_not_allowed");
    if (note.length === 0) problems.push("note_required");
  }

  if (note.length > DEMAND_CAPTURE_NOTE_MAX_LENGTH) problems.push("note_too_long");

  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    value: {
      kind,
      email,
      campaignRef: kind === "bring_it_back" ? campaignRef : null,
      // An empty note is stored as NULL rather than "", so "they said nothing"
      // and "they said the empty string" are not two different states.
      note: note.length > 0 ? note : null,
    },
  };
}
