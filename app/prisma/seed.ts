// Minimal Slice 0 seed: proves the migrate → seed → dev pipeline works end
// to end with no live Shopify credentials (acceptance criterion 20).
// Product/campaign seed data is out of scope until the tables that hold
// them ship in their own slices (docs/ARCHITECTURE-MVP1.md §7 describes the
// eventual fuller seed; this is the Slice 0 subset).
import { createHash } from "node:crypto";

import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const slug = "sample-policy";
  const version = 1;
  const text = "This is a placeholder policy version created by the Slice 0 seed script.";
  const contentHash = createHash("sha256").update(text, "utf8").digest("hex");

  await prisma.policyVersion.upsert({
    where: { slug_version: { slug, version } },
    update: {},
    create: {
      slug,
      version,
      effectiveFrom: new Date(),
      text,
      contentHash,
    },
  });

  console.log(`Seeded policy_version "${slug}" v${version}.`);
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
