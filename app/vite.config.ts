// Populate process.env from .env for the whole dev-server process before
// anything else runs (Vite does not do this automatically for server-side
// code — only VITE_-prefixed vars reach import.meta.env). Safe to include
// unconditionally: this is a no-op with no .env file present, which is the
// expected case in production, where the host injects real env vars.
import "dotenv/config";

import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Hosts the dev server will answer to (D1, slice 2).
 *
 * `shopify app dev` puts the local server behind a public HTTPS tunnel, and the
 * tunnel forwards requests carrying ITS hostname in the Host header. Vite's
 * host check rejects those by default — a protection against DNS-rebinding
 * attacks on a developer's machine — so the tunnel must be allowlisted or every
 * request returns "Blocked request. This host is not allowed."
 *
 * Allowlisted by SUFFIX rather than by the exact hostname, because the Shopify
 * CLI mints a fresh random subdomain on each `shopify app dev` run. A leading
 * dot means "this domain and any subdomain of it" to Vite.
 *
 * Deliberately NOT `allowedHosts: true`. That disables the check entirely, and
 * while the practical risk on a dev machine is small, "allow everything" is the
 * kind of setting that survives into a staging config unnoticed.
 *
 * Architecture note: finding F-25 predicted a Vite major upgrade would be
 * needed here, because `server.allowedHosts` did not exist in Vite 5 when that
 * finding was written. It was backported, and we run 5.4.21, which has it. No
 * upgrade required — see docs/ARCHITECTURE-MVP1.md.
 */
const TUNNEL_HOST_SUFFIXES = [
  ".trycloudflare.com", // Shopify CLI's default tunnel provider
  ".ngrok-free.app", // documented fallback in .env.example
  ".ngrok.io",
];

export default defineConfig({
  plugins: [reactRouter(), tsconfigPaths()],
  server: {
    // `shopify app dev` assigns a port and expects the process it launches to
    // listen on it. Vite does not read PORT on its own, so without this the CLI
    // tunnels to a port nothing is serving — the dev session comes up and every
    // request fails, which reads as a tunnel fault rather than a config one.
    //
    // `undefined` rather than a hard-coded fallback: outside a CLI session Vite
    // should keep choosing its own port exactly as before.
    port: Number(process.env.PORT) || undefined,
    allowedHosts: TUNNEL_HOST_SUFFIXES,
  },
});
