# Launching Soon signup — what happens when someone signs up

Owner instruction, 2026-11-13. Two emails on every valid signup: a
confirmation to the customer, and a notification to `orders@caratforus.com`.

---

## What was wrong

The signup is Shopify's native `{% form 'customer' %}`, so **Shopify**
creates the customer. Our app was called afterwards only to store the
optional mobile number, and only when one had been typed:

```js
var phone = value('contact[phone]');
if (phone === '') return null;      // no phone -> no call at all
```

Mobile is optional, so the ordinary signup — a name and an email — never
reached the backend. Nothing errored and the form said it had worked.

**Nothing sent any email.** No confirmation, no internal notification, no
template anywhere in the codebase. Two real signups had already been through
the form and received nothing.

## What triggers the emails now

**`customers/create`**, not the form's own fetch. Three reasons, in order of
importance:

1. **It cannot miss a signup.** Shopify delivers the topic for every customer
   the form creates, with retries, whatever the browser did.
2. **It reaches the live page.** `/pages/first-access` is served by the
   published COMING SOON theme, which must not be modified. A fix living in
   theme JavaScript could not fix the page actually taking signups today.
   This one needs no theme change at all.
3. **It is not client-side.** A browser fetch is lost to a closed tab, a
   dropped connection or a blocked script.

Only customers carrying the **`first-access`** tag are acted on — the tag the
signup form sets as a hidden field. A customer created in the admin, by an
import or by a future checkout is not a Launching Soon signup and must never
be told they are on an early-access list.

| Piece | Where |
|---|---|
| Copy, both emails | `app/app/domain/firstaccess/signupEmails.ts` |
| Trigger and sending | `app/app/shopify/webhooks/firstAccessSignupHandler.server.ts` |
| Route | `app/app/routes/webhooks.carat.customers-create.tsx` |
| Subscription registration | `app/app/routes/internal.jobs.ensure-signup-webhook.tsx` |

Live subscription: `gid://shopify/WebhookSubscription/2105460752602` →
`https://caratforus.fly.dev/webhooks/carat/customers-create`.

### Sent once, though delivery is at-least-once

`receiveShopifyWebhook` deduplicates on the delivery id, but a redelivery
whose first attempt **failed** is reprocessed on purpose — that is what makes
a transient failure recoverable. If the confirmation had already gone and the
internal notification was what failed, a plain retry would email the customer
twice.

So each email holds its own idempotency key. The four states are handled
distinctly, and the distinction is the whole point:

| State | Behaviour |
|---|---|
| none | claim and send |
| `failed` | a definitive rejection, known not delivered — **send again** |
| `succeeded` | never again |
| `in_doubt` | provider may have sent it — **do not resend**, leave for a human |
| `pending` | another delivery is mid-flight — leave alone |

The first version used `tryCreatePending` alone, which returns false for
*any* existing key. A failed send would therefore never have been retried —
the opposite of what its own comment claimed. A unit test for the
half-failure case is what caught it.

## The form fix

`theme/assets/first-access-v2.js` now gates on **email**, the required
contact field, and passes a blank phone through rather than suppressing the
whole request. The endpoint already treats a blank phone as "nothing to
store" and answers 200 without logging, so an omitted number still cannot
clear a stored one — that guarantee lives on the server.

**Names are still not sent to the proxy**, which is the original author's
rule kept deliberately. They persist through the native Shopify post, and
this is a public endpoint: anything it accepts is something a public endpoint
could change. The first name the confirmation greets by is read from the
Shopify customer in the webhook payload, where it was already stored.

This change is in the **LAUNCH theme only**. The live COMING SOON theme is
untouched, and does not need the change — the emails come from the webhook.

## Success message

`You’re on the list.` / `Check your inbox for confirmation.`
(`templates.first_access_v2.success` — V2 is the canonical page; the archived
V1 copy at `/pages/first-access-v1` was left alone.)

Live only once LAUNCH is published; the published COMING SOON theme keeps its
current wording until then. The confirmation **email** works on both.

---

## Unrelated finding: production has no webhook subscriptions

While registering `customers/create` it became clear that the CaratForUs app
had **zero** webhook subscriptions on the production store. All four declared
topics are inert:

| Topic | What is not happening |
|---|---|
| `orders/create` | Luxury Steals Final Sale acknowledgment is not enforced and no fulfilment hold is placed; Group Buy units are not counted |
| `orders/paid` | Custom Jewelry deposits do not advance to `deposit_charged` |
| `products/update` | "As low as" pricing is not re-resolved |
| `inventory_levels/update` | Purchasability is not re-resolved |

The cause is structural rather than a mistake:
`shopify.app.caratforus-development.toml` declares them, and its own header
records that `shopify app deploy` has deliberately never been run, so they
were never registered. `shopify app execute` cannot help either — the CLI
refuses mutations against a non-development store.

**This was deliberately not fixed here.** Registering `orders/create` would
immediately begin placing fulfilment holds on Luxury Steals orders and
counting Group Buy units toward public, monotonic progress. Those are
money- and fulfilment-affecting behaviours; switching them on is an owner
decision, not a side effect of shipping a signup email.

`internal.jobs.ensure-signup-webhook` is the pattern for fixing it when that
decision is made: it registers through the app's own offline session, which
is also the only way to get a delivery signed with **this** app's secret —
the one `receiveShopifyWebhook` verifies against. A subscription created by
any other app, including an MCP connector, would be registered, would
deliver, and would 401 on every delivery.
