/**
 * LIVE GATE — Cloudflare R2 evidence storage (R2 adapter task, `docs/specs/
 * R2-BUCKET-SETUP.md`, `docs/specs/SLICE-5-WARRANTY-CLAIMS.md` §5).
 *
 * WRITTEN, NOT RUN. `STORAGE_ENDPOINT` / `STORAGE_BUCKET` /
 * `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY` are empty in every
 * environment as of this writing — the bucket does not exist yet. This gate
 * cannot pass, or even attempt anything, until the owner completes
 * `docs/specs/R2-BUCKET-SETUP.md` and sets the four Fly secrets. Uploads stay
 * FAIL-CLOSED (`~/jobs/warranty/ports.ts`'s `resolveWarrantyUploadPort`)
 * until this gate is run and passes.
 *
 * WHAT THIS PROVES THAT NO UNIT TEST CAN. Every unit test in this codebase
 * for the R2 adapter (`r2Client.server.test.ts`, `ports.test.ts`) uses DUMMY
 * credentials against a DUMMY endpoint — presigning is pure local SigV4
 * computation, so those tests prove the adapter CONSTRUCTS requests
 * correctly but prove NOTHING about how the real bucket actually behaves:
 * whether the endpoint/region combination resolves, whether the bucket is
 * actually private, whether a presigned URL this code produces is one R2
 * actually honours. Only a real request against the real bucket proves that.
 *
 * THE SINGLE MOST IMPORTANT ASSERTION IN THIS FILE is CHECK 2 — that the
 * object is NOT readable without a signed URL. A bucket that is accidentally
 * public (Public Development URL left on, or a Custom Domain added —
 * `docs/specs/R2-BUCKET-SETUP.md` §2) would pass every other check in this
 * file and still be a live data breach of customer jewellery photographs.
 * This check exists specifically because "every other test passed" is not
 * evidence of that.
 *
 * SIDE EFFECTS — REAL OBJECTS ARE CREATED. Every object this gate writes is
 * placed under the `warranty/_live-gate/` key prefix (never `warranty/<real
 * claim id>/...`, so it can never collide with or be mistaken for real
 * evidence) and named with a fresh UUID each run. The script DELETES every
 * object it created in a `finally` block, best-effort, and reports success
 * or failure of that cleanup explicitly. If the script is killed before that
 * runs (Ctrl+C, crash), the objects are still there — remove them by hand via
 * Cloudflare dashboard -> R2 -> `caratforus-evidence` -> filter by
 * `warranty/_live-gate/` prefix -> delete. Nothing this gate writes is
 * customer data.
 *
 * RUN:  npx tsx tests/live/slice5.r2EvidenceStorage.ts
 */
import "dotenv/config";

import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";

// `docs/specs/R2-BUCKET-SETUP.md` §4's CORS policy allows exactly this
// origin — used here so CHECK 1 exercises the same origin a real storefront
// upload would present, not an arbitrary one.
const ALLOWED_ORIGIN = "https://caratforus-dev.myshopify.com";

