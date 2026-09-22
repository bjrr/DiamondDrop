const fs=require("fs");const p="app/domain/bankpayment/guaranteeCancellationEmail.ts";
let s=fs.readFileSync(p,"utf8");let n=0;
const sub=(o,x)=>{if(!s.includes(o))throw new Error("NF: "+o.slice(0,60));s=s.replace(o,x);n++;};

sub(` * WHEN THE NAME CANNOT BE READ, the greeting falls back to "Hi there,". That
 * single string is the one piece of this email the owner has not approved, and
 * it exists because the alternative is worse in both directions: holding
 * the cancellation until Shopify answers would make a withdrawn price
 * contingent on an unrelated outage, and storing the first name to avoid the
 * lookup would re-duplicate exactly the PII criterion 98 argued down to a
 * single field. Flagged rather than assumed.`,
` * WHEN THE NAME CANNOT BE READ, the greeting falls back to "Hi there,".
 * OWNER-APPROVED 2026-09-22, alongside the dynamic form — both greetings are
 * approved copy and both are pinned.
 *
 * The owner also ruled the mechanism, not just the words: the first name is
 * NEVER persisted for personalisation, and a failure to retrieve it must
 * neither delay nor reverse a cancellation. Holding the cancellation until
 * Shopify answers would make a withdrawn price contingent on an unrelated
 * outage; storing the name would re-duplicate exactly the PII criterion 98
 * argued down to a single field.`);

sub(`/** Used only when the first name cannot be read. See the module comment. */
export const UNAPPROVED_FALLBACK_GREETING_NAME = "there";`,
`/**
 * The approved fallback greeting name, giving "Hi there,". Used only when
 * Shopify cannot supply the first name. Owner-approved 2026-09-22.
 */
export const APPROVED_FALLBACK_GREETING_NAME = "there";`);

sub(`input.customerFirstName, UNAPPROVED_FALLBACK_GREETING_NAME`, `input.customerFirstName, APPROVED_FALLBACK_GREETING_NAME`);
fs.writeFileSync(p,s);console.log("edits:",n);
