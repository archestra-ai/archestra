
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load platform/.env (assuming we run from backend/)
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import { initializeDatabase, getDb, schema } from "../database";
import { eq, like } from "drizzle-orm";

async function main() {
  console.log("Initializing database...");
  await initializeDatabase();
  const db = getDb();

  console.log("Cleaning up Bedrock API keys...");
  await db.delete(schema.chatApiKeysTable).where(eq(schema.chatApiKeysTable.provider, "bedrock"));

  console.log("Cleaning up internal-dev-test-server MCP servers...");
  await db.delete(schema.mcpServersTable).where(like(schema.mcpServersTable.name, "%internal-dev-test-server%"));

  console.log("Cleaning up internal-dev-test-server tools...");
  await db.delete(schema.toolsTable).where(like(schema.toolsTable.name, "%internal-dev-test-server%"));

  console.log("Cleanup done.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
