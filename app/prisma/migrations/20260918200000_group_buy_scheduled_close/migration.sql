-- Scheduled close time, for the storefront countdown (README "Live Savings /
-- Progress" lists "countdown/time remaining" among the required fields).
--
-- Nullable on purpose. An open-ended campaign is legitimate; it simply shows no
-- countdown. Making this required would force a deadline to be invented for
-- every campaign just to satisfy a UI field, and an invented deadline is one
-- the business then has to either honour or visibly miss.
ALTER TABLE "group_buy_campaign"
  ADD COLUMN "scheduled_close_at" TIMESTAMPTZ(6);

-- A close scheduled before the campaign opened is not a schedule.
ALTER TABLE "group_buy_campaign"
  ADD CONSTRAINT "group_buy_scheduled_close_after_open" CHECK (
    scheduled_close_at IS NULL OR opened_at IS NULL OR scheduled_close_at > opened_at
  );
