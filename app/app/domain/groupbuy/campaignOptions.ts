/**
 * Group Buy campaign-options JSON contract — the versioned format that
 * describes WHAT MAY BE SOLD in a campaign (`docs/SLICE-2-AND-GROUP-BUY-
 * OWNER-DECISIONS.md` §11-§13, locked 2026-09-19; slice 6). §13 deferred the
 * formal schema until this task; §12 already locked the contract itself —
 * this module and `group-buy-options.schema.json` (same directory) ARE that
 * schema, not an invention of one.
 *
 * PURE — no database access, no I/O, no ambient clock. Validates a raw,
 * untrusted parsed-JSON upload (`unknown`) against the contract and, on
 * success, hands back a typed, already-validated value. Nothing here reads
 * from or writes to a database; a future upload route/repository calls
 * `validateGroupBuyCampaignOptions` before ever persisting anything.
 *
 * NOTHING RING-SHAPED IS HARD-CODED (§11). There is no `ringSize` field, no
 * fixed set of dimension keys, no assumption that any particular key exists
 * or means anything in particular. `GroupBuyOptionDimension.key` is an
 * arbitrary campaign-chosen string — "metal", "length", "clasp", "ringSize"
 * if a ring campaign wants that exact spelling, but this module never reads
 * or special-cases it. The bracelet fixture in this module's test file
 * exists specifically so "no ring assumptions" is EXERCISED, not merely
 * asserted by the absence of the word "ring" in this file.
 *
 * TWO LAYERS OF DEFENSE AGAINST FORBIDDEN PRICING DATA (§12): the JSON
 * Schema's `additionalProperties: false` at every object level already
 * structurally rejects an unrecognised key like `margin` or `upliftTier`
 * anywhere the schema defines a closed shape — but JSON Schema alone gives a
 * generic "additional property not allowed" message, and cannot search
 * inside array items or object maps whose keys are themselves data (like
 * `validCombinations[].values`, keyed by campaign-chosen dimension keys,
 * which must stay open). `findForbiddenPricingKeys` below is the second
 * layer: a recursive walk over the ENTIRE raw upload, keyed-object or not,
 * that names the exact offending key and its path. REFUSED LOUDLY, NEVER
 * SILENTLY DROPPED — see that function's own header for why silent removal
 * is the dangerous option, not the safe one.
 */

// ---------------------------------------------------------------------------
// Forbidden pricing keys (§12) — refused loudly, never silently dropped.
//
// SILENTLY DISCARDING A `margin` OR `uplift` KEY WOULD BE WORSE THAN
// ACCEPTING IT. An uploader who included one believes they configured that
// rule. If this module quietly stripped it, the campaign would price
// according to whatever the versioned pricing system actually does — which
// the uploader never sees, never confirmed, and has no reason to suspect
// differs from what they typed. The campaign prices differently from what
// they think they set, and nobody finds out until money is wrong. Refusing
// the upload outright, by name, is what lets the uploader notice and fix it
// before a campaign ever opens.
// ---------------------------------------------------------------------------

interface ForbiddenKeyPattern {
  readonly pattern: RegExp;
  /** Which §12 prohibition this pattern names — used in the error message. */
  readonly reason: string;
}

/**
 * Ordered MOST-SPECIFIC-FIRST so a key like `pricingFormula` is reported as
 * "a Group Buy pricing-engine formula", not the generic pricing backstop —
 * the specific reason is more useful to whoever is fixing the upload.
 */
const FORBIDDEN_KEY_PATTERNS: readonly ForbiddenKeyPattern[] = [
  { pattern: /uplift/i, reason: "a Bank/Card uplift tier" },
  { pattern: /margin/i, reason: "a margin rule" },
  { pattern: /min(?:imum)?[_-]?profit/i, reason: "a minimum-profit rule" },
  { pattern: /pric(?:e|ing)[_-]?rule[_-]?id/i, reason: "an internal pricing-rule id" },
  { pattern: /processor[_-]?fee/i, reason: "a processor fee" },
  { pattern: /pric(?:e|ing)[_-]?formula/i, reason: "a Group Buy pricing-engine formula" },
  { pattern: /pric(?:e|ing)/i, reason: "pricing data" }, // backstop — §12: the JSON must not define the pricing policy at all, not only the six named examples.
];

