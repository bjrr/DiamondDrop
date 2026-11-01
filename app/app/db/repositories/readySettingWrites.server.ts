/**
 * Operator writes for ready-mount compatibility records.
 *
 * Authoritative requirements: docs/SET-YOUR-OWN-STONE.md §5.
 *
 * Separate from `readySettingRepository.server.ts`, which is the storefront's
 * read path. Keeping writes apart means the hot matching query cannot
 * accidentally acquire a dependency on operator concerns, and the admin screen
 * cannot reach for a read helper that silently filters out the inactive rows
 * it exists to let staff see and fix.
 */
import type { Prisma } from "@prisma/client";

import { prisma } from "~/db/client.server";
import type { ReadySettingInput } from "~/domain/setyourownstone/readySettingInput";

/** One row as the admin list and form need it — everything, including the
 *  fields the storefront never sees. */
export type ReadySettingRow = Prisma.ReadySettingCompatibilityGetPayload<object>;

/**
 * Every record, active and inactive, newest first within each shape.
 *
 * NO PAGINATION, deliberately. This is a curated catalogue of mountings a
 * jeweller has assessed by hand; if it ever reaches a size where one page is
 * unusable, that is a real signal and a real change, not something to
 * pre-build for a table that currently has no rows at all.
 */
export async function listReadySettings(): Promise<ReadySettingRow[]> {
  return prisma.readySettingCompatibility.findMany({
    orderBy: [{ shape: "asc" }, { nominalLengthUm: "asc" }, { nominalWidthUm: "asc" }],
  });
}

export async function findReadySettingById(id: string): Promise<ReadySettingRow | null> {
  return prisma.readySettingCompatibility.findUnique({ where: { id } });
}

/**
 * Create or update by variant gid.
 *
 * UPSERT ON THE VARIANT, because that is what the row means: one purchasable
 * configuration, one compatibility record, enforced by a unique index. An
 * operator re-entering a mounting they already recorded is correcting it, not
 * creating a duplicate — and two rows for one variant would make "which
 * nominal size does this mounting have" ambiguous at match time.
 */
export async function upsertReadySetting(input: ReadySettingInput): Promise<ReadySettingRow> {
  const data = {
    shopifyProductGid: input.shopifyProductGid,
    shape: input.shape,
    nominalLengthUm: input.nominalLengthUm,
    nominalWidthUm: input.nominalWidthUm,
    nominalDepthUm: input.nominalDepthUm,
    minLengthUm: input.minLengthUm,
    maxLengthUm: input.maxLengthUm,
    minWidthUm: input.minWidthUm,
    maxWidthUm: input.maxWidthUm,
    vendorRangeSource: input.vendorRangeSource,
    eligibleForSetYourOwnStone: input.eligibleForSetYourOwnStone,
    prongSetToleranceEligible: input.prongSetToleranceEligible,
    isActive: input.isActive,
  };

  return prisma.readySettingCompatibility.upsert({
    where: { shopifyVariantGid: input.shopifyVariantGid },
    create: { shopifyVariantGid: input.shopifyVariantGid, ...data },
    update: data,
  });
}

/**
 * Withdraw or restore a record.
 *
 * NOT A DELETE. A mounting that goes out of stock or gets discontinued stops
 * being offered, but the sessions that already matched against it keep
 * referring to it — and "why was this shown to that customer" needs an answer
 * afterwards, not just while the product is live.
 */
export async function setReadySettingActive(id: string, isActive: boolean): Promise<ReadySettingRow> {
  return prisma.readySettingCompatibility.update({ where: { id }, data: { isActive } });
}
