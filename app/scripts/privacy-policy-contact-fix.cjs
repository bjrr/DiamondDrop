#!/usr/bin/env node
/**
 * THE ONE AUTHORIZED PRIVACY-POLICY EDIT — owner approval 2026-10-26.
 *
 * ============================================================================
 * WHAT THIS IS ALLOWED TO CHANGE, AND NOTHING ELSE
 * ============================================================================
 * The live Privacy Policy contains a broken contact sentence:
 *
 *     "please call  or email us at orders@caratforus.com"
 *                 ^^ a telephone number that does not exist
 *
 * Authorized change: REMOVE the telephone/call language, leave the valid
 * channels (the Contact Us form and/or orders@caratforus.com) intact.
 *
 * EXPLICITLY NOT AUTHORIZED:
 *   - inventing a phone number (there is none; do not add one)
 *   - any other substantive privacy-policy edit
 *   - publishing the revised policy draft (that is still under legal review)
 *
 * The full revised policy lives in docs/content/PRIVACY-POLICY-DRAFT.md and
 * stays UNPUBLISHED. This script is a surgical correction to the live text,
 * not a replacement of it.
 *
 * ============================================================================
 * WHY THE EDIT IS COMPUTED, NOT RETYPED
 * ============================================================================
 * The script never holds a copy of the intended policy body. It reads the
 * live body, applies one regex to one sentence, and diffs the result. If the
 * change touches more than the contact sentence, it refuses. That makes it
 * impossible for this script to silently rewrite a legal document — the worst
 * case is that it declines to run.
 *
 * ============================================================================
 * CREDENTIALS AND SCOPE
 * ============================================================================
 * Reads CARATFORUS_CONTENT_ADMIN_TOKEN from the environment. Never printed,
 * never logged, never passed as an argument.
 *
 * Belongs to the DEDICATED "CaratForUs Claude Content Admin" app, which needs
 * `write_legal_policies` TEMPORARILY added for this one run. The production
 * runtime app (caratforus-development) must NOT be widened — it holds no
 * policy scope and that is deliberate.
 *
 * REVOKE `write_legal_policies` AGAIN once this has run.
 *
 * Usage:
 *   node scripts/privacy-policy-contact-fix.cjs            # dry run, default
 *   node scripts/privacy-policy-contact-fix.cjs --commit   # apply
 */

const SHOP = "nnb1th-cm.myshopify.com";
const EXPECTED_NAME = "CaratForUs";
const EXPECTED_GID = "gid://shopify/Shop/85082865882";
const API = "2026-07";
const TOKEN = process.env.CARATFORUS_CONTENT_ADMIN_TOKEN;
const COMMIT = process.argv.includes("--commit");

if (!TOKEN) {
  console.error(
    "CARATFORUS_CONTENT_ADMIN_TOKEN is not set.\n" +
      "Set it in the environment (not inline on the command line) and re-run."
  );
  process.exit(2);
}