export interface ForbiddenPricingKeyViolation {
  /** Dotted/bracketed path to the offending key, e.g. `optionDimensions[0].margin`. */
  readonly path: string;
  readonly key: string;
  readonly reason: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively walks an entire raw upload — object keys AND array elements,
 * arbitrarily deep — and reports every key matching a §12-forbidden
 * pricing concept. Walks the whole tree rather than only the top level
 * because nothing stops an uploader (or a copy-pasted template) from
 * nesting a `margin` field inside an option dimension or a valid
 * combination instead of at the root.
 */
export function findForbiddenPricingKeys(input: unknown, path = "$"): readonly ForbiddenPricingKeyViolation[] {
  const violations: ForbiddenPricingKeyViolation[] = [];

  if (isPlainObject(input)) {
    for (const [key, value] of Object.entries(input)) {
      const match = FORBIDDEN_KEY_PATTERNS.find((candidate) => candidate.pattern.test(key));
      const keyPath = `${path}.${key}`;
      if (match) {
        violations.push({ path: keyPath, key, reason: match.reason });
      }
      violations.push(...findForbiddenPricingKeys(value, keyPath));
    }
  } else if (Array.isArray(input)) {
    input.forEach((item, index) => {
      violations.push(...findForbiddenPricingKeys(item, `${path}[${index}]`));
    });
  }

  return violations;
}

// ---------------------------------------------------------------------------
// The contract shape (§12's list, verbatim): schema version, product/campaign
// type metadata, option dimensions, labels, allowed values, required/optional
// status, display ordering, valid combinations, table-view configuration,
// ordering-flow configuration. Nothing about price, margin, uplift, or a
// pricing-engine formula belongs on any of these types — that is enforced
// above, not by the shape of the TypeScript alone (a type can omit a field;
// it cannot refuse one supplied at runtime by an untrusted upload).
// ---------------------------------------------------------------------------

/** VERSIONED FROM THE START (§12): a campaign published today must remain readable when the format changes. Extend this list; never reinterpret an old version's meaning. */
export const GROUP_BUY_OPTIONS_SCHEMA_VERSIONS = [1] as const;
export type GroupBuyOptionsSchemaVersion = (typeof GROUP_BUY_OPTIONS_SCHEMA_VERSIONS)[number];

export interface GroupBuyOptionAllowedValue {
  readonly value: string;
  readonly label: string;
}

export interface GroupBuyOptionDimension {
  /** Campaign-chosen, arbitrary identifier — "metal", "length", "clasp", whatever this campaign's product actually varies by. Never assumed. */
  readonly key: string;
  readonly label: string;
  readonly required: boolean;
  /** Display/order sequencing (§12) — ascending, need not be contiguous. */
  readonly displayOrder: number;
  readonly allowedValues: readonly GroupBuyOptionAllowedValue[];
}

/** One purchasable configuration — an exact set of dimension-key -> value pairs. */
export interface GroupBuyValidCombination {
  readonly values: Readonly<Record<string, string>>;
}

/** Which dimensions appear as columns in the public comparison table, and in what order (README §10). No price column here — the table's price cell is Regular/Card Price, computed and rendered by the pricing/storefront layers, never carried in this contract. */
export interface GroupBuyTableViewConfig {
  readonly columns: readonly string[];
}

/** The sequence of dimension keys presented while a customer is choosing a configuration. */
export interface GroupBuyOrderingFlowConfig {
  readonly steps: readonly string[];
}

export interface GroupBuyCampaignMetadata {
  /** Free text — "ring", "bracelet", "necklace", or anything else a future campaign sells. Never validated against a fixed set; this module has no opinion on what product types exist. */
  readonly productType: string;
  readonly title?: string;
  readonly description?: string;
}

export interface GroupBuyCampaignOptions {
  readonly schemaVersion: GroupBuyOptionsSchemaVersion;
  readonly campaign: GroupBuyCampaignMetadata;
  readonly optionDimensions: readonly GroupBuyOptionDimension[];
  readonly validCombinations: readonly GroupBuyValidCombination[];
  readonly tableView: GroupBuyTableViewConfig;
  readonly orderingFlow: GroupBuyOrderingFlowConfig;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type GroupBuyCampaignOptionsValidationResult =
  | { readonly ok: true; readonly value: GroupBuyCampaignOptions }
  | { readonly ok: false; readonly problems: readonly string[] };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validates a raw parsed-JSON upload against the campaign-options contract.
 * Collects every problem rather than stopping at the first — same discipline
 * as `tiers.ts`'s `validateTierSet` — so whoever is fixing a broken upload
 * sees everything wrong with it in one pass.
 *
 * ORDER OF CHECKS IS DELIBERATE: forbidden pricing keys are found FIRST and
 * reported individually by name (§12's "refuse loudly"), before this
 * function ever tries to interpret the upload as a shape at all — a
 * malformed-AND-pricing-polluted upload should never have its pricing
 * violation hidden behind an unrelated shape error.
 */
export function validateGroupBuyCampaignOptions(input: unknown): GroupBuyCampaignOptionsValidationResult {
  const problems: string[] = [];

  for (const violation of findForbiddenPricingKeys(input)) {
    problems.push(
      `${violation.path}: "${violation.key}" is ${violation.reason} — pricing policy does not belong in the campaign-options contract (docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md §12)`
    );
  }

  if (!isPlainObject(input)) {
    problems.push("$: campaign options must be a JSON object");
    return { ok: false, problems };
  }

  // Schema version — an unknown version is refused, never best-guessed.
  const schemaVersion = input.schemaVersion;
  if (typeof schemaVersion !== "number" || !(GROUP_BUY_OPTIONS_SCHEMA_VERSIONS as readonly number[]).includes(schemaVersion)) {
    problems.push(
      `$.schemaVersion: must be one of [${GROUP_BUY_OPTIONS_SCHEMA_VERSIONS.join(", ")}], got ${JSON.stringify(schemaVersion)}`
    );
    // Nothing below this point can be safely interpreted against a version
    // this module does not know — an unknown version might reuse a field
    // name for something else entirely. Refuse now rather than validate a
    // shape that may not mean what it appears to.
    return { ok: false, problems };
  }

  // campaign metadata
  const campaign = input.campaign;
  if (!isPlainObject(campaign) || !isNonEmptyString(campaign.productType)) {
    problems.push("$.campaign.productType: required, non-empty string — this module has no fixed set of product types");
  }

  // optionDimensions
  const optionDimensionsRaw = input.optionDimensions;
  const dimensionKeys = new Set<string>();
  const requiredDimensionKeys = new Set<string>();
  if (!Array.isArray(optionDimensionsRaw) || optionDimensionsRaw.length === 0) {
    problems.push("$.optionDimensions: required, non-empty array");
  } else {
    optionDimensionsRaw.forEach((dimension, index) => {
      const path = `$.optionDimensions[${index}]`;
      if (!isPlainObject(dimension)) {
        problems.push(`${path}: must be an object`);
        return;
      }
      if (!isNonEmptyString(dimension.key)) {
        problems.push(`${path}.key: required, non-empty string`);
      } else if (dimensionKeys.has(dimension.key)) {
        problems.push(`${path}.key: duplicate dimension key "${dimension.key}"`);
      } else {
        dimensionKeys.add(dimension.key);
        if (dimension.required === true) requiredDimensionKeys.add(dimension.key);
      }
      if (!isNonEmptyString(dimension.label)) {
        problems.push(`${path}.label: required, non-empty string`);
      }
      if (typeof dimension.required !== "boolean") {
        problems.push(`${path}.required: required, boolean`);
      }
      if (typeof dimension.displayOrder !== "number" || !Number.isFinite(dimension.displayOrder)) {
        problems.push(`${path}.displayOrder: required, finite number`);
      }
      const allowedValuesRaw = dimension.allowedValues;
      if (!Array.isArray(allowedValuesRaw) || allowedValuesRaw.length === 0) {
        problems.push(`${path}.allowedValues: required, non-empty array`);
      } else {
        const seenValues = new Set<string>();
        allowedValuesRaw.forEach((allowedValue, valueIndex) => {
          const valuePath = `${path}.allowedValues[${valueIndex}]`;
          if (!isPlainObject(allowedValue) || !isNonEmptyString(allowedValue.value) || !isNonEmptyString(allowedValue.label)) {
            problems.push(`${valuePath}: must be an object with non-empty "value" and "label" strings`);
            return;
          }
          if (seenValues.has(allowedValue.value)) {
            problems.push(`${valuePath}.value: duplicate allowed value "${allowedValue.value}" within dimension "${String(dimension.key)}"`);
          }
          seenValues.add(allowedValue.value);
        });
      }
    });
  }

  /** Every allowed value for a dimension key, once dimensions are known to be well-formed enough to read. */
  function allowedValuesFor(key: string): ReadonlySet<string> {
    if (!Array.isArray(optionDimensionsRaw)) return new Set();
    const dimension = optionDimensionsRaw.find((d) => isPlainObject(d) && d.key === key);
    if (!isPlainObject(dimension) || !Array.isArray(dimension.allowedValues)) return new Set();
    return new Set(
      dimension.allowedValues
        .filter((v): v is { value: string } => isPlainObject(v) && isNonEmptyString(v.value))
        .map((v) => v.value)
    );
  }

  // validCombinations — every referenced key/value must be declared
  // (criterion: a config whose valid combinations reference an undeclared
  // value is refused, since that is how a broken campaign reaches
  // customers), and every required dimension must be present.
  const validCombinationsRaw = input.validCombinations;
  if (!Array.isArray(validCombinationsRaw) || validCombinationsRaw.length === 0) {
    problems.push("$.validCombinations: required, non-empty array");
  } else {
    validCombinationsRaw.forEach((combination, index) => {
      const path = `$.validCombinations[${index}]`;
      if (!isPlainObject(combination) || !isPlainObject(combination.values)) {
        problems.push(`${path}.values: required object mapping dimension key -> value`);
        return;
      }
      const presentKeys = new Set(Object.keys(combination.values));
      for (const [key, value] of Object.entries(combination.values)) {
        if (!dimensionKeys.has(key)) {
          problems.push(`${path}.values.${key}: references undeclared option dimension "${key}"`);
          continue;
        }
        if (typeof value !== "string" || !allowedValuesFor(key).has(value)) {
          problems.push(`${path}.values.${key}: "${String(value)}" is not a declared allowed value for dimension "${key}"`);
        }
      }
      for (const requiredKey of requiredDimensionKeys) {
        if (!presentKeys.has(requiredKey)) {
          problems.push(`${path}.values: missing required dimension "${requiredKey}"`);
        }
      }
    });
  }

  // tableView / orderingFlow — every referenced key must be a declared dimension.
  const tableView = input.tableView;
  if (!isPlainObject(tableView) || !Array.isArray(tableView.columns)) {
    problems.push("$.tableView.columns: required array of dimension keys");
  } else {
    tableView.columns.forEach((column, index) => {
      if (typeof column !== "string" || !dimensionKeys.has(column)) {
        problems.push(`$.tableView.columns[${index}]: references undeclared option dimension ${JSON.stringify(column)}`);
      }
    });
  }

  const orderingFlow = input.orderingFlow;
  if (!isPlainObject(orderingFlow) || !Array.isArray(orderingFlow.steps)) {
    problems.push("$.orderingFlow.steps: required array of dimension keys");
  } else {
    orderingFlow.steps.forEach((step, index) => {
      if (typeof step !== "string" || !dimensionKeys.has(step)) {
        problems.push(`$.orderingFlow.steps[${index}]: references undeclared option dimension ${JSON.stringify(step)}`);
      }
    });
  }

  if (problems.length > 0) {
    return { ok: false, problems };
  }
  return { ok: true, value: input as unknown as GroupBuyCampaignOptions };
}

/**
 * Whether a proposed customer selection is a purchasable configuration
 * (§11: "invalid combinations must not be purchasable"). Exact match only —
 * a selection is valid iff it names precisely the same dimension keys and
 * values as one of the contract's declared `validCombinations` entries, no
 * more and no fewer. This function never guesses at partial matches; the
 * contract is the only source of truth for what is purchasable.
 */
export function isGroupBuyOptionSelectionValid(
  config: GroupBuyCampaignOptions,
  selection: Readonly<Record<string, string>>
): boolean {
  return config.validCombinations.some((combination) => {
    const combinationKeys = Object.keys(combination.values);
    const selectionKeys = Object.keys(selection);
    if (combinationKeys.length !== selectionKeys.length) return false;
    return combinationKeys.every((key) => combination.values[key] === selection[key]);
  });
}
