#!/usr/bin/env node
/**
 * FAQ content sync — the three owner-approved changes of 2026-10-26.
 *
 * ============================================================================
 * CREDENTIAL HANDLING
 * ============================================================================
 * Reads the Admin API token from the environment variable
 * `CARATFORUS_CONTENT_ADMIN_TOKEN`. It is never printed, never logged, never
 * written to a file, and never passed as a command-line argument (which would
 * put it in shell history and in the process list).
 *
 * This script belongs to a DEDICATED, NARROWLY SCOPED app —
 * "CaratForUs Claude Content Admin" — holding only `read_metaobjects` and
 * `write_metaobjects`. It must NOT be run with the caratforus-development
 * runtime app's token: that app deliberately does not hold metaobject scopes
 * and must not be widened for one administrative task.
 *
 * ============================================================================
 * SAFETY
 * ============================================================================
 *  - Verifies shop name, canonical domain AND shop GID before any mutation.
 *  - Refuses to run unless the pre-state matches what the owner specified.
 *  - Touches exactly three entries, by question text, and nothing else.
 *  - For the two updates it writes ONLY the `answer` field.
 *  - `--dry-run` (default) prints the plan and writes nothing.
 *    Pass `--commit` to actually mutate.
 *
 * Usage:
 *   node scripts/faq-content-sync.cjs            # dry run
 *   node scripts/faq-content-sync.cjs --commit   # apply
 */

const fs = require("node:fs");
const path = require("node:path");

const SHOP = "nnb1th-cm.myshopify.com";
const EXPECTED_NAME = "CaratForUs";
const EXPECTED_GID = "gid://shopify/Shop/85082865882";
const API = "2026-07";
const TOKEN = process.env.CARATFORUS_CONTENT_ADMIN_TOKEN;
const COMMIT = process.argv.includes("--commit");

const MANIFEST = path.join(__dirname, "..", "..", "docs", "specs", "faq-entries-extracted.json");

/** The three the owner approved. Everything else is out of bounds. */
const CREATE = ["How does paying by bank work?"];
const UPDATE_ANSWER_ONLY = ["Why are there two prices?", "What can I pay with?"];

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
  if (body.errors) throw new Error("GraphQL: " + JSON.stringify(body.errors).slice(0, 400));
  return body.data;
}

/** Rich text fields take a JSON document, not raw HTML or markdown. */
function richText(paragraphs) {
  return JSON.stringify({
    type: "root",
    children: paragraphs.map((p) => ({
      type: "paragraph",
      children: [{ type: "text", value: p }],
    })),
  });
}

function fieldsOf(node) {
  const f = {};
  for (const x of node.fields) f[x.key] = x.value;
  return f;
}

async function readAll() {
  const nodes = [];
  let cursor = null;
  for (;;) {
    const d = await gql(
      `query($cursor: String) {
         metaobjects(type: "faq_entry", first: 100, after: $cursor) {
           nodes { id handle capabilities { publishable { status } } fields { key value } }
           pageInfo { hasNextPage endCursor }
         }
       }`,
      { cursor }
    );
    nodes.push(...d.metaobjects.nodes);
    if (!d.metaobjects.pageInfo.hasNextPage) break;
    cursor = d.metaobjects.pageInfo.endCursor;
  }
  return nodes.map((n) => {
    const f = fieldsOf(n);
    return {
      id: n.id,
      status: n.capabilities && n.capabilities.publishable && n.capabilities.publishable.status,
      question: f.question,
      answer: f.answer,
      category: f.category,
      sort_key: f.sort_key,
    };
  });
}

function countBy(rows, key) {
  return rows.reduce((a, r) => ((a[r[key]] = (a[r[key]] || 0) + 1), a), {});
}

