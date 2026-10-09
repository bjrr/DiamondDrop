/**
 * SLICE 9 LIVE GATE — the Design Deposit acceptance route's enforcement, in
 * production.
 *
 * DELIBERATELY NARROW. The acceptance path's happy case cannot be proven from
 * outside without creating a real project owned by a real test customer AND
 * then writing an irreversible, append-only acceptance row against it — a
 * row that by design can never be deleted. The integration suite covers the
 * happy case against real Postgres, including the race and all three
 * append-only guards.
 *
 * What this proves is what only production can prove: that the route is
 * actually deployed, that its gates are the deployed gates rather than the
 * ones in the source tree, and that the policy row the route depends on was
 * really provisioned by the release command. The last one matters most: a
 * missing policy row is exactly the failure that took the Luxury Steals
 * acknowledgment endpoint down on its first real production request, and it
 * is invisible to every test that runs against a migrated database.
 *
 * NO STATE IS CREATED. Every case here is a refusal.
 *
 * RUN: npx tsx tests/live/slice9.depositAcceptanceEnforcement.ts
 */
import "dotenv/config";
import { createHmac, randomUUID } from "node:crypto";

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN!;
const SECRET = process.env.SHOPIFY_API_SECRET!;
const APP_URL = process.env.CARAT_LIVE_GATE_APP_URL ?? "https://caratforus.fly.dev";
const PATH = "/apps/carat/custom-jewelry-deposit-acceptance";

const REQUIRED_ASSERTIONS = [
  "route-deployed",
  "anonymous-refused",
  "unsigned-refused",
  "unknown-project-refused",
  "acceptance-must-be-affirmative",
  "unknown-field-refused",
  "policy-provisioned",
] as const;
type AssertionId = (typeof REQUIRED_ASSERTIONS)[number];

let failures = 0;
const executed = new Set<AssertionId>();

function check(id: AssertionId, condition: unknown, message: string): void {
  if (executed.has(id)) throw new Error(`assertion id "${id}" used twice — ids must be unique or results mask each other`);
  executed.add(id);
  console.log(`  ${condition ? "PASS" : "FAIL"}  [${id}] ${message}`);
  if (!condition) failures += 1;
}

function signedProxyUrl(params: Record<string, string>): string {
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
  return `${APP_URL}${PATH}?${search.toString()}`;
}

