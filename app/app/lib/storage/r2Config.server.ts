import { getEnv, type Env } from "~/lib/env.server";

/**
 * Resolves whether Cloudflare R2 (D4, `docs/ARCHITECTURE-MVP1.md`) is
 * configured in this environment, mirroring
 * `~/lib/email/configuredPort.server.ts`'s `resolveEmailPort` shape exactly:
 * an honest `{ configured: false, reason }` rather than a fabricated client
 * when credentials are missing.
 *
 * As of this writing `STORAGE_ENDPOINT` / `STORAGE_BUCKET` /
 * `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY` are empty in every
 * environment (`docs/specs/R2-BUCKET-SETUP.md` — awaiting the owner). Every
 * caller of this function MUST treat `configured: false` as "no upload/read
 * URL is offered" and must never substitute another store (Shopify Files, a
 * public bucket, local disk) — see `docs/specs/R2-BUCKET-SETUP.md`'s header.
 */
export interface R2Config {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export type R2ConfigResolution = { readonly configured: true; readonly config: R2Config } | { readonly configured: false; readonly reason: string };

export function resolveR2Config(env: Env = getEnv()): R2ConfigResolution {
  const missing: string[] = [];
  if (!env.STORAGE_ENDPOINT) missing.push("STORAGE_ENDPOINT");
  if (!env.STORAGE_BUCKET) missing.push("STORAGE_BUCKET");
  if (!env.STORAGE_ACCESS_KEY_ID) missing.push("STORAGE_ACCESS_KEY_ID");
  if (!env.STORAGE_SECRET_ACCESS_KEY) missing.push("STORAGE_SECRET_ACCESS_KEY");
  if (missing.length > 0) {
    return { configured: false, reason: `object storage not configured: missing ${missing.join(", ")}` };
  }

  return {
    configured: true,
    config: {
      endpoint: env.STORAGE_ENDPOINT!,
      bucket: env.STORAGE_BUCKET!,
      accessKeyId: env.STORAGE_ACCESS_KEY_ID!,
      secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY!,
    },
  };
}
