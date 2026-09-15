import { prisma } from "./client.server";

export interface MigrationState {
  applied: string[];
  pending: string[];
  error?: string;
}

interface MigrationRow {
  migration_name: string;
  finished_at: Date | null;
}

/**
 * Reads Prisma's own `_prisma_migrations` bookkeeping table for the health
 * route (spec §0.2: "health route returning service status and migration
 * state"). Never throws — a missing table (fresh, unmigrated database) is
 * reported as an error state rather than crashing the health check.
 */
export async function getMigrationState(): Promise<MigrationState> {
  try {
    const rows = await prisma.$queryRaw<MigrationRow[]>`
      SELECT migration_name, finished_at
      FROM "_prisma_migrations"
      ORDER BY started_at ASC
    `;
    return {
      applied: rows.filter((row) => row.finished_at !== null).map((row) => row.migration_name),
      pending: rows.filter((row) => row.finished_at === null).map((row) => row.migration_name),
    };
  } catch (error) {
    return {
      applied: [],
      pending: [],
      error:
        "Could not read the Prisma migrations table — has `prisma migrate deploy` run against this database?",
    };
  }
}
