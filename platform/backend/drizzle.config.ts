import path from "node:path";
import dotenv from "dotenv";
import { defineConfig } from "drizzle-kit";

dotenv.config({ path: path.resolve(__dirname, "../.env"), quiet: true });

// Get database URL (prefer ARCHESTRA_DATABASE_URL, fallback to DATABASE_URL)
const databaseUrl =
  process.env.ARCHESTRA_DATABASE_URL || process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Database URL is not set. Please set ARCHESTRA_DATABASE_URL or DATABASE_URL",
  );
}

export default defineConfig({
  out: "./src/database/migrations",
  schema: "./src/database/schemas",
  dialect: "postgresql",
  casing: "snake_case",
  dbCredentials: {
    url: databaseUrl,
  },
});
