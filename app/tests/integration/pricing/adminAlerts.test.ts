import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { dispatchAdminAlert } from "~/db/repositories/adminAlertDispatch.server";
import { listOpenAdminAlerts } from "~/db/repositories/adminAlertRepository.server";
import { recordAlertNotification } from "~/db/repositories/adminAlertNotificationRepository.server";
import { EmailSendError, type EmailPort } from "~/lib/email/port";

/**
 * Slice 2 stage 2A (owner §7/§15). Direct coverage of the dedup ledger, the
 * dispatch function's three delivery outcomes, and the embedded-admin
 * listing's join/labelling and dismissed-status handling — independent of
 * `adminAlertWiring.test.ts`, which proves the `app/jobs/pricing/` call
 * sites reach this subsystem at all.
 *
 * Episodes here are inserted directly into `price_calculation_failure` /
 * `price_sync_failure` (both ordinary mutable tables, not append-only —
 * see their own model doc comments) rather than produced by running the
 * recalculation/sync jobs, so each scenario is set up in one step without
 * needing a full pricing profile/cost-library fixture.
 */

const createdProductIds: string[] = [];

afterEach(async () => {
  if (createdProductIds.length === 0) return;
  // Cascades to master_variant/ring_size_band via FK ON DELETE — cleans the
  // whole fixture tree in one statement. price_calculation_failure /
  // price_sync_failure / admin_alert_notification rows reference
  // master_variant with ON DELETE RESTRICT, so those are removed first.
  const variants = await prisma.masterVariant.findMany({
    where: { masterProductId: { in: createdProductIds } },
    select: { id: true },
  });
  const variantIds = variants.map((v) => v.id);
  await prisma.adminAlertNotification.deleteMany({ where: { masterVariantId: { in: variantIds } } });
  await prisma.priceCalculationFailure.deleteMany({ where: { masterVariantId: { in: variantIds } } });
  await prisma.priceSyncFailure.deleteMany({ where: { masterVariantId: { in: variantIds } } });
  await prisma.masterVariant.deleteMany({ where: { id: { in: variantIds } } });
  await prisma.ringSizeBand.deleteMany({ where: { masterProductId: { in: createdProductIds } } });
  await prisma.masterProduct.deleteMany({ where: { id: { in: createdProductIds } } });
  createdProductIds.length = 0;
});

async function fixtureVariant(opts: { productName?: string; bandLabel?: string } = {}) {
  const suffix = randomUUID().slice(0, 8);
  const product = await prisma.masterProduct.create({
    data: {
      name: opts.productName ?? `admin-alert fixture ${suffix}`,
      category: "ring",
      sizeAxis: "ring_size_us",
      allowedSizeMin: "2",
      allowedSizeMax: "11",
      sizeIncrement: "0.5",
      baseSize: "6",
      offeredMetals: ["gold"],
      status: "active",
      shopifyProductGid: `gid://shopify/Product/${suffix}`,
    },
  });
  createdProductIds.push(product.id);

  const band = await prisma.ringSizeBand.create({
    data: {
      masterProductId: product.id,
      label: opts.bandLabel ?? "6-6.5",
      sizeMin: "6",
      sizeMax: "6.5",
      sortOrder: 1,
    },
  });

  const variant = await prisma.masterVariant.create({
    data: {
      masterProductId: product.id,
      metal: "gold",
      purity: "GOLD_14K",
      bandId: band.id,
      baseWeightGrams: "3.2000",
      weightPerFullSizeGrams: "0.1500",
      status: "active",
      laborSource: "india",
      shopifyVariantGid: `gid://shopify/ProductVariant/${suffix}`,
    },
  });

  return { product, band, variant };
}

const T0 = new Date("2026-09-19T00:00:00.000Z");

async function openCalculationFailure(masterVariantId: string, at: Date = T0) {
  return prisma.priceCalculationFailure.create({
    data: {
      masterVariantId,
      firstFailedAt: at,
      lastAttemptAt: at,
      attemptCount: 1,
      failureType: "missing_cost_input",
      lastError: "No applicable cost_component.setting row effective",
    },
  });
}

async function openSyncFailure(masterVariantId: string, at: Date = T0) {
  return prisma.priceSyncFailure.create({
    data: {
      masterVariantId,
      firstFailedAt: at,
      lastAttemptAt: at,
      attemptCount: 1,
      lastError: "Shopify rejected the price update: Price must be greater than 0.",
      alertState: "active",
    },
  });
}

