import { pathToFileURL } from "node:url";
import { seedDatabase } from "../database/seed";

/**
 * CLI entry point for seeding the database
 */
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedDatabase()
    .then(() => {
      console.log("\n✅ Done!");
      process.exit(0);
    })
    .catch((error) => {
      console.error("\n❌ Error seeding database:", error);
      process.exit(1);
    });
}
