# Deploying CaratForUs to Fly.io

Owner decision **D3**: Fly.io, single region, Fly-managed Postgres, one
application process. No Redis, no queue, no worker container — the two
recurring jobs are cron-shaped and run through the platform scheduler against
authenticated internal routes.

This file is the runbook. It exists because two steps can only be taken by the
owner, and everything around them should be a copy-paste rather than a
redesign.

---

## What is already in the repository

| Artefact | Purpose |
|---|---|
| `app/Dockerfile` | Node 20 slim, three stages, `openssl` for Prisma, dev deps pruned after the build |
| `app/.dockerignore` | keeps `.env`, `.shopify` tunnel state and live-gate scripts out of the image |
| `app/fly.toml` | one region, one machine minimum, `/health` check, `release_command` running forward-only migrations |

`/health` already reports database reachability and migration state, returning
**200** healthy and **503** degraded — so the Fly check is a real readiness
signal, not "the process started".

---

## Step 1 — OWNER: authenticate and create the app

`flyctl` is installed (v0.4.105, via winget). It has **no credentials on this
machine**, and authenticating to a hosting account — plus attaching billing,
which Postgres requires — is not something an agent should do on your behalf.

```bash
flyctl auth login                      # opens a browser
flyctl apps create caratforus          # or: flyctl launch --no-deploy
```

### Managed Postgres, NOT `fly postgres`

`fly postgres` provisions **unmanaged** Postgres — Fly's current documentation
is explicit that it is a database you operate yourself. D3 requires **Fly
Managed Postgres**, which is a different product and a different command:

```bash
flyctl mpg create --name caratforus-db --region iad --plan Basic \
  --pg-major-version 16 --volume-size 10
flyctl mpg attach <clusterID> -a caratforus
```

`mpg attach` sets `DATABASE_URL` as a secret automatically. Do not set it by
hand.

**Postgres 16, not the newer 17.** Development runs `postgres:16-alpine` and
the dev database reports 16.15. For an application whose correctness rests on
append-only triggers, CHECK constraints and `numeric` money columns, matching
the major version removes a class of "works locally" difference that would
only ever surface in production.

---

## Step 2 — OWNER: rotate the Resend key FIRST

The previous key was exposed in a session transcript. **Revoke it in the Resend
dashboard and issue a new one** — do not reuse it, and do not paste it into
chat. Set it directly:

```bash
flyctl secrets set EMAIL_API_KEY="re_the_new_key" --app caratforus
```

---

## Step 3 — secrets

Every value below is a secret and belongs only in Fly's store. Nothing here is
committed. `DATABASE_URL` is already set by `mpg attach`.

```bash
flyctl secrets set --app caratforus \
  APP_ENV="production" \
  SESSION_SECRET="<32+ random chars, NEW — do not reuse the dev value>" \
  CRON_SECRET="<32+ random chars, NEW — do not reuse the dev value>" \
  SHOPIFY_API_KEY="<from the Shopify app>" \
  SHOPIFY_API_SECRET="<from the Shopify app>" \
  SHOPIFY_APP_URL="https://caratforus.fly.dev" \
  SHOPIFY_APP_PROXY_SUBPATH="carat" \
  SHOPIFY_SHOP_DOMAIN="caratforus-dev.myshopify.com" \
  SHOPIFY_ADMIN_API_VERSION="2026-07" \
  SHOPIFY_SCOPES="read_products,write_products,read_inventory,write_draft_orders,read_orders,write_payment_terms" \
  EMAIL_FROM="CaratForUs <orders@caratforus.com>" \
  STAFF_EMAIL_ALLOWLIST="orders@caratforus.com" \
  PRICE_AUTO_PUBLISH_ENABLED="false"
```

**`SESSION_SECRET` and `CRON_SECRET` must be newly generated, not copied from
`app/.env`.** A development secret that has lived on a laptop, in shell history
and in a container build context is not a production secret.

**`PRICE_AUTO_PUBLISH_ENABLED` starts `false` on the permanent host, by owner
direction.** It is turned on only once the deployment, App Proxy, database,
scheduled jobs and pricing path are all verified live.

The reason to sequence it that way is that auto-publish is the one setting
whose failure mode is silent and outward-facing: with it on, a price change
within 200 bps reaches the storefront with no human in the loop (§17). During
a first deployment — new host, new database, freshly cut-over proxy — that is
the last thing that should be able to move a customer-facing price. With it
off, every change queues for approval and nothing publishes itself while the
ground is still moving.

Turning it on afterwards is one command:

```bash
flyctl secrets set PRICE_AUTO_PUBLISH_ENABLED="true" --app caratforus
```

---

## Step 4 — deploy

```bash
flyctl deploy --app caratforus --remote-only
```

`--remote-only` builds on Fly's builders; no local Docker is required, and
none is installed on this machine.

The `release_command` runs `prisma migrate deploy` before the new version takes
traffic. It applies pending migrations and nothing else — never generates,
never resets, never prompts, and **refuses a migration whose recorded checksum
does not match**. That last property is why it is the only migration command
allowed near production: this repository has twice had checksum drift from
editing an applied migration, and here that drift aborts the deploy rather than
silently diverging the schema. A failed release leaves the previous version
serving.

---

## Step 5 — point Shopify at the permanent host

In `app/shopify.app.caratforus-development.toml`:

```toml
application_url = "https://caratforus.fly.dev"

[auth]
  redirect_urls = [ "https://caratforus.fly.dev/auth/callback" ]

[app_proxy]
  url = "https://caratforus.fly.dev"
```

then:

```bash
cd app && npx shopify app deploy --allow-updates
```

**Stop `shopify app dev` before doing this.** It re-pushes its own ephemeral
tunnel configuration over a deploy made while it is running — that cost three
scope attempts earlier in this project and looked like consent failures.

Webhook subscriptions registered through the app configuration follow
`application_url` automatically; any registered imperatively against the tunnel
must be re-registered.

---

## Step 6 — schedule both jobs

Scheduled machines, authenticating with the header the routes already require.
`curl -fsS` fails the run on a non-2xx, so a rejected secret surfaces as a
failed job rather than a silent no-op.

```bash
flyctl machine run . --schedule hourly --app caratforus \
  --command "curl -fsS -X POST https://caratforus.fly.dev/internal/jobs/bank-payment-guarantee -H 'x-carat-cron-secret: $CRON_SECRET'"

flyctl machine run . --schedule daily --app caratforus \
  --command "curl -fsS -X POST https://caratforus.fly.dev/internal/jobs/price-recalculation -H 'x-carat-cron-secret: $CRON_SECRET'"
```

**Hourly is a floor, not a preference.** The guarantee is 24 hours; run the
sweep daily and an order can sit a full day past expiry, during which a
customer may pay against a quote we intended to withdraw.

---

## Step 7 — prove it, by evidence rather than by green ticks

- `flyctl status` — one machine, health check passing.
- `curl https://caratforus.fly.dev/health` — `200`, database `ok`.
- Restart (`flyctl apps restart caratforus`) and confirm the offline Shopify
  session survives: it lives in Postgres, not in memory, so a restart must not
  require re-consent.
- Invoke each job route by hand and read its **own** evidence: recalculation
  writes a `price_recalculation_run` row; the sweep logs
  `bank_payment.guarantee_sweep_completed` with counts and returns them.
  A sweep that runs and finds nothing looks exactly like one that never ran if
  you only check whether anything was cancelled.
- `flyctl logs` — confirm no secret value appears. The structured logger
  redacts, but the check is cheap and the cost of being wrong is not.
