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

/**
 * Parse port from ARCHESTRA_API_BASE_URL if provided
 */
const getPortFromUrl = (): number => {
  const url = process.env.ARCHESTRA_API_BASE_URL;
  const defaultPort = 9000;

  if (!url) {
    return defaultPort;
  }

  try {
    const parsedUrl = new URL(url);
    return parsedUrl.port ? Number.parseInt(parsedUrl.port, 10) : defaultPort;
  } catch {
    return defaultPort;
  }
};

/**
 * Parse CORS origins from environment variable
 * Supports:
 * - Comma-separated list: "https://example.com,https://app.example.com"
 * - Wildcard for all origins: "*"
 * - Empty/undefined: defaults to "*" in development, localhost regex in production
 */
const getCorsOrigins = (): string | string[] | RegExp[] => {
  const allowedFrontendOrigins = process.env.ALLOWED_FRONTEND_ORIGINS;
  const isDevelopment = process.env.NODE_ENV === "development";

  if (!allowedFrontendOrigins) {
    // Default: allow all origins in development, localhost only in production
    return isDevelopment ? "*" : [/^https?:\/\/localhost(:\d+)?$/];
  }

  if (allowedFrontendOrigins === "*") {
    return "*";
  }

  // Split comma-separated list and trim whitespace
  return allowedFrontendOrigins.split(",").map((origin) => origin.trim());
};

export default {
  baseURL: process.env.ARCHESTRA_API_BASE_URL,
  api: {
    host: "0.0.0.0",
    port: getPortFromUrl(),
    name: "Archestra Platform API",
    version: packageJson.version,
  },
  database: {
    url: process.env.DATABASE_URL,
  },
  cors: {
    origins: getCorsOrigins(),
  },
  debug: process.env.NODE_ENV === "development",
  benchmark: {
    mockMode: process.env.BENCHMARK_MOCK_MODE === "true",
  },
};