let failures = 0;
function check(condition: unknown, message: string): void {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${message}`);
  if (!condition) failures += 1;
}

async function main() {
  console.log("Slice 5 live gate — Cloudflare R2 evidence storage\n");

  const { resolveR2Config } = await import("~/lib/storage/r2Config.server");
  const { R2ObjectStorageClient, R2_GET_URL_EXPIRY_SECONDS } = await import("~/lib/storage/r2Client.server");

  const resolution = resolveR2Config();
  if (!resolution.configured) {
    console.log(
      `R2 is not configured (${resolution.reason}). This gate cannot run yet — ` +
        "complete docs/specs/R2-BUCKET-SETUP.md and set the four Fly secrets first. " +
        "This is the EXPECTED result today; it is reported as a failure (not skipped) " +
        "so this file cannot be mistaken for a passing gate by anyone who has not " +
        "actually run it against a real bucket."
    );
    process.exitCode = 1;
    return;
  }

  const { config } = resolution;
  const client = new R2ObjectStorageClient(config);
  // A second, raw S3Client for the one operation `R2ObjectStorageClient`
  // deliberately does not expose (delete — the application never deletes
  // evidence; only this gate's own cleanup needs to).
  const rawS3 = new S3Client({
    region: "auto",
    endpoint: config.endpoint,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });

  const createdKeys: string[] = [];

  try {
    // ==========================================================================
    // CHECK 1 — a presigned PUT succeeds from an allowed origin.
    // ==========================================================================
    console.log("1. Presigned PUT from an allowed origin");
    const objectKey = `warranty/_live-gate/${randomUUID()}.txt`;
    createdKeys.push(objectKey);
    const testBody = `carat-live-gate ${new Date().toISOString()}`;

    const putUrl = (await client.createPresignedPutUrl({ key: objectKey, contentType: "text/plain" })).url;
    const putResponse = await fetch(putUrl, {
      method: "PUT",
      headers: { "content-type": "text/plain", origin: ALLOWED_ORIGIN },
      body: testBody,
    });
    check(putResponse.ok, `PUT succeeded (status ${putResponse.status})`);
    const allowOrigin = putResponse.headers.get("access-control-allow-origin");
    console.log(`         access-control-allow-origin on the PUT response: ${allowOrigin}`);
    if (allowOrigin !== null) {
      check(allowOrigin === ALLOWED_ORIGIN, `CORS reflects the allowed origin (got ${allowOrigin})`);
    } else {
      console.log("         NOTE: no CORS header on the actual PUT response — some S3-compatible " + "backends only return one on the OPTIONS preflight, not the real request. Not " + "treated as a failure on its own; the browser-side preflight is what actually " + "gates a real storefront upload and is not reproducible from this Node script.");
    }

    // Rejecting a content type the URL was NOT issued for would be a
    // stronger assertion (proving pinning end-to-end), but doing so here
    // would leave a second uploaded object with mismatched declared/actual
    // type sitting in the bucket. `r2Client.server.test.ts` already proves
    // the content type is bound into SignedHeaders at the signing layer;
    // this check only needs to prove the SDK's presigned URL round-trips
    // against the real bucket at all.

    // ==========================================================================
    // CHECK 2 — THE MOST IMPORTANT ONE. Not readable without a signed URL.
    // ==========================================================================
    console.log("\n2. Object is NOT readable without a signed URL");
    const unsignedUrl = new URL(putUrl);
    unsignedUrl.search = "";
    const unsignedResponse = await fetch(unsignedUrl.toString());
    check(
      unsignedResponse.status !== 200,
      `unsigned GET does NOT return 200 (got ${unsignedResponse.status}) — if this is 200, THE BUCKET IS PUBLIC. ` +
        "Stop immediately and fix docs/specs/R2-BUCKET-SETUP.md §2 (Public Development URL / Custom Domains) " +
        "before this adapter is wired into any customer-facing route."
    );

    // ==========================================================================
    // CHECK 3 — a signed read URL works, and an expired one does not.
    // ==========================================================================
    console.log("\n3. Signed GET works; an expired one does not");
    const getUrl = (await client.createPresignedGetUrl({ key: objectKey })).url;
    const getResponse = await fetch(getUrl);
    check(getResponse.ok, `signed GET succeeded (status ${getResponse.status})`);
    if (getResponse.ok) {
      const returnedBody = await getResponse.text();
      check(returnedBody === testBody, "signed GET returns the exact bytes that were uploaded");
    }
    console.log(`         default GET expiry is ${R2_GET_URL_EXPIRY_SECONDS}s (short-lived, per spec §5)`);

    const shortLivedGetUrl = (await client.createPresignedGetUrl({ key: objectKey, expiresInSeconds: 1 })).url;
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const expiredResponse = await fetch(shortLivedGetUrl);
    check(expiredResponse.status !== 200, `expired signed GET does NOT return 200 (got ${expiredResponse.status})`);

    console.log(
      failures === 0
        ? "\nLIVE GATE PASSED — the bucket is private, presigned PUT/GET round-trip against it, and expiry is enforced."
        : `\n${failures} ASSERTION(S) FAILED — see above. Uploads must stay disabled until every check here passes.`
    );
  } finally {
    console.log(`\nCleanup — deleting ${createdKeys.length} object(s) created by this run under warranty/_live-gate/`);
    for (const key of createdKeys) {
      try {
        await rawS3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
        console.log(`  deleted ${key}`);
      } catch (error) {
        console.error(
          `  FAILED to delete ${key} — remove it by hand via Cloudflare dashboard -> R2 -> ${config.bucket} -> ` +
            `warranty/_live-gate/ prefix. Error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }
}

main()
  .catch((error) => {
    console.error("\n", error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.exitCode = process.exitCode ?? (failures === 0 ? 0 : 1);
  });
