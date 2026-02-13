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

// Use 127.0.0.1 instead of localhost to avoid IPv6 issues with Docker networking
// These can be overridden via environment variables for different test environments
export const UI_BASE_URL =
  process.env.E2E_UI_BASE_URL || "http://localhost:3000";
export const API_BASE_URL =
  process.env.E2E_API_BASE_URL || "http://localhost:9000";
export const WIREMOCK_BASE_URL =
  process.env.E2E_WIREMOCK_BASE_URL || "http://localhost:9092";

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

export { E2eTestId, MCP_SERVER_TOOL_NAME_SEPARATOR } from "@shared";

export const TEST_CATALOG_ITEM_NAME = "internal-dev-test-server";
export const TEST_TOOL_NAME = `${TEST_CATALOG_ITEM_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}print_archestra_test`;

// =============================================================================
// Keycloak Configuration (matches helm/e2e-tests/values.yaml)
// =============================================================================

export const KEYCLOAK_EXTERNAL_URL = "http://localhost:30081";
export const KEYCLOAK_BACKEND_URL = IS_CI
  ? "http://e2e-tests-keycloak:8080"
  : "http://localhost:30081";
export const KEYCLOAK_REALM = "archestra";

/** OIDC client configuration for Keycloak */
export const KEYCLOAK_OIDC = {
  clientId: "archestra-oidc",
  clientSecret: "archestra-oidc-secret",
  issuer: `${KEYCLOAK_EXTERNAL_URL}/realms/${KEYCLOAK_REALM}`,
  discoveryEndpoint: `${KEYCLOAK_BACKEND_URL}/realms/${KEYCLOAK_REALM}/.well-known/openid-configuration`,
  authorizationEndpoint: `${KEYCLOAK_EXTERNAL_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/auth`,
  tokenEndpoint: `${KEYCLOAK_BACKEND_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`,
  jwksEndpoint: `${KEYCLOAK_BACKEND_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/certs`,
};

/** SAML configuration for Keycloak */
export const KEYCLOAK_SAML = {
  entityId: `${KEYCLOAK_EXTERNAL_URL}/realms/${KEYCLOAK_REALM}`,
  ssoUrl: `${KEYCLOAK_EXTERNAL_URL}/realms/${KEYCLOAK_REALM}/protocol/saml`,
};

/** Keycloak test user credentials (match Archestra admin for account linking) */
export const KC_TEST_USER = {
  username: ADMIN_EMAIL.split("@")[0],
  password: ADMIN_PASSWORD,
  email: ADMIN_EMAIL,
  name: "Admin User",
};

/** SSO domain - extracted from admin email for account linking */
export const SSO_DOMAIN = ADMIN_EMAIL.split("@")[1];

// =============================================================================
// MCP Server JWKS (example server for JWT propagation testing)
// =============================================================================

export const MCP_SERVER_JWKS_EXTERNAL_URL = "http://localhost:30082";
export const MCP_SERVER_JWKS_BACKEND_URL = IS_CI
  ? "http://e2e-tests-mcp-server-jwks:3456"
  : "http://localhost:30082";

/** Docker image for the JWKS MCP server (used for local K8s deployment tests) */
export const MCP_SERVER_JWKS_DOCKER_IMAGE =
  "europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/mcp-server-jwks-keycloak:0.0.1";

/**
 * Keycloak internal URL for use by K8s pods (MCP servers spawned by orchestrator).
 * In CI: pods and Keycloak are in the same namespace (default), so short service name works.
 * In local dev: MCP server pods run in archestra-dev namespace, Keycloak in default namespace,
 * so use FQDN for cross-namespace DNS resolution.
 */
export const KEYCLOAK_K8S_INTERNAL_URL = IS_CI
  ? "http://e2e-tests-keycloak:8080"
  : "http://e2e-tests-keycloak.default.svc.cluster.local:8080";