describe("recordAlertNotification — dedup by unique constraint", () => {
  it("records the first notification for a (sourceKind, sourceId, event) triple", async () => {
    const { variant } = await fixtureVariant();
    const failure = await openCalculationFailure(variant.id);

    const result = await recordAlertNotification({
      sourceKind: "calculation_failure",
      sourceId: failure.id,
      event: "opened",
      masterVariantId: variant.id,
      emailDeliveryStatus: "skipped_unconfigured",
      emailDeliveryReason: "email not configured: missing EMAIL_API_KEY",
      emailProviderMessageId: null,
    });

    expect(result.recorded).toBe(true);
  });

  it("suppresses a second insert for the identical (sourceKind, sourceId, event) triple", async () => {
    const { variant } = await fixtureVariant();
    const failure = await openCalculationFailure(variant.id);

    const input = {
      sourceKind: "calculation_failure" as const,
      sourceId: failure.id,
      event: "opened" as const,
      masterVariantId: variant.id,
      emailDeliveryStatus: "skipped_unconfigured" as const,
      emailDeliveryReason: "email not configured: missing EMAIL_API_KEY",
      emailProviderMessageId: null,
    };

    const first = await recordAlertNotification(input);
    const second = await recordAlertNotification(input);

    expect(first.recorded).toBe(true);
    expect(second.recorded).toBe(false);

    const rows = await prisma.adminAlertNotification.findMany({
      where: { sourceKind: "calculation_failure", sourceId: failure.id, event: "opened" },
    });
    expect(rows).toHaveLength(1);
  });

  it("does NOT suppress a different event for the same episode", async () => {
    const { variant } = await fixtureVariant();
    const failure = await openCalculationFailure(variant.id);

    const base = {
      sourceKind: "calculation_failure" as const,
      sourceId: failure.id,
      masterVariantId: variant.id,
      emailDeliveryStatus: "skipped_unconfigured" as const,
      emailDeliveryReason: "email not configured: missing EMAIL_API_KEY",
      emailProviderMessageId: null,
    };

    const opened = await recordAlertNotification({ ...base, event: "opened" });
    const resolved = await recordAlertNotification({ ...base, event: "resolved" });

    expect(opened.recorded).toBe(true);
    expect(resolved.recorded).toBe(true);
  });
});

describe("dispatchAdminAlert — delivery outcomes", () => {
  it("is honest (skipped_unconfigured, with a reason) when no email deps are supplied against this test env", async () => {
    const { variant } = await fixtureVariant();
    const failure = await openCalculationFailure(variant.id);

    const result = await dispatchAdminAlert({
      sourceKind: "calculation_failure",
      sourceId: failure.id,
      event: "opened",
    });

    expect(result.dispatched).toBe(true);
    expect(result.emailDeliveryStatus).toBe("skipped_unconfigured");

    const row = await prisma.adminAlertNotification.findFirstOrThrow({
      where: { sourceKind: "calculation_failure", sourceId: failure.id, event: "opened" },
    });
    expect(row.emailDeliveryStatus).toBe("skipped_unconfigured");
    expect(row.emailDeliveryReason).toMatch(/EMAIL_API_KEY/);
    expect(row.emailProviderMessageId).toBeNull();
  });

  it("records 'sent' with the provider message id when the injected port succeeds", async () => {
    const { variant } = await fixtureVariant();
    const failure = await openCalculationFailure(variant.id);

    const fakePort: EmailPort = {
      send: async () => ({ providerMessageId: "msg_fake_123" }),
    };

    const result = await dispatchAdminAlert(
      { sourceKind: "calculation_failure", sourceId: failure.id, event: "opened" },
      {
        resolveEmailPort: () => ({
          configured: true,
          port: fakePort,
          from: "alerts@caratforus.example",
          recipients: ["staff@example.com"],
        }),
      }
    );

    expect(result.emailDeliveryStatus).toBe("sent");

    const row = await prisma.adminAlertNotification.findFirstOrThrow({
      where: { sourceKind: "calculation_failure", sourceId: failure.id, event: "opened" },
    });
    expect(row.emailDeliveryStatus).toBe("sent");
    expect(row.emailProviderMessageId).toBe("msg_fake_123");
    expect(row.emailDeliveryReason).toBeNull();
  });

  it("records 'failed' with the error name when the injected port throws", async () => {
    const { variant } = await fixtureVariant();
    const failure = await openCalculationFailure(variant.id);

    const throwingPort: EmailPort = {
      send: async () => {
        throw new EmailSendError("Resend responded with status 500");
      },
    };

    const result = await dispatchAdminAlert(
      { sourceKind: "calculation_failure", sourceId: failure.id, event: "opened" },
      {
        resolveEmailPort: () => ({
          configured: true,
          port: throwingPort,
          from: "alerts@caratforus.example",
          recipients: ["staff@example.com"],
        }),
      }
    );

    expect(result.emailDeliveryStatus).toBe("failed");

    const row = await prisma.adminAlertNotification.findFirstOrThrow({
      where: { sourceKind: "calculation_failure", sourceId: failure.id, event: "opened" },
    });
    expect(row.emailDeliveryStatus).toBe("failed");
    expect(row.emailDeliveryReason).toBe("EmailSendError");
    expect(row.emailProviderMessageId).toBeNull();
  });

  it("does not dispatch (or write a row) for an episode id that does not exist", async () => {
    const result = await dispatchAdminAlert({
      sourceKind: "calculation_failure",
      sourceId: randomUUID(),
      event: "opened",
    });

    expect(result.dispatched).toBe(false);
  });

  it("suppresses a duplicate dispatch for the same (episode, event) — three per episode maximum", async () => {
    const { variant } = await fixtureVariant();
    const failure = await openCalculationFailure(variant.id);
    const input = { sourceKind: "calculation_failure" as const, sourceId: failure.id, event: "opened" as const };

    const first = await dispatchAdminAlert(input);
    const second = await dispatchAdminAlert(input);

    expect(first.dispatched).toBe(true);
    expect(second.dispatched).toBe(false);

    const rows = await prisma.adminAlertNotification.findMany({
      where: { sourceKind: "calculation_failure", sourceId: failure.id, event: "opened" },
    });
    expect(rows).toHaveLength(1);
  });
});

