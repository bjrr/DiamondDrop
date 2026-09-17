-- Completes 20260917011234_pricing_engine_tables. Separate migration because
-- that one was already applied; migrations are forward-only, so this adds the
-- remaining L1 append-only triggers, the wildcard-safe stone_cost index
-- rather than editing it.


-- ---------------------------------------------------------------------------
-- Append-only triggers for the L1 raw cost inputs (§4.0, §7.2).
--
-- metal_price, stone_cost, cost_component and pricing_profile are the values
-- exactly as entered or received. A price_calculation records which row it
-- resolved; if that row could later be edited, the calculation's provenance
-- would silently stop describing what was actually used. A correction is a
-- new effective-dated row, never an edit.
--
-- price_sync_intent deliberately gets NO trigger: it is the mutable review
-- and sync state machine (pending_approval -> approved -> syncing -> synced),
-- and freezing it would freeze the workflow.
-- ---------------------------------------------------------------------------

-- metal_price
CREATE TRIGGER metal_price_no_update
    BEFORE UPDATE ON "metal_price"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();
CREATE TRIGGER metal_price_no_delete
    BEFORE DELETE ON "metal_price"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();
CREATE TRIGGER metal_price_no_truncate
    BEFORE TRUNCATE ON "metal_price"
    FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();

-- stone_cost
CREATE TRIGGER stone_cost_no_update
    BEFORE UPDATE ON "stone_cost"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();
CREATE TRIGGER stone_cost_no_delete
    BEFORE DELETE ON "stone_cost"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();
CREATE TRIGGER stone_cost_no_truncate
    BEFORE TRUNCATE ON "stone_cost"
    FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();

-- cost_component
CREATE TRIGGER cost_component_no_update
    BEFORE UPDATE ON "cost_component"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();
CREATE TRIGGER cost_component_no_delete
    BEFORE DELETE ON "cost_component"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();
CREATE TRIGGER cost_component_no_truncate
    BEFORE TRUNCATE ON "cost_component"
    FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();

-- pricing_profile
CREATE TRIGGER pricing_profile_no_update
    BEFORE UPDATE ON "pricing_profile"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();
CREATE TRIGGER pricing_profile_no_delete
    BEFORE DELETE ON "pricing_profile"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();
CREATE TRIGGER pricing_profile_no_truncate
    BEFORE TRUNCATE ON "pricing_profile"
    FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();

-- (The partial unique index limiting price_sync_intent to one non-terminal
-- row per variant is already created by 20260917011234 as
-- price_sync_intent_one_non_terminal_per_variant. Not repeated here.)

-- ---------------------------------------------------------------------------
-- stone_cost duplicate wildcard rows (architect amendment, 2026-09-17).
--
-- Spec §7.2 states this uniqueness rule in plain natural-key form. Implemented
-- literally it does not hold: Postgres treats every NULL in a UNIQUE index as
-- distinct, and five of the key's columns (color, clarity, cut_grade,
-- lab_status, supplier_ref) are nullable wildcards (§4.3). Two rows with an
-- identical non-null prefix and all wildcards NULL are exact duplicates by
-- every meaning that matters, and the plain @@unique accepts both.
--
-- That is worse here than an ordinary duplicate because stone_cost is
-- append-only: the duplicate cannot be deleted. §4.3's resolver would hit an
-- unresolvable tie and throw AmbiguousStoneCostError, so one bad insert
-- permanently breaks pricing for that stone specification with no cleanup
-- path short of dropping a trigger.
--
-- Rejecting it at insert time instead. The sentinels are values the columns
-- cannot legitimately hold.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "stone_cost_natural_key_wildcard_safe"
    ON "stone_cost" (
        "stone_type",
        "shape",
        "carat_min",
        "carat_max",
        COALESCE("color", ''),
        COALESCE("clarity", ''),
        COALESCE("cut_grade", ''),
        COALESCE("lab_status", ''),
        COALESCE("supplier_ref", ''),
        "effective_from"
    );
