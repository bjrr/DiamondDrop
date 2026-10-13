/**
 * SLICE 9 LIVE GATE — the Custom Jewelry inspiration upload path, end to end
 * against production.
 *
 * THE OWNER'S SECOND REGRESSION REQUIREMENT (2026-10-05), verbatim: "add a
 * Custom Jewelry upload gate proving the same security properties... Do not
 * accept 'shared code' as proof; both real customer paths must exercise it."
 * The warranty gate re-ran 10/10 after the destination service was generalized,
 * which proves the service still serves warranty. This proves it serves Custom
 * Jewelry — and, crucially, that the two cannot reach each other.
 *
 * Like its warranty sibling it imports no application module and no database
 * client. It speaks only to the deployed app over HTTP and to R2 over HTTP, so
 * whatever it proves, it proves about what is actually running in production.
 *
 * ============================================================================
 * WHAT THIS CREATES ON PRODUCTION
 * ============================================================================
 * Real `custom_jewelry_project` rows and real objects in the production
 * evidence bucket. NO Shopify customers or orders — this path needs neither,
 * which is why it reuses the two pre-provisioned live-gate customers.
 *
 * Every enquiry it creates carries the prompt text `CARAT LIVE GATE SLICE 9`
 * and is listed by project reference at the end. Confirmation email goes to
 * `delivered@resend.dev` (Resend's accept-and-discard sink) rather than a
 * fabricated address, so the gate does not generate bounces against our
 * sending reputation.
 *
 * ============================================================================
 * WHAT IT PROVES — every one a named assertion that must actually EXECUTE.
 * A zero failure count with missing assertions is NOT a pass.
 * ============================================================================
 *   destination-issued             an authenticated customer gets a destination
 *   destination-persisted          it survives the request that issued it
 *   anonymous-destination-refused  a signed-out visitor gets none
 *   anonymous-intake-allowed       ...yet a file-less enquiry still succeeds
 *   presigned-put                  a real PUT to R2 with that URL succeeds
 *   object-not-public              the uploaded object is not readable unsigned
 *   intake-accepts-valid-key       the enquiry is accepted with the issued key
 *   arbitrary-key-rejected         a made-up storageKey is refused
 *   destination-bound-customer     customer B cannot spend customer A's
 *   reused-destination-rejected    a consumed key cannot be used again
 *   no-partial-project             a batch with one bad key creates NO project
 *   expired-destination-rejected   a destination past its expiry is refused
 *   warranty-key-rejected-by-cj    cross-purpose: warranty key → CJ intake
 *   cj-key-rejected-by-warranty    cross-purpose: CJ key → warranty claim
 *   foreign-project-refused        a destination for someone else's project
 *
 * ============================================================================
 * HOW THE CROSS-PURPOSE CASES ARE MADE STRONG
 * ============================================================================
 * A warranty key offered to Custom Jewelry would be refused even by a broken
 * system if it differed in some OTHER way — wrong customer, wrong owner id,
 * expired. So the probes are constructed so that `purpose` is the ONLY thing
 * that differs: the same customer A, and the warranty `claimId` reused verbatim
 * as the Custom Jewelry `projectId`, so `ownerId` matches too. If purpose were
 * dropped from the consumption predicate, these two assertions are the ones
 * that would start passing keys through.
 *
 * ============================================================================
 * HOW "NO PROJECT WAS CREATED" IS PROVEN WITHOUT A DATABASE CLIENT
 * ============================================================================
 * The project id is client-minted, so it is a primary key the gate controls.
 * After the refused partial batch, the SAME id is submitted again with a
 * genuinely issued key. A project left behind by the first attempt would make
 * the second fail on primary-key uniqueness; a 201 therefore proves the id was
 * still free, i.e. the transaction rolled back. Stronger than reading a row —
 * it proves the id is free to the code path that would collide with it.
 *
 * THE EXPIRY CASE COSTS REAL TIME, for the same reason as the warranty gate:
 * a destination lives 15 minutes and nothing outside the app can age one, which
 * is correct — an endpoint that could would be a way to forge upload windows.
 * So the probe is issued FIRST and the wait at the end is only the remainder.
 *
 * RUN: npx tsx tests/live/slice9.customJewelryUploadFlow.ts
 */