async function gql(query, variables) {
  const res = await fetch(`https://${SHOP}/admin/api/${API}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error("GraphQL: " + JSON.stringify(body.errors).slice(0, 500));
  return body.data;
}

/**
 * The broken phrase, tolerant of how the gap actually renders. The owner
 * reported "please call  or email us at" — a collapsed empty placeholder.
 * Matching the whole "call ... or" span lets us delete exactly the telephone
 * clause and keep the email clause that follows.
 */
const BROKEN = /please\s+call\s*(?:&nbsp;|\s)*\s*or\s+email\s+us\s+at/i;
const REPLACEMENT = "please email us at";

/** Anything that still looks like a phone number after the edit is a failure. */
const PHONE_SHAPED = /(\+?\d[\d\s().-]{6,}\d)|\btel:|\bcall us\b|\bphone\b/i;

function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

/** Shows the edit in context so a human can eyeball it before --commit. */
function context(body, index, span) {
  const from = Math.max(0, index - 160);
  const to = Math.min(body.length, index + span + 160);
  return (from ? "…" : "") + body.slice(from, to) + (to < body.length ? "…" : "");
}

async function main() {
  // ---- 1. Prove the shop before reading, let alone writing. ----
  const shop = (await gql("{ shop { id name myshopifyDomain } }")).shop;
  console.log("SHOP " + JSON.stringify(shop));
  if (shop.name !== EXPECTED_NAME || shop.myshopifyDomain !== SHOP || shop.id !== EXPECTED_GID) {
    console.error("REFUSING: shop identity does not match the approved production store.");
    process.exit(1);
  }

  // ---- 2. Read the current PRIVACY_POLICY. ----
  const policies = (await gql("{ shopPolicies { id type title url body } }")).shopPolicies || [];
  const privacy = policies.find((p) => p.type === "PRIVACY_POLICY");
  if (!privacy) {
    console.error("REFUSING: no PRIVACY_POLICY returned. Policies present: " +
      policies.map((p) => p.type).join(", "));
    process.exit(1);
  }
  const before = privacy.body || "";
  console.log(`PRIVACY_POLICY id=${privacy.id} url=${privacy.url} length=${before.length}`);

  // ---- 3. Confirm the exact broken phrase exists. ----
  const match = before.match(BROKEN);
  if (!match) {
    console.error(
      "REFUSING: the broken phrase was not found, so there is nothing authorized to change.\n" +
        "The live text may already have been corrected, or it differs from what was reported.\n" +
        "Occurrences of 'call' in the live body: " +
        (before.match(/[^.]*\bcall\b[^.]*\./gi) || ["(none)"]).join(" | ").slice(0, 600)
    );
    process.exit(1);
  }
  console.log("\nFOUND the broken phrase:\n  " + JSON.stringify(match[0]));
  console.log("\nBEFORE (in context):\n" + context(before, match.index, match[0].length));

  // ---- 4. Apply ONLY that change, then prove nothing else moved. ----
  const after = before.replace(BROKEN, REPLACEMENT);

  const occurrences = (before.match(new RegExp(BROKEN.source, "gi")) || []).length;
  if (occurrences !== 1) {
    console.error(`REFUSING: expected exactly 1 occurrence, found ${occurrences}.`);
    process.exit(1);
  }

  const delta = before.length - after.length;
  const expectedDelta = match[0].length - REPLACEMENT.length;
  if (delta !== expectedDelta) {
    console.error(`REFUSING: length changed by ${delta}, expected ${expectedDelta}.`);
    process.exit(1);
  }

  // The untouched remainder must be byte-identical on both sides of the edit.
  const i = firstDifference(before, after);
  const headSame = before.slice(0, i) === after.slice(0, i);
  const tailSame = before.slice(i + match[0].length) === after.slice(i + REPLACEMENT.length);
  if (!headSame || !tailSame) {
    console.error("REFUSING: text outside the contact sentence would change.");
    process.exit(1);
  }

  if (PHONE_SHAPED.test(after) && !PHONE_SHAPED.test(before)) {
    console.error("REFUSING: the edit would introduce phone-shaped text.");
    process.exit(1);
  }
  if (!after.includes("orders@caratforus.com")) {
    console.error("REFUSING: orders@caratforus.com would be lost.");
    process.exit(1);
  }

  console.log("\nAFTER (in context):\n" + context(after, i, REPLACEMENT.length));
  console.log(
    "\nPLAN " +
      JSON.stringify(
        { charsRemoved: delta, everythingElseByteIdentical: true, emailPreserved: true }, null, 1
      )
  );

  if (!COMMIT) {
    console.log("\nDRY RUN — nothing written. Re-run with --commit to apply.");
    return;
  }

  // ---- 5. Write. ----
  const res = await gql(
    `mutation($shopPolicy: ShopPolicyInput!) {
       shopPolicyUpdate(shopPolicy: $shopPolicy) {
         shopPolicy { id type url }
         userErrors { field message }
       }
     }`,
    { shopPolicy: { id: privacy.id, body: after } }
  );
  const errs = res.shopPolicyUpdate.userErrors;
  if (errs.length) throw new Error("update failed: " + JSON.stringify(errs));
  console.log("\nWROTE " + JSON.stringify(res.shopPolicyUpdate.shopPolicy));

  // ---- 6. Read back and verify every check the owner listed. ----
  const readback = ((await gql("{ shopPolicies { type body url } }")).shopPolicies || [])
    .find((p) => p.type === "PRIVACY_POLICY");
  const live = (readback && readback.body) || "";

  const verdict = {
    brokenPhraseGone: !BROKEN.test(live),
    noPleaseCallOr: !/please\s+call\s*(?:&nbsp;|\s)*\s*or/i.test(live),
    noPhoneNumberIntroduced: !PHONE_SHAPED.test(live),
    emailStillCorrect: live.includes("orders@caratforus.com"),
    bodyMatchesIntended: live === after,
    publicUrl: readback && readback.url,
  };
  console.log("\nVERIFY " + JSON.stringify(verdict, null, 1));

  const failed = Object.entries(verdict).filter(([k, v]) => k !== "publicUrl" && v !== true);
  if (failed.length) {
    console.error("POST-WRITE VERIFICATION FAILED: " + failed.map(([k]) => k).join(", "));
    process.exit(1);
  }
  console.log(
    "\nOK — the one authorized correction is live.\n" +
      "NOW REVOKE `write_legal_policies` from the content-admin app."
  );
}

main().catch((e) => { console.error("FAILED: " + e.message); process.exit(1); });
