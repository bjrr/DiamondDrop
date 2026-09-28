# Cloudflare R2 — exact setup steps (owner action)

**Status: LIVE AND PROVEN — 2026-09-28.** Bucket `caratforus-evidence-prod`,
four Fly secrets deployed on `caratforus`, live gate
(`tests/live/slice5.r2EvidenceStorage.ts`) exit 0 with all four required
assertions executed and passing: `put`, `unsigned-private`, `signed-get`,
`expiry`. Both go-live conditions in §5a are closed.

TWO THINGS THE GREEN DOES NOT ESTABLISH, recorded so nobody reads it wider
than it is:

1. **`unsigned-private` proves the S3 API endpoint requires auth — not that
   the bucket has no public URL.** A bucket with Public Development URL
   enabled is served from a DIFFERENT hostname (`pub-<hash>.r2.dev`) that the
   gate never requests. §2 below (Public Development URL disabled, no custom
   domain) is what actually keeps this bucket private; the gate cannot
   substitute for it. If anyone ever enables that URL, every assertion in the
   gate still passes.
2. **Uploads are enabled by credential PRESENCE alone.**
   `resolveWarrantyUploadPort` returns `configured: true` as soon as the four
   variables are non-empty — there is no separate flag. So uploads went live
   in production when the Fly secrets deployed, BEFORE the gate was run. The
   sequence was enabled-then-proven. If that ordering matters for a future
   store, add an explicit flag that uploads require IN ADDITION to
   credentials; credentials alone should not be able to turn them on.

Nothing here asks you to paste a secret into chat. Keys go straight from the
Cloudflare dashboard into `fly secrets set` on your machine.

---

## 1. Create the bucket

1. Cloudflare dashboard → **R2 Object Storage** → **Create bucket**
2. **Bucket name:** `caratforus-evidence-prod`
   Lowercase, hyphens only — R2 rejects underscores and uppercase.
3. **Location:** choose **Automatic**, or **North America (ENAM)** if offered
   a specific hint. The app runs in Fly's `iad` region, so ENAM is closest.
   This is a latency choice only and can't be changed after creation.
4. **Default storage class:** **Standard**. Not Infrequent Access — warranty
   photos are read during claim review, which is exactly when you don't want
   a retrieval penalty.
5. Create.

## 2. Confirm it is private — the step that matters most

A newly created R2 bucket is private. **Do not change that.** Specifically:

- **Settings → Public Development URL → leave DISABLED.**
- **Settings → Custom Domains → add none.**

Either one makes every object readable by anyone with the URL. These are
customer jewellery photographs attached to warranty claims; they are evidence
and they are personal data. The application reads them through short-lived
signed URLs, which works precisely because the bucket is not public.

If you ever see an `r2.dev` URL for this bucket, public access is on and
should be turned off.

## 3. API token — least privilege

R2 → **Manage R2 API Tokens** → **Create API token**

- **Token name:** `caratforus-app-evidence`
- **Permissions:** **Object Read & Write**
  NOT "Admin Read & Write". The app uploads and reads objects; it never needs
  to create, configure or delete buckets. If the key leaks, the difference
  is between someone reading objects and someone deleting the bucket.
- **Specify bucket:** **Apply to specific buckets only** → `caratforus-evidence-prod`
  A token scoped to one bucket cannot reach anything you add later.
- **TTL:** leave as no expiry for now. A rotating token needs a rotation
  procedure, and a procedure nobody follows is worse than a stable key.
- Create, then copy the three values shown **once**:
  - Access Key ID
  - Secret Access Key
  - The S3 endpoint, shaped `https://<accountid>.r2.cloudflarestorage.com`

Keep that page open until you have run the `fly secrets set` command below —
Cloudflare will not show the secret again.

## 4. CORS — required for browser uploads

The customer's browser PUTs the file directly to R2 using a presigned URL, so
R2 must accept a cross-origin request from the storefront.

Bucket → **Settings → CORS Policy → Add CORS policy**, and paste:

```json
[
  {
    "AllowedOrigins": [
      "https://caratforus-dev.myshopify.com"
    ],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["etag"],
    "MaxAgeSeconds": 3600
  }
]
```

