# Cloudflare R2 — exact setup steps (owner action)

**Status: awaiting owner.** Warranty and RMA uploads stay FAIL-CLOSED until
this bucket exists and has been live-proven. No Shopify Files fallback, no
public bucket, no "temporary" substitute — a private evidence store that is
quietly public is worse than no uploads at all.

Nothing here asks you to paste a secret into chat. Keys go straight from the
Cloudflare dashboard into `fly secrets set` on your machine.

---

## 1. Create the bucket

1. Cloudflare dashboard → **R2 Object Storage** → **Create bucket**
2. **Bucket name:** `caratforus-evidence`
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
- **Specify bucket:** **Apply to specific buckets only** → `caratforus-evidence`
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
  STORAGE_BUCKET="caratforus-evidence" \
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
