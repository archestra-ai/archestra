import path from "node:path";
import { DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD } from "@shared";
import dotenv from "dotenv";

// Load .env from platform root - this runs once when the module is imported
dotenv.config({ path: path.resolve(__dirname, "../.env"), quiet: true });

export const UI_BASE_URL = "http://localhost:3000";
export const API_BASE_URL = "http://localhost:9000";

export const METRICS_BASE_URL = "http://localhost:9050";
export const METRICS_BEARER_TOKEN = "foo-bar";
export const METRICS_ENDPOINT = "/metrics";

export const MCP_GATEWAY_URL_SUFFIX = "/v1/mcp";

/**
 * Admin credentials - read from environment with fallback to defaults
 * These are used for both auth.setup.ts and SSO E2E tests
 */
export const ADMIN_EMAIL =
  process.env.ARCHESTRA_AUTH_ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL;
export const ADMIN_PASSWORD =
  process.env.ARCHESTRA_AUTH_ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;

export {
  E2eTestId,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