describe("listOpenAdminAlerts — the embedded-admin listing", () => {
  it("lists an open calculation failure with resolved product/variant labels", async () => {
    const { variant, product } = await fixtureVariant({
      productName: "Solitaire Ring",
      bandLabel: "6-6.5",
    });
    await openCalculationFailure(variant.id, T0);

    const alerts = await listOpenAdminAlerts(new Date(T0.getTime() + 3 * 60 * 60 * 1000));
    const mine = alerts.find((a) => a.masterVariantId === variant.id);

    expect(mine).toBeDefined();
    expect(mine!.kind).toBe("calculation_failure");
    expect(mine!.productTitle).toBe("Solitaire Ring");
    expect(mine!.variantLabel).toContain("6-6.5");
    expect(mine!.shopifyProductGid).toBe(product.shopifyProductGid);
    expect(mine!.suspended).toBe(false);
    expect(mine!.status).toBe("active");
    expect(mine!.failureType).toBe("missing_cost_input");
  });

  it("marks a dismissed sync-failure alert as status 'dismissed' even though it is not suspended", async () => {
    const { variant } = await fixtureVariant();
    const failure = await openSyncFailure(variant.id, T0);
    await prisma.priceSyncFailure.update({
      where: { id: failure.id },
      data: {
        alertState: "dismissed",
        dismissedBy: "staff:alex",
        dismissedReason: "known transient error, retrying",
        dismissedAt: new Date(T0.getTime() + 60 * 60 * 1000),
      },
    });

    const alerts = await listOpenAdminAlerts(new Date(T0.getTime() + 2 * 60 * 60 * 1000));
    const mine = alerts.find((a) => a.masterVariantId === variant.id);

    expect(mine).toBeDefined();
    expect(mine!.kind).toBe("sync_failure");
    expect(mine!.suspended).toBe(false); // R2: dismissal never suspends
    expect(mine!.status).toBe("dismissed");
  });

  it("never includes a resolved episode — it drops off the moment resolvedAt is set", async () => {
    const { variant } = await fixtureVariant();
    const failure = await openCalculationFailure(variant.id, T0);
    await prisma.priceCalculationFailure.update({
      where: { id: failure.id },
      data: { resolvedAt: new Date(T0.getTime() + 60 * 60 * 1000), resolvedTrigger: "scheduled" },
    });

    const alerts = await listOpenAdminAlerts(new Date(T0.getTime() + 2 * 60 * 60 * 1000));
    expect(alerts.find((a) => a.masterVariantId === variant.id)).toBeUndefined();
  });

  it("reports a sync failure as suspended, with zero time remaining, once past the 48h cutoff", async () => {
    const { variant } = await fixtureVariant();
    const suspendedAt = new Date(T0.getTime() + 48 * 60 * 60 * 1000);
    const failure = await openSyncFailure(variant.id, T0);
    await prisma.priceSyncFailure.update({ where: { id: failure.id }, data: { suspendedAt } });

    const alerts = await listOpenAdminAlerts(new Date(suspendedAt.getTime() + 60 * 60 * 1000));
    const mine = alerts.find((a) => a.masterVariantId === variant.id);

    expect(mine!.suspended).toBe(true);
    expect(mine!.status).toBe("suspended");
    expect(mine!.msRemainingBeforeSuspension).toBe(0);
    expect(mine!.failureType).toBe("sync_rejected");
  });
});
