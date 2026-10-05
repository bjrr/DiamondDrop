-- Custom Jewelry intake (Slice 9, README "Custom Jewelry — MVP1 Locked Direction").
--
-- HAND-AUTHORED, same escalation path as its siblings: no local dev database
-- is reachable here, and `migrate reset` / shadow-database `migrate diff` are
-- forbidden. Applied with `migrate deploy`.
--
-- INTAKE MAY BE ANONYMOUS, APPROVAL MAY NOT. `customer_ref` is nullable
-- because the README makes the initial request "free and intentionally
-- low-friction", and `docs/REQUIRED-CUSTOMER-ACCOUNTS.md` requires an
-- authenticated account for every PURCHASE path — naming "Custom Jewelry
-- final approval/purchase" specifically — not for a pre-purchase enquiry.
-- The approval surface, when it is built, must require one.
--
-- NO MONEY MOVES HERE. The $49 Design Deposit is charged later, by a staff
-- action, when CaratForUs is ready to begin design/CAD work. The README is
-- explicit that intake must "not charge the Design Deposit yet", which is why
-- this table has no payment columns at all rather than nullable ones somebody
-- might later fill in from the wrong place.

CREATE TYPE "custom_jewelry_starting_point" AS ENUM ('existing_design', 'from_scratch');
CREATE TYPE "custom_jewelry_follow_up_preference" AS ENUM ('schedule_consultation', 'contact_me');
CREATE TYPE "custom_jewelry_project_status" AS ENUM (
    'submitted',
    'deposit_charged',
    'awaiting_approval',
    'approved',
    'purchased',
    'closed'
);

CREATE TABLE "custom_jewelry_project" (
    "id" UUID NOT NULL,
    "project_reference" TEXT NOT NULL,

    -- Null for an anonymous enquiry. Populated ONLY from the App Proxy's
    -- signed `logged_in_customer_id`, never from anything the browser sends.
    "customer_ref" TEXT,

    "first_name" TEXT NOT NULL,
    "last_name"  TEXT NOT NULL,
    "email"      TEXT NOT NULL,
    "phone"      TEXT NOT NULL,

    "starting_point" "custom_jewelry_starting_point" NOT NULL,
    "prompt_text"    TEXT NOT NULL,
    "jewelry_type"   TEXT,

    -- MINOR UNITS + CURRENCY, never a float. A customer's rough budget is
    -- still money, and CLAUDE.md rule 6 does not have an "approximate"
    -- exemption.
    "approximate_budget_minor_units" BIGINT,
    "approximate_budget_currency"    CHAR(3),

    -- A date, or an explicit "no deadline". Kept as two columns rather than a
    -- sentinel date so "no deadline" can never be confused with "not asked".
    "desired_completion_date" DATE,
    "has_no_deadline"         BOOLEAN NOT NULL DEFAULT false,

    "follow_up_preference" "custom_jewelry_follow_up_preference" NOT NULL,
    "status" "custom_jewelry_project_status" NOT NULL DEFAULT 'submitted',

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "custom_jewelry_project_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "custom_jewelry_project_project_reference_key"
    ON "custom_jewelry_project"("project_reference");
CREATE INDEX "custom_jewelry_project_customer_ref_idx" ON "custom_jewelry_project"("customer_ref");
CREATE INDEX "custom_jewelry_project_status_idx" ON "custom_jewelry_project"("status");

-- A budget is an amount AND a currency or it is neither. A bare number with
-- no currency is the kind of value that later gets read as dollars by someone
-- who never saw this table created — the same all-or-nothing discipline
-- `group_buy_refund_override_complete` and the new archive columns use.
ALTER TABLE "custom_jewelry_project" ADD CONSTRAINT "custom_jewelry_project_budget_complete" CHECK (
    (approximate_budget_minor_units IS NULL AND approximate_budget_currency IS NULL)
    OR (approximate_budget_minor_units IS NOT NULL AND approximate_budget_currency IS NOT NULL)
);

-- A budget cannot be negative. Zero is permitted: "I have no budget in mind"
-- is a real answer a form may legitimately record as 0.
ALTER TABLE "custom_jewelry_project" ADD CONSTRAINT "custom_jewelry_project_budget_non_negative" CHECK (
    approximate_budget_minor_units IS NULL OR approximate_budget_minor_units >= 0
);

-- "No deadline" and a specific date are mutually exclusive answers to one
-- question. Allowing both would leave staff guessing which the customer meant.
ALTER TABLE "custom_jewelry_project" ADD CONSTRAINT "custom_jewelry_project_deadline_exclusive" CHECK (
    NOT (has_no_deadline AND desired_completion_date IS NOT NULL)
);
