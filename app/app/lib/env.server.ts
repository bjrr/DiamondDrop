import { z } from "zod";

/**
 * Startup configuration schema.
 *
 * Full variable set is documented in .env.example per
 * docs/ARCHITECTURE-MVP1.md §7. Only the variables an actual Slice 0 code
 * path reads are required here — everything else is intentionally optional
 * until the slice that consumes it lands (see the comment above each group
 * and .env.example for the mapping). This is a deliberate scoping decision:
 * Slice 0 must boot and run its full test suite with no live Shopify
 * credentials (open decision D1, docs/ARCHITECTURE-MVP1.md §12).
 */
const envSchema = z.object({
  APP_ENV: z.enum(["development", "test", "staging", "production"]),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  /**
   * The unpooled endpoint, used by the Prisma CLI for migrations only - see
   * the comment on directUrl in schema.prisma. The application never reads it;
   * it is declared here so a deployment missing it fails validation loudly
   * rather than at the first migration.
   */
  DIRECT_URL: z.string().optional(),
  SESSION_SECRET: z.string().min(16, "SESSION_SECRET must be at least 16 characters"),
  CRON_SECRET: z.string().min(16, "CRON_SECRET must be at least 16 characters"),

  // Consumed by shopify/webhooks and shopify/proxy verification this slice.
  // Any non-empty string works locally/in CI — it does not need to be a real
  // Shopify-issued secret until slice 2's development-store install.
  SHOPIFY_API_SECRET: z.string().min(1, "SHOPIFY_API_SECRET is required"),
  SHOPIFY_APP_PROXY_SUBPATH: z.string().min(1, "SHOPIFY_APP_PROXY_SUBPATH is required"),

  // Reserved for later slices; no Slice 0 code path reads these yet.
  SHOPIFY_API_KEY: z.string().optional(), // embedded admin OAuth (slice 2+)
  SHOPIFY_SCOPES: z.string().optional(), // embedded admin OAuth (slice 2+)
  SHOPIFY_APP_URL: z.string().optional(), // embedded admin OAuth (slice 2+)
  SHOPIFY_ADMIN_API_VERSION: z.string().optional(), // first Admin API call (slice 1+)
  // Single-merchant app: the one shop's *.myshopify.com domain, used by
  // background jobs (the pricing sync) to obtain an offline-session Admin API
  // client via `unauthenticated.admin(shop)` — there is no incoming request to
  // read it from outside a route (slice 2 T1).
  SHOPIFY_SHOP_DOMAIN: z.string().optional(),
  // D-owner requirement, slice 2 T1 (spec §4.1 criterion 8): auto-publish is
  // OFF unless this is exactly "true". Any other value — unset, "1", "yes",
  // wrong case — stays off. A silent typo defaulting to "on" is precisely the
  // failure mode a default-off, allow-listed-value flag exists to prevent.
  PRICE_AUTO_PUBLISH_ENABLED: z.string().optional(),
  STORAGE_ENDPOINT: z.string().optional(), // first upload (slice 4/5/9/10)
  STORAGE_BUCKET: z.string().optional(),
  STORAGE_ACCESS_KEY_ID: z.string().optional(),
  STORAGE_SECRET_ACCESS_KEY: z.string().optional(),
  EMAIL_API_KEY: z.string().optional(), // first transactional email (slice 7+)
  EMAIL_FROM: z.string().optional(),
  STAFF_EMAIL_ALLOWLIST: z.string().optional(), // first admin auth (slice 2+)
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | undefined;

/**
 * Validates and returns process configuration. Throws with a clear,
 * itemized message on the first invalid/missing value — call this once at
 * boot (see assertEnvOnBoot.server.ts) so failure is immediate, not
 * deferred to whichever request happens to touch the missing var first.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cachedEnv) return cachedEnv;

  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid or missing configuration. Refusing to start.\n${issues}`);
  }

  cachedEnv = result.data;
  return cachedEnv;
}

export function getEnv(): Env {
  return loadEnv();
}

/** Test-only: clears the memoized env so a test can reload with different fixtures. */
export function __resetEnvCacheForTests(): void {
  cachedEnv = undefined;
}
