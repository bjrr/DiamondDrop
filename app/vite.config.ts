// Populate process.env from .env for the whole dev-server process before
// anything else runs (Vite does not do this automatically for server-side
// code — only VITE_-prefixed vars reach import.meta.env). Safe to include
// unconditionally: this is a no-op with no .env file present, which is the
// expected case in production, where the host injects real env vars.
import "dotenv/config";

import { vitePlugin as remix } from "@remix-run/dev";
import { installGlobals } from "@remix-run/node";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

installGlobals();

export default defineConfig({
  plugins: [remix(), tsconfigPaths()],
});
