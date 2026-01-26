import path from "node:path";
import {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_PASSWORD,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import dotenv from "dotenv";

// Load .env from platform root - this runs once when the module is imported
dotenv.config({ path: path.resolve(__dirname, "../.env"), quiet: true });

/**
 * Auth state file paths for different user roles
 * These are used by auth.setup.ts and can be used in tests with test.use({ storageState: ... })
 */
export const adminAuthFile = path.join(
  __dirname,
  "playwright/.auth/admin.json",
);
export const editorAuthFile = path.join(
  __dirname,
  "playwright/.auth/editor.json",
);
export const memberAuthFile = path.join(
  __dirname,
  "playwright/.auth/member.json",
);

export const IS_CI = process.env.CI === "true";

export const UI_BASE_URL = "http://localhost:3000";
export const API_BASE_URL = "http://localhost:9000";
export const WIREMOCK_BASE_URL = "http://localhost:9092";

// Internal WireMock URL for backend-to-wiremock connections (used when storing URLs in database)
// In CI, the backend pod needs to use the Kubernetes service DNS name
// In local dev, localhost works because everything runs on the same host
export const WIREMOCK_INTERNAL_URL = IS_CI
  ? "http://e2e-tests-wiremock:8080"
  : "http://localhost:9092";

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

/**
 * Editor credentials for e2e tests
 * Editor role has limited permissions compared to admin
 */
export const EDITOR_EMAIL = "editor@example.com";
export const EDITOR_PASSWORD = "password";

/**
 * Member credentials for e2e tests
 * Member role has the most restricted permissions
 */
export const MEMBER_EMAIL = "member@example.com";
export const MEMBER_PASSWORD = "password";

/**
 * Team names for e2e tests
 */
export const DEFAULT_TEAM_NAME = "Default Team";
export const ENGINEERING_TEAM_NAME = "Engineering Team";
export const MARKETING_TEAM_NAME = "Marketing Team";

export const DEFAULT_PROFILE_NAME = "Default Profile";

export {
  E2eTestId,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";

export const TEST_CATALOG_ITEM_NAME = "internal-dev-test-server";
export const TEST_TOOL_NAME = `${TEST_CATALOG_ITEM_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}print_archestra_test`;
