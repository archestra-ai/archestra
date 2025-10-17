import { pathToFileURL } from "node:url";
import db from "../database";
import { toolsTable } from "../database/schemas";

/**
 * CLI entry point for querying tool records
 */
async function queryTools() {
  console.log("Querying tool records from database...\n");

  try {
    const tools = await db.select().from(toolsTable).limit(10);

    console.log(`Found ${tools.length} tool records:\n`);

    for (const tool of tools) {
      console.log("---");
      console.log(`ID: ${tool.id}`);
      console.log(`Agent ID: ${tool.agentId}`);
      console.log(`Name: ${tool.name}`);
      console.log(`Description: ${tool.description || "(none)"}`);
      console.log(
        `Allow When Untrusted: ${tool.allowUsageWhenUntrustedDataIsPresent}`,
      );
      console.log(`Tool Result Treatment: ${tool.toolResultTreatment}`);
      console.log(`Created At: ${tool.createdAt}`);
      console.log();
    }

    // Also show raw count
    const allTools = await db.select().from(toolsTable);
    console.log(`\nTotal tools in database: ${allTools.length}`);
  } catch (error) {
    console.error("Error querying tools:", error);
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  queryTools()
    .then(() => {
      console.log("\n✅ Done!");
      process.exit(0);
    })
    .catch((error) => {
      console.error("\n❌ Error:", error);
      process.exit(1);
    });
}
