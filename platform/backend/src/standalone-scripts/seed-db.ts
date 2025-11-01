import { pathToFileURL } from "node:url";
import logger from "@/logging";
import { seedDatabase } from "../database/seed";

/**
 * CLI entry point for seeding the database
 */
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedDatabase()
    .then(() => {
      logger.info("\n✅ Done!");
      process.exit(0);
    })
    .catch((error) => {
      logger.error({ err: error }, "\n❌ Error seeding database:");
      process.exit(1);
    });
}
