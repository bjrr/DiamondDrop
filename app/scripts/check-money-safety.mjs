#!/usr/bin/env node
// Repository-wide check for acceptance criterion 6 (Slice 0 spec): no
// floating-point Math.round/floor/ceil anywhere in the codebase. This is a
// backstop alongside the ESLint no-restricted-syntax rule — run standalone
// in CI so it also catches generated/build output and any file ESLint is
// configured to skip.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");

const SCAN_DIRS = ["app", "tests", "prisma"];
const IGNORE_DIRS = new Set(["node_modules", "build", ".cache", "migrations"]);
const FORBIDDEN_PATTERN = /Math\.(round|floor|ceil)\s*\(/g;

/** @type {string[]} */
const violations = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (IGNORE_DIRS.has(entry)) continue;
    const fullPath = path.join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      walk(fullPath);
      continue;
    }
    if (!/\.(ts|tsx|mjs|js)$/.test(entry)) continue;
    if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) continue;

    const contents = readFileSync(fullPath, "utf8");
    const matches = contents.match(FORBIDDEN_PATTERN);
    if (matches) {
      violations.push(`${path.relative(appRoot, fullPath)}: ${matches.length} forbidden Math.round/floor/ceil call(s)`);
    }
  }
}

for (const dir of SCAN_DIRS) {
  const fullDir = path.join(appRoot, dir);
  try {
    if (statSync(fullDir).isDirectory()) walk(fullDir);
  } catch {
    // directory doesn't exist yet — nothing to scan
  }
}

if (violations.length > 0) {
  console.error("Money safety check failed — ad-hoc Math.round/floor/ceil found outside the centralized rounding registry:");
  for (const violation of violations) console.error(`  - ${violation}`);
  console.error("\nRoute all rounding through app/domain/money/rounding.ts instead.");
  process.exit(1);
}

console.log("Money safety check passed: no ad-hoc Math.round/floor/ceil found.");
