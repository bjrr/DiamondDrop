import "dotenv/config";

export default async function setup() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "Integration tests require DATABASE_URL to point at a migrated Postgres database. " +
        "Run `docker-compose up -d` (from repo root) and `npm run db:migrate` first (see app/README.md)."
    );
  }
}
