import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_EMAIL_ENV_VAR_NAME,
  DEFAULT_ADMIN_PASSWORD,
  DEFAULT_ADMIN_PASSWORD_ENV_VAR_NAME,
} from "@shared";
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

const isProduction = ["production", "prod"].includes(
  process.env.NODE_ENV?.toLowerCase() ?? "",
);
const isDevelopment = !isProduction;

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
 * - Empty/undefined: defaults to localhost regex (both http and https on any port)
 *
 * Note: Wildcard "*" is not supported when using credentials mode.
 * The frontend uses credentials: 'include', so we must specify exact origins.
 */
const getCorsOrigins = (): string | string[] | RegExp[] => {
  const allowedFrontendOrigins = process.env.ARCHESTRA_ALLOWED_FRONTEND_ORIGINS;

  if (!allowedFrontendOrigins) {
    // Default: allow localhost origins in both development and production
    return [/^https?:\/\/localhost(:\d+)?$/];
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
    corsOrigins: getCorsOrigins(),
  },
  auth: {
    secret: process.env.ARCHESTRA_AUTH_SECRET,
    adminDefaultEmail:
      process.env[DEFAULT_ADMIN_EMAIL_ENV_VAR_NAME] || DEFAULT_ADMIN_EMAIL,
    adminDefaultPassword:
      process.env[DEFAULT_ADMIN_PASSWORD_ENV_VAR_NAME] ||
      DEFAULT_ADMIN_PASSWORD,
  },
  database: {
    url: process.env.DATABASE_URL,
  },
  debug: isDevelopment,
  production: isProduction,
  benchmark: {
    mockMode: process.env.BENCHMARK_MOCK_MODE === "true",
  },
};
