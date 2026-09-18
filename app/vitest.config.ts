import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Unit tests only: pure domain functions, no database, no network.
// Integration tests (real Postgres) live under /tests/integration and run
// via vitest.integration.config.ts instead — see package.json `test:integration`.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    // Both extensions. Previously .ts only, which meant a .tsx test — any test
    // that renders a component — was silently skipped rather than failing to
    // run. A test suite that quietly ignores a file is worse than one that
    // errors on it.
    // extensions/ too: the theme app extension has source guards, and a test
    // directory that is silently not collected is worse than no test at all —
    // which this project already learned once when .tsx files were excluded.
    include: ["app/**/*.test.{ts,tsx}", "extensions/**/*.test.{ts,tsx}"],
    exclude: ["node_modules", "build", ".cache", "tests/integration/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["app/domain/**"],
    },
  },
});
