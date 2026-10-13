-- SLICE 13 — DEMAND CAPTURE
--
-- "Bring It Back / Notify Me If It Returns" against a past campaign, and
-- "Request a New Group Buy". README requires both to be LOW FRICTION and
-- explicitly not a custom-design questionnaire.
--
-- Three database-level guarantees, because an unauthenticated public endpoint
-- writes this table:
--
--   1. the two kinds have genuinely different required shapes, enforced by a
--      CHECK rather than by whichever route happens to insert;
--   2. one person cannot register twice for the same campaign, enforced by a
--      partial UNIQUE index — which also makes a repeated submission
--      idempotent instead of an error the route has to interpret;
--   3. the email is stored lowercased, enforced by a CHECK, so the dedup
--      index in (2) cannot be defeated by "Ada@Example.com".

CREATE TYPE "group_buy_demand_signal_kind" AS ENUM ('bring_it_back', 'new_campaign_request');

CREATE TABLE "group_buy_demand_signal" (
    "id"                 UUID NOT NULL,
    "kind"               "group_buy_demand_signal_kind" NOT NULL,
    "email"              TEXT NOT NULL,
    "campaign_ref"       TEXT,
    "note"               TEXT,
    "acknowledgment_id"  UUID NOT NULL,
    "notified_at"        TIMESTAMPTZ(6),
    "notified_by"        TEXT,
    "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_buy_demand_signal_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "group_buy_demand_signal"
    ADD CONSTRAINT "group_buy_demand_signal_acknowledgment_id_fkey"
    FOREIGN KEY ("acknowledgment_id") REFERENCES "acknowledgment"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- (1) THE TWO KINDS HAVE DIFFERENT SHAPES.
--
-- A "bring it back" that names no campaign is unactionable — there is nothing
-- to bring back. A "new campaign request" that names an existing campaign is a
-- bring-it-back filed under the wrong kind, and would be counted as demand for
-- something new that is not new. A request with no note says nothing at all.
ALTER TABLE "group_buy_demand_signal"
    ADD CONSTRAINT "group_buy_demand_signal_kind_shape" CHECK (
        (kind = 'bring_it_back'
            AND campaign_ref IS NOT NULL
            AND length(btrim(campaign_ref)) > 0)
        OR
        (kind = 'new_campaign_request'
            AND campaign_ref IS NULL
            AND note IS NOT NULL
            AND length(btrim(note)) > 0)
    );

-- (3) THE EMAIL IS ALWAYS LOWERCASE AND TRIMMED.
--
-- Checked in the database because the dedup index below is only as good as
-- this: with mixed case, one person registers as many times as they have
-- capitalisations, and the public endpoint would quietly accept every one.
ALTER TABLE "group_buy_demand_signal"
    ADD CONSTRAINT "group_buy_demand_signal_email_normalised" CHECK (
        email = lower(btrim(email)) AND length(email) > 0 AND position('@' in email) > 1
    );

-- (2) ONE REGISTRATION PER PERSON PER CAMPAIGN.
--
-- PARTIAL, covering `bring_it_back` only. A new-campaign request has a NULL
-- campaign_ref, and in Postgres NULLs are distinct — so including those rows
-- would make the index silently do nothing for them. That is also the correct
-- behaviour: wanting two different new campaigns is two legitimate requests,
-- whereas asking twice to be told about ONE campaign is the same ask.
--
-- THE ROUTE RELIES ON THIS BEING A CONSTRAINT, NOT A PRE-CHECK: two concurrent
-- submissions of the same address cannot both pass, and the second is treated
-- as the success it is rather than as an error.
CREATE UNIQUE INDEX "group_buy_demand_signal_one_per_campaign"
    ON "group_buy_demand_signal"("email", "campaign_ref")
    WHERE kind = 'bring_it_back';

CREATE INDEX "group_buy_demand_signal_kind_created_at_idx"
    ON "group_buy_demand_signal"("kind", "created_at");

CREATE INDEX "group_buy_demand_signal_campaign_ref_idx"
    ON "group_buy_demand_signal"("campaign_ref");