Notes on why it is this narrow:

- **`PUT` only.** The browser never GETs from R2 — reads go through the app,
  which issues short-lived signed URLs. `GET` here would widen access for no
  benefit.
- **Named origin, never `*`.** A wildcard lets any site drive uploads with a
  presigned URL it has obtained.
- Add the live custom domain as a second entry when the store moves off
  `myshopify.com`. Until then one origin is correct.

---

## 5. The Fly secrets to set

Run these **on your machine**, substituting the values from step 3. Paste them
nowhere else.

```
fly secrets set -a caratforus \
  STORAGE_ENDPOINT="https://<accountid>.r2.cloudflarestorage.com" \
  STORAGE_BUCKET="caratforus-evidence-prod" \
  STORAGE_ACCESS_KEY_ID="<access key id>" \
  STORAGE_SECRET_ACCESS_KEY="<secret access key>"
```

All four names already exist in the environment schema and are empty in every
environment today — that is why uploads currently fail closed rather than
crashing. Setting them triggers one Fly deploy automatically.

A note on the endpoint: it is the account-level S3 endpoint **without** the
bucket name appended. The bucket is supplied separately via `STORAGE_BUCKET`.
Appending it produces signature failures that read like credential errors and
waste an afternoon.

## 5a. Two go-live conditions — BOTH CLOSED 2026-09-28

These gated go-live rather than sitting on a backlog, because both became
real the moment the credentials were set. Kept here rather than deleted: what
a condition was, and how it was actually closed, is the record that explains
why the current design looks the way it does.

**1. The intake route trusted a client-supplied `storageKey` — CLOSED
2026-09-28.** `apps.carat.warranty-claim.tsx` used to accept `storageKey` as
an opaque string and never check that a destination had actually been issued
for it, so a customer could submit a claim naming a key they never uploaded
to — an evidence record pointing at nothing, or at an object they did not
create. These rows ARE the dispute evidence, and a claim that appears to
carry photographs but does not is worse than one with none: it looks
substantiated.

Closed with a PERSISTED issued-destination record
(`WarrantyClaimUploadDestination`, migration
`20260928030000_warranty_claim_upload_destination`), not a signature. Every
issuance stores the authenticated `customerRef`; the intake route verifies
AND consumes each destination in one atomic conditional UPDATE
(`consumeWarrantyClaimUploadDestination`) inside a single transaction, before
the acknowledgment write or the order lookup. Any unverifiable key refuses
the WHOLE submission with 422 and creates no claim. Never-issued,
wrong-claim, wrong-customer and expired all collapse to the identical
response, so it is not an enumeration oracle.

Because evidence is uploaded before the claim exists, the client generates
the claim's id up front and submits it — safe because a caller-supplied id
can only ever create a BRAND NEW claim (primary-key uniqueness refuses
reuse), and the persisted destination's `customerRef` still gates
consumption. The id is honoured ONLY when the submission carries uploads;
with none there is nothing to bind, so the column default generates it and
claim creation cannot be used to probe whether a guessed id exists.

**2. R2 addressing style — SETTLED 2026-09-28, no change needed.** The client's
virtual-hosted addressing (`<bucket>.<accountid>.r2.cloudflarestorage.com`,
no `forcePathStyle`) round-tripped against the real bucket on the first
attempt. The `forcePathStyle: true` fallback documented in
`r2Client.server.ts`'s header was NOT required and was not applied.

## 6. What I do once they are set

1. Implement the R2 adapter behind the existing port
   (`app/app/jobs/warranty/ports.ts`), which already defines the shape and
   currently returns `uploadUrl: null` by design.
2. Write a live gate that proves, against the real bucket:
   - a presigned PUT succeeds from an allowed origin;
   - the object is **NOT** readable without a signed URL — the single most
     important assertion, because a bucket that is accidentally public passes
     every other test;
   - a signed read URL works and expires.
3. Keep uploads fail-closed until that gate passes. If it cannot be proven,
   uploads stay off and I tell you why rather than shipping them hopefully.

Tell me when the secrets are set and I will run it.
