-- Closes a gap in the append-only enforcement added by migration
-- 20260913000100 (docs/specs/SLICE-0-FOUNDATION.md §0.5, acceptance
-- criterion 8). Row-level `BEFORE UPDATE OR DELETE ... FOR EACH ROW`
-- triggers do NOT fire for TRUNCATE — Postgres treats TRUNCATE as a
-- separate statement type with its own trigger timing. Without this,
-- `TRUNCATE acknowledgment` (or any of the other three evidence tables)
-- would silently wipe historical transaction evidence while looking, from
-- the row-trigger's point of view, like nothing happened at all — exactly
-- the careless-raw-SQL scenario these triggers exist to defend against.
--
-- Forward-only migration per docs/ARCHITECTURE-MVP1.md §7: this adds a new
-- trigger rather than editing the migration that created the row-level
-- triggers.
--
-- Note: this is a statement-level trigger (`FOR EACH STATEMENT`), since
-- TRUNCATE has no per-row context to inspect (there is no OLD/NEW row).
--
-- Out of scope at this layer: a table owner with sufficient privileges can
-- still `DROP TRIGGER` before running TRUNCATE. That is not something a
-- database trigger can defend against; it is handled by least-privilege
-- database role permissions at deploy time (no application role should
-- hold table-owner/DDL privileges against these tables in production).

CREATE OR REPLACE FUNCTION prevent_evidence_truncate()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'Table % is append-only: TRUNCATE is not permitted', TG_TABLE_NAME
        USING ERRCODE = '23001'; -- restrict_violation
    RETURN NULL; -- unreachable; RAISE EXCEPTION aborts the statement
END;
$$ LANGUAGE plpgsql;

-- policy_version
CREATE TRIGGER policy_version_no_truncate
    BEFORE TRUNCATE ON "policy_version"
    FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();

-- acknowledgment
CREATE TRIGGER acknowledgment_no_truncate
    BEFORE TRUNCATE ON "acknowledgment"
    FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();

-- snapshot
CREATE TRIGGER snapshot_no_truncate
    BEFORE TRUNCATE ON "snapshot"
    FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();

-- audit_event
CREATE TRIGGER audit_event_no_truncate
    BEFORE TRUNCATE ON "audit_event"
    FOR EACH STATEMENT EXECUTE FUNCTION prevent_evidence_truncate();

-- Deliberately NOT applied to webhook_event or idempotency_key: both are
-- documented as mutable (see migration 20260913000100's closing comment).
