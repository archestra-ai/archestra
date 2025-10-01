import path from "node:path";
import dotenv from "dotenv";
import packageJson from "../package.json";

/**
 * Load .env from platform root
 *
 * This is a bit of a hack for now to avoid having to have a duplicate .env file in the backend subdirectory
 */
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

export default {
  api: {
    host: "0.0.0.0",
    port: 9000,
    name: "Archestra Platform API",
    version: packageJson.version,
  },
  database: {
    url: process.env.DATABASE_URL,
  },
  debug: process.env.NODE_ENV === "development",
};
