-- Scope the deposit-credit uniqueness to packages that can still be purchased.
--
-- ============================================================================
-- THE BUG THIS FIXES, FOUND BY A TEST ONE MINUTE AFTER IT WAS WRITTEN
-- ============================================================================
-- The owner's requirement is that "the same deposit cannot be credited twice".
-- The first implementation enforced that with a plain partial UNIQUE index on
-- `deposit_payment_id`, which is too strong in a way that breaks the ordinary
-- case:
--
--   version 1 of a package credits the customer's $49 and is superseded by a
--   design revision. Version 2 — the SAME project, the SAME customer, the SAME
--   deposit — cannot be issued, because version 1 still holds the id.
--
-- So revising a design after the deposit was paid was impossible. The test
-- "supersedes the live version and issues the next one" failed with a unique
-- violation on `deposit_payment_id`, which is the index telling the truth about
-- a rule I had written wrongly.
--
-- "CREDITED TWICE" MEANS TWICE WHERE IT COSTS MONEY. A superseded package can
-- never be approved (one-approved-per-project, plus the guard refusing to
-- revive it) and therefore can never be purchased — so the $49 it names is not
-- credited against anything. What must be impossible is two PURCHASABLE
-- packages naming one deposit, which is exactly `status <> 'superseded'`.
--
-- Defence in depth either way: `custom_jewelry_final_purchase` already allows
-- one purchase per approval package, and only one package per project can be
-- approved, so a double credit would have to clear two independent constraints.

DROP INDEX "custom_jewelry_approval_package_deposit_payment_key";

CREATE UNIQUE INDEX "custom_jewelry_approval_package_deposit_payment_key"
    ON "custom_jewelry_approval_package"("deposit_payment_id")
    WHERE "deposit_payment_id" IS NOT NULL AND "status" <> 'superseded';

COMMENT ON INDEX "custom_jewelry_approval_package_deposit_payment_key" IS
  'At most one PURCHASABLE package may credit a given deposit payment. Superseded versions are excluded '
  'because they can never be approved and therefore never purchased — the $49 they name is not credited '
  'against anything. Without that exclusion, revising a design after the deposit was paid is impossible.';