async function post(url: string, payload: unknown): Promise<{ status: number; json: Record<string, unknown>; body: string }> {
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

function customerA(): string {
  const raw = process.env.CARAT_LIVE_GATE_CUSTOMER_A?.trim();
  if (!raw) throw new Error("CARAT_LIVE_GATE_CUSTOMER_A is not set — see .env.example.");
  return raw.startsWith("gid://") ? raw.split("/").pop()! : raw;
}

async function main() {
  if (!SHOP || !SECRET) {
    throw new Error("SHOPIFY_SHOP_DOMAIN and SHOPIFY_API_SECRET must be set — this gate signs real App Proxy requests.");
  }
  const authenticated = customerA();

  console.log(`Slice 9 live gate — Design Deposit acceptance enforcement against ${APP_URL}`);
  console.log("EVERY CASE IS A REFUSAL. This gate creates no state.\n");

  // -------------------------------------------------------------------------
  console.log("1. the route exists in the deployed build");
  // A missing resource route returns the SPA shell or a 404, not a JSON
  // refusal — so a structured error is itself the evidence it is deployed.
  // Asserted first because every case below would otherwise "pass" against a
  // route that is not there at all.
  const anonymous = await post(signedProxyUrl({}), { projectId: randomUUID(), depositTermsAccepted: true });
  check(
    "route-deployed",
    anonymous.status !== 404 && typeof anonymous.json.error === "string",
    `a signed POST gets a structured JSON refusal, not a 404 or an HTML shell (HTTP ${anonymous.status}, error=${String(anonymous.json.error)})`
  );

  console.log("\n2. an anonymous caller cannot authorize a charge");
  check(
    "anonymous-refused",
    anonymous.status === 401 && anonymous.json.error === "authentication_required",
    `HTTP ${anonymous.status}, error=${String(anonymous.json.error)} — the enquiry is open to signed-out visitors; authorizing money is not`
  );

  console.log("\n3. an unsigned request is refused before anything else");
  const unsigned = await post(`${APP_URL}${PATH}?shop=${encodeURIComponent(SHOP)}`, {
    projectId: randomUUID(),
    depositTermsAccepted: true,
  });
  check(
    "unsigned-refused",
    unsigned.status === 401,
    `an unsigned POST is refused (HTTP ${unsigned.status}) — reachable only through the storefront`
  );

  // -------------------------------------------------------------------------
  console.log("\n4. an authenticated customer cannot accept against a project that is not theirs");
  // A random uuid is indistinguishable from someone else's project from
  // outside — which IS the property under test. 422 `project_unresolved`
  // proves the route resolved ownership and refused, rather than writing an
  // acceptance against an id it was handed.
  const unknownProject = await post(
    signedProxyUrl({ logged_in_customer_id: authenticated }),
    { projectId: randomUUID(), depositTermsAccepted: true }
  );
  check(
    "unknown-project-refused",
    unknownProject.status === 422 && unknownProject.json.error === "project_unresolved",
    `HTTP ${unknownProject.status}, error=${String(unknownProject.json.error)} — same generic answer as someone else's project, so this cannot enumerate ids`
  );

  // AND, crucially, this is the case that proves the POLICY ROW EXISTS.
  //
  // The route resolves the project BEFORE the policy, so a 422 here means it
  // got past nothing policy-related — it does NOT prove provisioning. What
  // proves it is the absence of the opposite: if the policy row were missing,
  // a request that DID resolve a project would 503. Since we cannot resolve a
  // project without creating state, the policy check is proven directly
  // below instead.
  check(
    "acceptance-must-be-affirmative",
    (
      await post(signedProxyUrl({ logged_in_customer_id: authenticated }), { projectId: randomUUID(), depositTermsAccepted: false })
    ).status === 400,
    "a `false` acceptance flag is refused as a malformed body — acceptance cannot be defaulted or inferred"
  );

  console.log("\n5. the body contract is closed");
  const injected = await post(signedProxyUrl({ logged_in_customer_id: authenticated }), {
    projectId: randomUUID(),
    depositTermsAccepted: true,
    // A client trying to substitute weaker terms. `.strict()` refuses the
    // unknown field outright, so the attempt never reaches the writer.
    exactText: "I agree to nothing in particular.",
  });
  check(
    "unknown-field-refused",
    injected.status === 400,
    `an attempt to supply the acknowledgment text is refused as malformed (HTTP ${injected.status}) — what the customer agreed to is decided server-side`
  );

  // -------------------------------------------------------------------------
  console.log("\n6. the acknowledgment policy row really was provisioned by the release command");
  // /health's readiness check queries the database for every entry in
  // `requiredPolicyVersions.ts`, which now includes
  // `custom-jewelry-design-deposit`. This is the ONLY way to prove
  // provisioning from outside without writing an irreversible acceptance
  // row — and it is the failure that took the Luxury Steals endpoint down on
  // its first real production request, invisible to every test that runs
  // against an already-migrated database.
  const health = await fetch(`${APP_URL}/health`);
  const healthBody = await health.text();
  let healthJson: Record<string, unknown> = {};
  try {
    healthJson = JSON.parse(healthBody) as Record<string, unknown>;
  } catch {
    /* asserted on below */
  }
  //
  // GUARDING THIS GUARD. The assertion below passes by NOT finding a string,
  // which is the shape that silently stops working: if the policy section
  // ever disappeared from the payload, or the migration list stopped being
  // reported, "our slug is not mentioned" would read as healthy forever.
  //
  // It also cannot rely on the HTTP status — a missing required policy is
  // deliberately degraded/200, not 503 (see `health.test.ts`), so `health.ok`
  // is true either way.
  //
  // So the section is proven PRESENT first, by two independent markers: the
  // policy-health report itself, and the applied migration that provisions
  // this policy. Only then does the absence of the slug mean anything.
  const payload = JSON.stringify(healthJson);
  const reportsPolicyHealth = payload.includes("requiredPolicyVersions") || payload.includes("policy");
  const provisioningMigrationApplied = payload.includes("20261008020000_custom_jewelry_deposit_policy_version");
  const reportedMissing = payload.includes("custom-jewelry-design-deposit");

  check(
    "policy-provisioned",
    health.ok && reportsPolicyHealth && provisioningMigrationApplied && !reportedMissing,
    !health.ok
      ? `/health returned HTTP ${health.status}: ${healthBody.slice(0, 200)}`
      : !reportsPolicyHealth
        ? `/health no longer reports policy health at all — this assertion cannot mean anything until that is restored`
        : !provisioningMigrationApplied
          ? `/health does not list migration 20261008020000 as applied — the policy row was never provisioned in production`
          : reportedMissing
            ? `/health reports custom-jewelry-design-deposit as MISSING — the deposit step will 503 on the first real acceptance`
            : `/health reports the provisioning migration applied and no missing required policy versions (HTTP ${health.status})`
  );
}

main()
  .catch((error) => {
    console.error("\n", error);
    failures += 1;
  })
  .finally(() => {
    const missing = REQUIRED_ASSERTIONS.filter((id) => !executed.has(id));
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
        : `\n${failures} FAILURE(S) — the deposit acceptance route's enforcement is NOT proven in production.`
    );
    process.exitCode = green ? 0 : 1;
  });
