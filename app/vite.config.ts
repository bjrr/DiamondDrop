// Populate process.env from .env for the whole dev-server process before
// anything else runs (Vite does not do this automatically for server-side
// code — only VITE_-prefixed vars reach import.meta.env). Safe to include
// unconditionally: this is a no-op with no .env file present, which is the
// expected case in production, where the host injects real env vars.
import "dotenv/config";

import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [reactRouter(), tsconfigPaths()],
});
