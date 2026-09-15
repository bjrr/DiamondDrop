-- Append-only enforcement at the database level for the four evidence
-- tables (docs/specs/SLICE-0-FOUNDATION.md §0.5, acceptance criterion 8).
-- Application-level discipline alone is not sufficient: historical
-- transaction evidence must survive a later bug or a careless migration.
-- The repository layer (app/app/db/repositories) exposes create and read
-- methods only — this trigger is the backstop that makes that true even if
-- someone bypasses the repository layer entirely (a raw SQL script, a
-- future ORM change, a careless manual UPDATE).

CREATE OR REPLACE FUNCTION prevent_evidence_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'Table % is append-only: % is not permitted (attempted on row id %)',
        TG_TABLE_NAME, TG_OP, COALESCE(OLD.id::text, 'unknown')
        USING ERRCODE = '23001'; -- restrict_violation
    RETURN NULL; -- unreachable; RAISE EXCEPTION aborts the statement
END;
$$ LANGUAGE plpgsql;

-- policy_version
CREATE TRIGGER policy_version_no_update
    BEFORE UPDATE ON "policy_version"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER policy_version_no_delete
    BEFORE DELETE ON "policy_version"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

-- acknowledgment
CREATE TRIGGER acknowledgment_no_update
    BEFORE UPDATE ON "acknowledgment"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER acknowledgment_no_delete
    BEFORE DELETE ON "acknowledgment"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

-- snapshot
CREATE TRIGGER snapshot_no_update
    BEFORE UPDATE ON "snapshot"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER snapshot_no_delete
    BEFORE DELETE ON "snapshot"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

-- audit_event
CREATE TRIGGER audit_event_no_update
    BEFORE UPDATE ON "audit_event"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER audit_event_no_delete
    BEFORE DELETE ON "audit_event"
    FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

-- Deliberately NOT applied to webhook_event or idempotency_key: both are
-- documented as mutable in schema.prisma (processed_at/error and
-- status/result are updated after initial insert).
