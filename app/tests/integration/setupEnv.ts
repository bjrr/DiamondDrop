// Runs inside each integration test worker process — populates
// process.env from .env before any test module (or the app code it
// imports) reads configuration. See vitest.integration.config.ts.
import "dotenv/config";

// Lets the D15 write-surface test observe every statement the shared Prisma
// client issues. Must be set BEFORE app/db/client.server.ts constructs the
// client, which is why it lives here rather than inside the test file.
process.env.PRISMA_EMIT_QUERY_EVENTS = "1";
