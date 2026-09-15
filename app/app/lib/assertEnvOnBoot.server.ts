import { loadEnv } from "./env.server";

// Side-effecting on purpose: importing this module validates configuration
// immediately and throws (crashing boot) if it is missing or malformed.
// Imported first thing from entry.server.tsx.
loadEnv();
