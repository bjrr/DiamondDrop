-- Bank Payment orders carry a real shipping charge (owner decision 2026-11-15).
--
-- Supersedes D19's shipping treatment: CaratForUs shipping rules apply
-- consistently regardless of payment method, so a Bank Payment order is
-- charged the same rates as Card checkout rather than an unconditional
-- $0.00 line. `docs/SHIPPING-AND-DELIVERY.md` controls.
--
-- NULLABLE, NOT BACK-FILLED. Rows written before this date really did have no
-- shipping charge, and inventing one would misstate what those customers were
-- quoted. A zero price in these columns means complimentary Express was
-- genuinely earned at $1,000+; NULL means the order predates the decision.
--
-- Recorded on the ORDER, never on an order line. Every merchandise
-- recomputation (refund economics, Bank Payment savings, Group Buy close
-- settlement) sums the lines, so keeping shipping off them is what holds this
-- non-merchandise charge out of all of it.

ALTER TABLE "bank_payment_order"
  ADD COLUMN "shipping_service_title" TEXT,
  ADD COLUMN "shipping_price_minor_units" BIGINT,
  ADD COLUMN "shipping_currency" CHAR(3);

ALTER TABLE "group_buy_bank_payment_order"
  ADD COLUMN "shipping_service_title" TEXT,
  ADD COLUMN "shipping_price_minor_units" BIGINT,
  ADD COLUMN "shipping_currency" CHAR(3);

-- The three columns are set together or not at all. A title with no price, or
-- a price with no currency, is not a state any code path can produce, and a
-- constraint is cheaper than discovering a half-written row during a refund.
ALTER TABLE "bank_payment_order"
  ADD CONSTRAINT "bank_payment_order_shipping_all_or_nothing" CHECK (
    ("shipping_service_title" IS NULL
      AND "shipping_price_minor_units" IS NULL
      AND "shipping_currency" IS NULL)
    OR ("shipping_service_title" IS NOT NULL
      AND "shipping_price_minor_units" IS NOT NULL
      AND "shipping_currency" IS NOT NULL)
  );

ALTER TABLE "group_buy_bank_payment_order"
  ADD CONSTRAINT "group_buy_bank_payment_order_shipping_all_or_nothing" CHECK (
    ("shipping_service_title" IS NULL
      AND "shipping_price_minor_units" IS NULL
      AND "shipping_currency" IS NULL)
    OR ("shipping_service_title" IS NOT NULL
      AND "shipping_price_minor_units" IS NOT NULL
      AND "shipping_currency" IS NOT NULL)
  );

-- Never negative. A negative shipping charge would be a discount wearing a
-- shipping label, and shipping is explicitly outside the discount machinery.
ALTER TABLE "bank_payment_order"
  ADD CONSTRAINT "bank_payment_order_shipping_price_non_negative" CHECK (
    "shipping_price_minor_units" IS NULL OR "shipping_price_minor_units" >= 0
  );

ALTER TABLE "group_buy_bank_payment_order"
  ADD CONSTRAINT "group_buy_bank_payment_order_shipping_price_non_negative" CHECK (
    "shipping_price_minor_units" IS NULL OR "shipping_price_minor_units" >= 0
  );
