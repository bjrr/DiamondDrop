// Runs inside each integration test worker process — populates
// process.env from .env before any test module (or the app code it
// imports) reads configuration. See vitest.integration.config.ts.
import "dotenv/config";
