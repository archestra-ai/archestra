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
 * - Wildcard for all origins: "*"
 * - Empty/undefined: derives from ARCHESTRA_API_BASE_URL
 */
const getCorsOrigins = (): string | string[] | RegExp[] => {
  const allowedFrontendOrigins = process.env.ARCHESTRA_ALLOWED_FRONTEND_ORIGINS;

  if (!allowedFrontendOrigins) {
    // Extract domain from ARCHESTRA_API_BASE_URL and use it for CORS
    const baseURL = process.env.ARCHESTRA_API_BASE_URL;

    if (baseURL) {
      try {
        const url = new URL(baseURL);

        // For localhost, use regex to support any port
        if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
          return [/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];
        }

        // For production domains, allow the exact origin
        const origin = `${url.protocol}//${url.hostname}`;
        return [origin];
      } catch {
        // Invalid URL, fall through to default
      }
    }

    // Default fallback: localhost regex pattern
    return [/^https?:\/\/localhost(:\d+)?$/];
  }

  if (allowedFrontendOrigins === "*") {
    return "*";
  }

  // Split comma-separated list and trim whitespace
  return allowedFrontendOrigins.split(",").map((origin) => origin.trim());
};

/**
 * Get trusted origins for better-auth
 * Converts CORS origins to a format that better-auth accepts (string[])
 * Note: better-auth supports wildcard patterns
 */
const getBetterAuthTrustedOrigins = (): string[] => {
  const allowedFrontendOrigins = process.env.ARCHESTRA_ALLOWED_FRONTEND_ORIGINS;

  if (!allowedFrontendOrigins) {
    // Extract domain from ARCHESTRA_API_BASE_URL and use it as trusted origin
    const baseURL = process.env.ARCHESTRA_API_BASE_URL;

    if (baseURL) {
      try {
        const url = new URL(baseURL);
        const origin = `${url.protocol}//${url.hostname}`;

        // For localhost, use wildcard to support any port
        if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
          return ["*://localhost:*", "*://127.0.0.1:*"];
        }

        // For production domains, use the exact origin
        return [origin];
      } catch {
        // Invalid URL, fall through to default
      }
    }

    // Default fallback: localhost with wildcard port
    return ["*://localhost:*"];
  }

  // Support wildcard for all origins if explicitly set
  if (allowedFrontendOrigins === "*") {
    return ["*"];
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
    trustedOrigins: getBetterAuthTrustedOrigins(),
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