async function main() {
  // ---- Rule 1: prove the shop before anything else. ----
  const shop = (await gql("{ shop { id name myshopifyDomain } }")).shop;
  const identityOk =
    shop.name === EXPECTED_NAME && shop.myshopifyDomain === SHOP && shop.id === EXPECTED_GID;
  console.log("SHOP " + JSON.stringify(shop));
  if (!identityOk) {
    console.error("REFUSING: shop identity does not match the approved production store.");
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const approved = (q) => {
    const m = manifest.find((x) => x.question === q);
    if (!m) throw new Error("manifest missing: " + q);
    return m;
  };

  // ---- Rule 2/3: read, and check the pre-state. ----
  const before = await readAll();
  const qCounts = countBy(before, "question");
  const dupes = Object.entries(qCounts).filter(([, n]) => n > 1);

  console.log(
    "PRE " +
      JSON.stringify(
        {
          total: before.length,
          duplicates: dupes,
          heldQuestionPresent: !!qCounts[CREATE[0]],
          updateTargets: UPDATE_ANSWER_ONLY.map((q) => ({ q, count: qCounts[q] || 0 })),
        },
        null,
        1
      )
  );

  if (dupes.length) { console.error("REFUSING: duplicate questions already present."); process.exit(1); }
  if (qCounts[CREATE[0]]) { console.error("REFUSING: held question already exists; nothing to create."); process.exit(1); }
  for (const q of UPDATE_ANSWER_ONLY) {
    if (qCounts[q] !== 1) { console.error(`REFUSING: "${q}" appears ${qCounts[q] || 0} times, expected exactly 1.`); process.exit(1); }
  }

  if (!COMMIT) {
    console.log("DRY RUN — no mutations sent. Re-run with --commit to apply.");
    return;
  }

  // ---- Create the held entry. ----
  const c = approved(CREATE[0]);
  const created = await gql(
    `mutation($metaobject: MetaobjectCreateInput!) {
       metaobjectCreate(metaobject: $metaobject) {
         metaobject { id }
         userErrors { field message }
       }
     }`,
    {
      metaobject: {
        type: "faq_entry",
        capabilities: { publishable: { status: "ACTIVE" } },
        fields: [
          { key: "question", value: c.question },
          { key: "answer", value: richText(c.answer) },
          { key: "category", value: c.category },
          { key: "sort_key", value: String(c.sort_key) },
        ],
      },
    }
  );
  if (created.metaobjectCreate.userErrors.length) {
    throw new Error("create failed: " + JSON.stringify(created.metaobjectCreate.userErrors));
  }
  console.log("CREATED " + c.question);

  // ---- Update ONLY the answer on the other two. ----
  for (const q of UPDATE_ANSWER_ONLY) {
    const target = before.find((r) => r.question === q);
    const a = approved(q);
    const res = await gql(
      `mutation($id: ID!, $metaobject: MetaobjectUpdateInput!) {
         metaobjectUpdate(id: $id, metaobject: $metaobject) {
           metaobject { id }
           userErrors { field message }
         }
       }`,
      { id: target.id, metaobject: { fields: [{ key: "answer", value: richText(a.answer) }] } }
    );
    if (res.metaobjectUpdate.userErrors.length) {
      throw new Error("update failed for " + q + ": " + JSON.stringify(res.metaobjectUpdate.userErrors));
    }
    console.log("UPDATED(answer only) " + q);
  }

  // ---- Final read-back: every check the owner listed. ----
  const after = await readAll();
  const cats = countBy(after, "category");
  const qc = countBy(after, "question");
  const text = (r) => {
    try { return JSON.parse(r.answer).children.map((p) => p.children.map((t) => t.value).join("")).join("\n"); }
    catch { return r.answer || ""; }
  };
  const changed = [...CREATE, ...UPDATE_ANSWER_ONLY];
  const mismatched = changed.filter((q) => {
    const row = after.find((r) => r.question === q);
    return !row || text(row) !== approved(q).answer.join("\n");
  });

  console.log(
    "POST " +
      JSON.stringify(
        {
          total: after.length,
          duplicates: Object.entries(qc).filter(([, n]) => n > 1),
          blanks: after.filter((r) => !r.question || !r.answer).map((r) => r.question || r.id),
          payments: cats["Payments"],
          pricingAndRefunds: cats["Pricing & Refunds"],
          heldQuestionCount: qc[CREATE[0]] || 0,
          answersMatchingApproved: changed.length - mismatched.length + "/" + changed.length,
          mismatched,
          achLanguageRemaining: after.filter((r) => /\bACH\b/i.test(text(r))).map((r) => r.question),
          bankTransferInRevised: changed.filter((q) => /bank transfer/i.test(text(after.find((r) => r.question === q)))),
          rawMarkdownStored: after.filter((r) => /\*\*|^#{1,6}\s/m.test(text(r))).map((r) => r.question),
          notActive: after.filter((r) => r.status && r.status !== "ACTIVE").map((r) => r.question),
          categories: cats,
        },
        null,
        1
      )
  );
}

main().catch((e) => { console.error("FAILED: " + e.message); process.exit(1); });