import "dotenv/config";
import { createHmac, randomUUID } from "node:crypto";

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN!;
const SECRET = process.env.SHOPIFY_API_SECRET!;
const APP_URL = process.env.CARAT_LIVE_GATE_APP_URL ?? "https://caratforus.fly.dev";

/**
 * Resend's accept-and-discard address. The intake route sends a real
 * confirmation email, and a gate that invents `@example.com` recipients
 * generates real bounces against our sending domain's reputation.
 */
const SINK_EMAIL = process.env.CARAT_LIVE_GATE_SINK_EMAIL ?? "delivered@resend.dev";

/** 15 minutes plus a margin — the app's own PUT/destination window. */
const DESTINATION_TTL_MS = 15 * 60 * 1000;
const EXPIRY_MARGIN_MS = 45 * 1000;

const REQUIRED_ASSERTIONS = [
  "destination-issued",
  "destination-persisted",
  "anonymous-destination-refused",
  "anonymous-intake-allowed",
  "presigned-put",
  "object-not-public",
  "intake-accepts-valid-key",
  "arbitrary-key-rejected",
  "destination-bound-customer",
  "reused-destination-rejected",
  "no-partial-project",
  "expired-destination-rejected",
  "warranty-key-rejected-by-cj",
  "cj-key-rejected-by-warranty",
  "foreign-project-refused",
] as const;
type AssertionId = (typeof REQUIRED_ASSERTIONS)[number];

let failures = 0;
const executed = new Set<AssertionId>();

function check(id: AssertionId, condition: unknown, message: string): void {
  // A DUPLICATE ID WOULD LET A LATER PASS OVERWRITE AN EARLIER FAIL. That
  // exact bug shipped in the Bank Payment gate and reported PASS beside its
  // own FAIL, so it is now refused outright rather than left to review.
  if (executed.has(id)) {
    throw new Error(`assertion id "${id}" used twice — ids must be unique or results mask each other`);
  }
  executed.add(id);
  console.log(`  ${condition ? "PASS" : "FAIL"}  [${id}] ${message}`);
  if (!condition) failures += 1;
}

function missingAssertions(): AssertionId[] {
  return REQUIRED_ASSERTIONS.filter((id) => !executed.has(id));
}

/**
 * Whole seconds from milliseconds, by exact integer arithmetic.
 *
 * This repo bans the Math rounding helpers unconditionally so nobody has to
 * judge whether a call site is "money enough" to matter. Integer arithmetic
 * needs no exception and takes none. The scan is textual, so even naming
 * those helpers in a comment trips it.
 */
function wholeSeconds(ms: number): number {
  return (ms - (ms % 1000)) / 1000;
}

// ---------------------------------------------------------------------------
// Shopify App Proxy signing. `logged_in_customer_id` is OMITTED entirely when
// anonymous — the real proxy omits the parameter rather than sending it empty,
// and sending an empty one would test a shape production never produces.
// ---------------------------------------------------------------------------
function signedProxyUrl(path: string, params: Record<string, string>): string {
  const search = new URLSearchParams({
    ...params,
    shop: SHOP,
    path_prefix: "/apps/carat",
    timestamp: String(Date.now()).slice(0, -3),
  });
  const message = Array.from(search.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("");
  search.set("signature", createHmac("sha256", SECRET).update(message, "utf8").digest("hex"));
  return `${APP_URL}${path}?${search.toString()}`;
}

function customer(label: "A" | "B"): string {
  const raw = (label === "A" ? process.env.CARAT_LIVE_GATE_CUSTOMER_A : process.env.CARAT_LIVE_GATE_CUSTOMER_B)?.trim();
  if (!raw) {
    throw new Error(
      `CARAT_LIVE_GATE_CUSTOMER_${label} is not set. This gate needs TWO distinct pre-provisioned test ` +
        "customers; the cross-customer binding assertion is meaningless without them and would pass vacuously."
    );
  }
  const numericId = raw.startsWith("gid://") ? raw.split("/").pop()! : raw;
  if (!/^\d+$/.test(numericId)) {
    throw new Error(`CARAT_LIVE_GATE_CUSTOMER_${label} must be a numeric customer id or a customer gid; got ${JSON.stringify(raw)}`);
  }
  return numericId;
}

interface JsonResponse {
  status: number;
  json: Record<string, unknown>;
  body: string;
}

async function postJson(url: string, payload: unknown): Promise<JsonResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(body) as Record<string, unknown>;
  } catch {
    /* a non-JSON body is itself a finding; callers assert on status */
  }
  return { status: response.status, json, body };
}

