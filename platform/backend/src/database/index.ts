import fs from "node:fs";
import path from "node:path";
import { drizzle as drizzlePostgres } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import config from "@/config";
import { isDevEnv, isProdEnv } from "@/utils";
import * as schema from "./schemas";

const PG_LITE_DATA_DIR = path.resolve(".pgdata-dev");

let db: ReturnType<typeof drizzlePostgres> | ReturnType<typeof drizzlePglite>;

if (isProdEnv() && process.env.DATABASE_URL) {
  // Connect to real Postgres
  db = drizzlePostgres({
    connection: {
      connectionString: config.database.url,
    },
  });
} else {
  // Fallback: use persistent PGlite
  if (!fs.existsSync(PG_LITE_DATA_DIR)) {
    fs.mkdirSync(PG_LITE_DATA_DIR, { recursive: true });
  }
  db = drizzlePglite({ connection: { dataDir: PG_LITE_DATA_DIR } });
}

export async function runPgLiteMigrationsOnDevEnv() {
  if (isDevEnv()) {
    await migrate(db, { migrationsFolder: "src/database/migrations" });
  }
}

export default db;
export { schema };
