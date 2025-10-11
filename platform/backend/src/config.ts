import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import packageJson from "../package.json";

/**
 * Load .env from platform root
 *
 * This is a bit of a hack for now to avoid having to have a duplicate .env file in the backend subdirectory
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env"), quiet: true });

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

// Parse port from ARCHESTRA_API_BASE_URL if provided
const getPortFromUrl = (url?: string): number => {
  if (!url) return 9000;
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.port ? Number.parseInt(parsedUrl.port, 10) : 9000;
  } catch {
    return 9000;
  }
};

export default {
  api: {
    host: "0.0.0.0",
    port: getPortFromUrl(process.env.ARCHESTRA_API_BASE_URL),
    name: "Archestra Platform API",
    version: packageJson.version,
  },
  database: {
    url: process.env.DATABASE_URL,
  },
  debug: process.env.NODE_ENV === "development",
};