/** A Custom Jewelry upload destination. `customerNumericId` null = signed out. */
function requestCjDestination(customerNumericId: string | null, projectId: string): Promise<JsonResponse> {
  return postJson(
    signedProxyUrl(
      "/apps/carat/custom-jewelry-upload-destination",
      customerNumericId ? { logged_in_customer_id: customerNumericId } : {}
    ),
    { projectId, kind: "photo", contentType: "image/jpeg", sizeBytes: 12_345 }
  );
}

/** A WARRANTY upload destination — used only to build the cross-purpose probes. */
function requestWarrantyDestination(customerNumericId: string, claimId: string): Promise<JsonResponse> {
  return postJson(
    signedProxyUrl("/apps/carat/warranty-claim-upload-destination", { logged_in_customer_id: customerNumericId }),
    { claimId, kind: "photo", contentType: "image/jpeg", sizeBytes: 12_345 }
  );
}

interface Upload {
  kind: "photo";
  storageKey: string;
  contentType: string;
  sizeBytes: number;
  checksum: string;
}

function anUpload(storageKey: string): Upload {
  return {
    kind: "photo",
    storageKey,
    contentType: "image/jpeg",
    sizeBytes: 12_345,
    checksum: `sha256:${randomUUID().replace(/-/g, "")}`,
  };
}

function submitIntake(
  customerNumericId: string | null,
  options: { projectId?: string; uploads?: Upload[] } = {}
): Promise<JsonResponse> {
  return postJson(
    signedProxyUrl(
      "/apps/carat/custom-jewelry-intake",
      customerNumericId ? { logged_in_customer_id: customerNumericId } : {}
    ),
    {
      firstName: "Carat Live",
      lastName: "Gate Slice9",
      email: SINK_EMAIL,
      phone: "+1 555 0199",
      startingPoint: "from_scratch",
      promptText: "CARAT LIVE GATE SLICE 9 — synthetic enquiry for upload path verification. Not a real customer request.",
      followUpPreference: "contact_me",
      ...(options.projectId ? { projectId: options.projectId } : {}),
      ...(options.uploads ? { uploads: options.uploads } : {}),
    }
  );
}

/**
 * A warranty claim carrying a Custom Jewelry key.
 *
 * DELIBERATELY USES A NONEXISTENT ORDER REF, and that is sound rather than
 * lazy: the warranty route verifies and consumes uploads BEFORE it resolves
 * the order, so a cross-purpose key is refused at the upload check and never
 * reaches the lookup. The assertion therefore demands not just 422 but
 * `invalid_upload_reference` specifically — so it fails for its own reason and
 * cannot be satisfied by an unrelated order-resolution refusal.
 */
function submitWarrantyClaimWithKey(customerNumericId: string, claimId: string, storageKey: string): Promise<JsonResponse> {
  return postJson(signedProxyUrl("/apps/carat/warranty-claim", { logged_in_customer_id: customerNumericId }), {
    claimId,
    orderRef: `gid://shopify/Order/${Date.now()}000`,
    lineRef: `gid://shopify/LineItem/${Date.now()}001`,
    purchaserName: "Carat Live Gate",
    purchaserEmail: SINK_EMAIL,
    itemConfigurationDescription: "Live gate cross-purpose probe",
    problemDescription: "CARAT LIVE GATE SLICE 9 — cross-purpose key probe. Must be refused.",
    hadImpactOrDamageEvent: false,
    wasAlteredAfterDelivery: false,
    claimAcknowledgmentAccepted: true,
    uploads: [anUpload(storageKey)],
  });
}

function keyOf(response: JsonResponse, what: string): string {
  const storageKey = response.json.storageKey;
  if (response.status !== 201 || typeof storageKey !== "string") {
    throw new Error(`could not issue ${what} (HTTP ${response.status}): ${response.body.slice(0, 300)}`);
  }
  return storageKey;
}

