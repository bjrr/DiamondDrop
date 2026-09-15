import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Unit tests only: pure domain functions, no database, no network.
// Integration tests (real Postgres) live under /tests/integration and run
// via vitest.integration.config.ts instead — see package.json `test:integration`.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["app/**/*.test.ts"],
    exclude: ["node_modules", "build", ".cache", "tests/integration/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["app/domain/**"],
    },
  },
});
