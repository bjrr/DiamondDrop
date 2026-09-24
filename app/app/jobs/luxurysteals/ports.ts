import type { AdminGraphqlClient } from "~/shopify/admin/productClient.server";
import type { LuxuryStealAssignment } from "~/shopify/metafields/luxuryStealMetafield";
import { setLuxuryStealMetafields } from "~/shopify/metafields/luxuryStealMetafieldWriter.server";

/**
 * Ports for the Luxury Steal metafield sync job (Slice 3 task 3-2b,
 * docs/specs/SLICE-3-LUXURY-STEALS.md criteria 126, 152).
 *
 * Mirrors `app/app/jobs/pricing/ports.ts`'s pattern deliberately: the
 * persistence layer (`~/db/repositories/luxuryStealRepository.server.ts`)
 * never calls the Shopify writer directly — this interface is the seam that
 * keeps persistence and Shopify apart, with the JOB layer
 * (`./syncAssignment.server.ts`) owning sequencing: Postgres commits first
 * as the system of record, the sync is attempted after, and a sync failure
 * never blocks or rolls back the Postgres write.
 */
export interface LuxuryStealMetafieldSyncPort {
  /**
   * Syncs one or more variants' Luxury Steal assignment to Shopify. Never
   * resolves before Shopify has confirmed every write landed on its intended
   * variant — any failure throws, and the caller's previously published
   * cache state remains authoritative until a later call succeeds
   * (criterion 126).
   */
  syncAssignments(
    assignments: readonly LuxuryStealAssignment[]
  ): Promise<{ appliedAt: Date; writtenVariantGids: readonly string[] }>;
}

/**
 * Production wiring — a thin adapter over `setLuxuryStealMetafields`
 * (task 3-2's tested, previously-unwired writer). Constructed directly with
 * an already-authenticated `AdminGraphqlClient`: unlike
 * `productionPriceSyncPort.server.ts`, this has no cron caller that needs to
 * boot without Shopify credentials — every caller of this port today is an
 * embedded-admin route, which already holds a real client from
 * `authenticate.admin(request)`. No dynamic import or lazy deferral is
 * needed for that reason.
 */
export class ShopifyLuxuryStealMetafieldSyncPort implements LuxuryStealMetafieldSyncPort {
  constructor(private readonly client: AdminGraphqlClient) {}

  async syncAssignments(
    assignments: readonly LuxuryStealAssignment[]
  ): Promise<{ appliedAt: Date; writtenVariantGids: readonly string[] }> {
    return setLuxuryStealMetafields(this.client, assignments);
  }
}

/** Records calls instead of performing them. Tests only. */
export class RecordingLuxuryStealMetafieldSyncPort implements LuxuryStealMetafieldSyncPort {
  readonly calls: (readonly LuxuryStealAssignment[])[] = [];
  /** Set by a test to make the NEXT call throw, simulating one failed Admin API write. Cleared after use — lets a test make attempt 1 fail and attempt 2 (the bounded retry) succeed. */
  failNextWith: Error | null = null;
  /** Set by a test to make EVERY call throw until cleared — for exercising the "both attempts fail" path. Checked after `failNextWith`. */
  alwaysFailWith: Error | null = null;

  async syncAssignments(
    assignments: readonly LuxuryStealAssignment[]
  ): Promise<{ appliedAt: Date; writtenVariantGids: readonly string[] }> {
    this.calls.push(assignments);
    if (this.failNextWith) {
      const error = this.failNextWith;
      this.failNextWith = null;
      throw error;
    }
    if (this.alwaysFailWith) {
      throw this.alwaysFailWith;
    }
    return {
      appliedAt: new Date(0),
      writtenVariantGids: assignments.map((a) => a.shopifyVariantGid),
    };
  }
}
