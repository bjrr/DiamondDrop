-- Let a Bank Payment order carry a CUSTOM line (Custom Jewelry final purchase).
--
-- ============================================================================
-- WHY EXTEND THIS TABLE RATHER THAN BUILD A SECOND ONE
-- ============================================================================
-- Owner instruction: "Reuse the existing CaratForUs payment architecture rather
-- than creating a second money system."
--
-- `bank_payment_order_line` is built around catalogue variants: both
-- `master_variant_id` and `price_calculation_id` are NOT NULL foreign keys,
-- because every Bank Payment line so far has been a Buy Now variant priced by
-- the pricing engine. A Custom Jewelry piece has neither. It is made once, for
-- one customer, at a price a human approved on an approval package.
--
-- The alternative was a parallel verification path for custom pieces — which
-- is exactly the second money system the owner forbade, and would mean the
-- §22 rules (pending until receipt, manual verification, no payment state
-- inferred from customer action) existed twice and could drift apart.
--
-- SO THE LINE LEARNS ABOUT CUSTOM WORK, and everything downstream keeps
-- working unchanged. `computeExpectedTotal` sums
-- `chargedUnitPrice * quantity` from the quoted columns and never touches the
-- variant, so the amount comparison that guards verification is unaffected —
-- which is the property that made this safe to do rather than merely tidy.
--
-- ============================================================================
-- EXACTLY ONE KIND OF LINE, ENFORCED
-- ============================================================================
-- A line is either a catalogue variant line (variant + calculation, no
-- description) or a custom line (description, neither FK). A row with both
-- would be a line claiming to be priced by the engine AND by a human, and
-- nothing downstream could say which price was authoritative.

ALTER TABLE "bank_payment_order_line"
  ALTER COLUMN "master_variant_id" DROP NOT NULL;
ALTER TABLE "bank_payment_order_line"
  ALTER COLUMN "price_calculation_id" DROP NOT NULL;

-- What the customer sees on the invoice for a custom line. Present only on
-- custom lines, which is what distinguishes the two kinds.
ALTER TABLE "bank_payment_order_line"
  ADD COLUMN "custom_line_description" TEXT;

-- The approval package this custom line was priced from. The audit trail from
-- a bank payment back to the exact design and price the customer approved —
-- without it, a custom line's price would be a number with no provenance,
-- which is the whole thing the approval package exists to prevent.
ALTER TABLE "bank_payment_order_line"
  ADD COLUMN "custom_jewelry_approval_package_id" UUID;

ALTER TABLE "bank_payment_order_line"
  ADD CONSTRAINT "bank_payment_order_line_approval_package_fkey"
  FOREIGN KEY ("custom_jewelry_approval_package_id")
  REFERENCES "custom_jewelry_approval_package"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "bank_payment_order_line"
  ADD CONSTRAINT "bank_payment_order_line_exactly_one_kind" CHECK (
    -- A catalogue variant line: priced by the engine, no description.
    ("master_variant_id" IS NOT NULL
     AND "price_calculation_id" IS NOT NULL
     AND "custom_line_description" IS NULL
     AND "custom_jewelry_approval_package_id" IS NULL)
    OR
    -- A custom line: priced by an approved package, no engine calculation.
    ("master_variant_id" IS NULL
     AND "price_calculation_id" IS NULL
     AND btrim(COALESCE("custom_line_description", '')) <> ''
     AND "custom_jewelry_approval_package_id" IS NOT NULL)
  );

COMMENT ON COLUMN "bank_payment_order_line"."custom_line_description" IS
  'Set only on a CUSTOM line — a Custom Jewelry piece, made once, priced by a human on an approval '
  'package rather than by the pricing engine. A catalogue variant line leaves this null and carries its '
  'variant and price calculation instead; a CHECK enforces exactly one of the two shapes.';

COMMENT ON COLUMN "bank_payment_order_line"."custom_jewelry_approval_package_id" IS
  'The approved package a custom line was priced from. The audit trail from a verified bank payment back '
  'to the exact design and price the customer approved.';