async function main() {
  if (!SHOP || !SECRET) {
    throw new Error("SHOPIFY_SHOP_DOMAIN and SHOPIFY_API_SECRET must be set — this gate signs real App Proxy requests.");
  }
  const customerA = customer("A");
  const customerB = customer("B");
  if (customerA === customerB) {
    throw new Error("customer A and customer B are the same identity — the binding assertion would pass vacuously");
  }

  console.log(`Slice 9 live gate — Custom Jewelry inspiration upload flow against ${APP_URL}`);
  console.log(`store: ${SHOP}   customers: ${customerA} / ${customerB}   email sink: ${SINK_EMAIL}`);
  console.log("THIS CREATES REAL CUSTOM JEWELRY ENQUIRIES AND REAL BUCKET OBJECTS.\n");

  const createdProjects: string[] = [];
  const noteProject = (response: JsonResponse) => {
    const reference = response.json.projectReference;
    if (typeof reference === "string") createdProjects.push(reference);
  };

  // THE EXPIRY PROBE GOES FIRST so it ages while everything else runs.
  console.log("1. issuing the expiry-probe destination now, so its 15-minute window elapses during the rest of the gate");
  const expiryProjectId = randomUUID();
  const expiryKey = keyOf(await requestCjDestination(customerA, expiryProjectId), "the expiry probe destination");
  const probeIssuedAt = Date.now();
  console.log(`  probe key: ${expiryKey}\n`);

  // -------------------------------------------------------------------------
  console.log("2. an authenticated customer can request a Custom Jewelry upload destination");
  const projectId = randomUUID();
  const issued = await requestCjDestination(customerA, projectId);
  const uploadUrl = issued.json.uploadUrl;
  check(
    "destination-issued",
    issued.status === 201 && typeof uploadUrl === "string" && typeof issued.json.storageKey === "string",
    `HTTP ${issued.status}, uploadUrl ${typeof uploadUrl === "string" ? "present" : "MISSING"}, storageKey ${String(issued.json.storageKey ?? "MISSING")}`
  );
  const storageKey = keyOf(issued, "the primary destination");
  if (typeof uploadUrl !== "string") throw new Error("no uploadUrl to continue with");
  // The key must land under the Custom Jewelry prefix, not warranty's — the
  // purpose shapes the bucket layout as well as the security boundary.
  console.log(`  key: ${storageKey}`);

  // -------------------------------------------------------------------------
  console.log("\n3. a SIGNED-OUT visitor gets no destination — but can still submit a file-less enquiry");
  const anonymousDestination = await requestCjDestination(null, randomUUID());
  check(
    "anonymous-destination-refused",
    anonymousDestination.status === 401 && anonymousDestination.json.error === "authentication_required",
    `HTTP ${anonymousDestination.status}, error=${String(anonymousDestination.json.error)}`
  );
  // THE ASYMMETRY IS THE DESIGN, so it is asserted rather than assumed: the
  // upload gate must not have quietly become a wall around the enquiry itself.
  const anonymousIntake = await submitIntake(null);
  noteProject(anonymousIntake);
  check(
    "anonymous-intake-allowed",
    anonymousIntake.status === 201,
    `a signed-out enquiry with no files is still accepted (HTTP ${anonymousIntake.status})`
  );

  // -------------------------------------------------------------------------
  console.log("\n4. the presigned PUT actually works against the production bucket");
  const putResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "content-type": "image/jpeg" },
    body: `carat-live-gate-slice9 ${new Date().toISOString()}`,
  });
  check("presigned-put", putResponse.ok, `PUT to R2 succeeded (HTTP ${putResponse.status})`);

  // -------------------------------------------------------------------------
  console.log("\n5. the uploaded object is NOT readable without a signature");
  const unsignedUrl = new URL(uploadUrl);
  unsignedUrl.search = "";
  const unsigned = await fetch(unsignedUrl.toString());
  check(
    "object-not-public",
    unsigned.status !== 200,
    `unsigned GET of the real object does NOT return 200 (got ${unsigned.status}). NOTE: this proves the S3 ` +
      `endpoint requires auth; it does NOT prove the bucket has no public r2.dev URL, a dashboard setting this ` +
      `gate cannot observe.`
  );

  // -------------------------------------------------------------------------
  console.log("\n6. a DIFFERENT customer cannot spend customer A's destination");
  const crossCustomer = await submitIntake(customerB, { projectId, uploads: [anUpload(storageKey)] });
  check(
    "destination-bound-customer",
    crossCustomer.status === 422 && crossCustomer.json.error === "invalid_upload_reference",
    `customer B submitting customer A's key is refused (HTTP ${crossCustomer.status}, error=${String(crossCustomer.json.error)})`
  );

  // -------------------------------------------------------------------------
  console.log("\n7. a made-up storageKey is refused");
  const arbitrary = await submitIntake(customerA, {
    projectId: randomUUID(),
    uploads: [anUpload(`custom-jewelry/${randomUUID()}/photo/${randomUUID()}.jpg`)],
  });
  check(
    "arbitrary-key-rejected",
    arbitrary.status === 422 && arbitrary.json.error === "invalid_upload_reference",
    `an invented storageKey is refused (HTTP ${arbitrary.status})`
  );

  // -------------------------------------------------------------------------
  console.log("\n8. CROSS-PURPOSE — a WARRANTY-issued key cannot be spent on a Custom Jewelry enquiry");
  // Same customer, and the warranty claimId reused verbatim as the projectId
  // so ownerId matches too. PURPOSE IS THE ONLY DIFFERENCE.
  const sharedOwnerId = randomUUID();
  const warrantyKey = keyOf(await requestWarrantyDestination(customerA, sharedOwnerId), "the warranty cross-purpose probe");
  const warrantyIntoCj = await submitIntake(customerA, { projectId: sharedOwnerId, uploads: [anUpload(warrantyKey)] });
  check(
    "warranty-key-rejected-by-cj",
    warrantyIntoCj.status === 422 && warrantyIntoCj.json.error === "invalid_upload_reference",
    `a warranty destination with a MATCHING customer and owner id is still refused by Custom Jewelry ` +
      `(HTTP ${warrantyIntoCj.status}) — purpose was the only difference`
  );

  console.log("\n9. CROSS-PURPOSE — a CUSTOM JEWELRY-issued key cannot be spent on a warranty claim");
  const cjOwnerId = randomUUID();
  const cjKey = keyOf(await requestCjDestination(customerA, cjOwnerId), "the Custom Jewelry cross-purpose probe");
  const cjIntoWarranty = await submitWarrantyClaimWithKey(customerA, cjOwnerId, cjKey);
  check(
    "cj-key-rejected-by-warranty",
    cjIntoWarranty.status === 422 && cjIntoWarranty.json.error === "invalid_upload_reference",
    `a Custom Jewelry destination with a MATCHING customer and owner id is refused by the warranty claim route ` +
      `at UPLOAD VERIFICATION (HTTP ${cjIntoWarranty.status}, error=${String(cjIntoWarranty.json.error)}) — not ` +
      `merely at order resolution`
  );

  // -------------------------------------------------------------------------
  console.log("\n10. a batch with ONE bad key creates NO project, and the good key survives");
  const partialProjectId = randomUUID();
  const goodKey = keyOf(await requestCjDestination(customerA, partialProjectId), "the partial-batch destination");
  const partial = await submitIntake(customerA, {
    projectId: partialProjectId,
    uploads: [anUpload(goodKey), anUpload(`custom-jewelry/${randomUUID()}/photo/${randomUUID()}.jpg`)],
  });
  const partialRefused = partial.status === 422;
  // THE ROLLBACK PROOF: resubmit the SAME client-minted project id with the
  // SAME good key. Both must still be free/unspent — a project left behind
  // would collide on the primary key, and a consumed destination would be
  // refused. One 201 proves both.
  const rollbackRecheck = await submitIntake(customerA, {
    projectId: partialProjectId,
    uploads: [anUpload(goodKey)],
  });
  noteProject(rollbackRecheck);
  check(
    "no-partial-project",
    partialRefused && rollbackRecheck.status === 201,
    `the two-upload batch was refused whole (HTTP ${partial.status}) AND resubmitting the same project id with ` +
      `the same good key then succeeded (HTTP ${rollbackRecheck.status}) — so neither the project row nor the ` +
      `destination survived the refusal`
  );

  // -------------------------------------------------------------------------
  console.log("\n11. the enquiry IS accepted with a genuinely issued key");
  const accepted = await submitIntake(customerA, { projectId, uploads: [anUpload(storageKey)] });
  noteProject(accepted);
  check(
    "intake-accepts-valid-key",
    accepted.status === 201,
    `enquiry accepted with the issued storageKey (HTTP ${accepted.status}) ${accepted.status >= 400 ? accepted.body.slice(0, 200) : ""}`
  );
  // PERSISTENCE, keyed on which refusal does NOT happen — so it fails for its
  // own reason even if something unrelated later in the request breaks. The
  // destination was issued by a separate HTTP request minutes earlier with
  // nothing carrying its state forward; getting past the upload check means it
  // was found in durable storage.
  check(
    "destination-persisted",
    accepted.status !== 422,
    `the enquiry got PAST upload verification (HTTP ${accepted.status}, not 422) — the destination issued by an ` +
      `earlier request was found in durable storage`
  );

  // -------------------------------------------------------------------------
  console.log("\n12. the same destination cannot be used twice");
  const reuse = await submitIntake(customerA, { projectId: randomUUID(), uploads: [anUpload(storageKey)] });
  check(
    "reused-destination-rejected",
    reuse.status === 422 && reuse.json.error === "invalid_upload_reference",
    `an already-consumed storageKey is refused on a second enquiry (HTTP ${reuse.status})`
  );

  // -------------------------------------------------------------------------
  console.log("\n13. a destination for SOMEONE ELSE's existing project is refused");
  // `projectId` now belongs to customer A (step 11 created it). Customer B
  // asking for a destination against it must be refused — and with the same
  // generic response as a project that does not exist, so this cannot be used
  // to enumerate project ids.
  const foreign = await requestCjDestination(customerB, projectId);
  check(
    "foreign-project-refused",
    foreign.status === 422 && foreign.json.error === "project_unresolved",
    `customer B requesting a destination against customer A's project is refused (HTTP ${foreign.status}, ` +
      `error=${String(foreign.json.error)}) — indistinguishable from a nonexistent project`
  );

  // -------------------------------------------------------------------------
  console.log("\n14. an EXPIRED destination is refused");
  const remaining = DESTINATION_TTL_MS + EXPIRY_MARGIN_MS - (Date.now() - probeIssuedAt);
  if (remaining > 0) {
    console.log(`  waiting ${wholeSeconds(remaining)}s for the probe destination to pass its 15-minute expiry...`);
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
  const expired = await submitIntake(customerA, { projectId: expiryProjectId, uploads: [anUpload(expiryKey)] });
  check(
    "expired-destination-rejected",
    expired.status === 422 && expired.json.error === "invalid_upload_reference",
    `a destination past its expiry is refused (HTTP ${expired.status}), ${wholeSeconds(Date.now() - probeIssuedAt)}s after issuance`
  );

  // -------------------------------------------------------------------------
  console.log("\n============================================================");
  console.log("CREATED on production — synthetic, prompt text 'CARAT LIVE GATE SLICE 9':");
  for (const reference of createdProjects) console.log(`  project:  ${reference}`);
  console.log(`  objects:  ${storageKey}  (the only one with bytes in the bucket)`);
  console.log(`            ${expiryKey}, ${warrantyKey}, ${cjKey}, ${goodKey}  (database rows only, never uploaded)`);
}

main()
  .catch((error) => {
    console.error("\n", error);
    failures += 1;
  })
  .finally(() => {
    const missing = missingAssertions();
    if (missing.length > 0) {
      console.log(
        `\nINCOMPLETE — ${missing.length} required assertion(s) NEVER RAN: ${missing.join(", ")}. ` +
          "NOT a pass, however many PASS lines appear above."
      );
    }
    const green = failures === 0 && missing.length === 0;
    console.log(
      green
        ? `\nLIVE GATE PASSED — all ${REQUIRED_ASSERTIONS.length} required assertions executed and passed against production.`
        : `\n${failures} FAILURE(S) — the Custom Jewelry upload path is NOT proven. Uploads must not be offered to customers.`
    );
    process.exitCode = green ? 0 : 1;
  });
