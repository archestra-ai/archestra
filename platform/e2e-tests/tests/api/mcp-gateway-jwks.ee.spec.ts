/**
 * E2E tests for MCP Gateway authentication via external IdP JWKS.
 *
 * Tests the flow:
 * 1. Create SSO provider with OIDC config (Keycloak)
 * 2. Create MCP Gateway profile linked to the IdP
 * 3. Obtain JWT from Keycloak (direct grant)
 * 4. Authenticate to MCP Gateway using the JWT
 * 5. Verify tool calls succeed and external identity appears in audit logs
 */
import {
  API_BASE_URL,
  IS_CI,
  MCP_GATEWAY_URL_SUFFIX,
  UI_BASE_URL,
} from "../../consts";
import { expect, test } from "./fixtures";
import {
  assignArchestraToolsToProfile,
  callMcpTool,
  initializeMcpSession,
  listMcpTools,
  makeApiRequest,
  makeMcpGatewayRequestHeaders,
} from "./mcp-gateway-utils";

// =============================================================================
// Keycloak Configuration (matches helm/e2e-tests/values.yaml)
// =============================================================================

const KEYCLOAK_EXTERNAL_URL = "http://localhost:30081";
const KEYCLOAK_BACKEND_URL = IS_CI
  ? "http://e2e-tests-keycloak:8080"
  : "http://localhost:30081";
const KEYCLOAK_REALM = "archestra";

const KEYCLOAK_OIDC = {
  clientId: "archestra-oidc",
  clientSecret: "archestra-oidc-secret",
  issuer: `${KEYCLOAK_EXTERNAL_URL}/realms/${KEYCLOAK_REALM}`,
  discoveryEndpoint: `${KEYCLOAK_BACKEND_URL}/realms/${KEYCLOAK_REALM}/.well-known/openid-configuration`,
  tokenEndpoint: `${KEYCLOAK_BACKEND_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`,
  jwksEndpoint: `${KEYCLOAK_BACKEND_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/certs`,
};

// Test user in Keycloak (matches helm/e2e-tests/values.yaml)
const KC_TEST_USER = {
  username: "admin",
  password: "password",
  email: "admin@example.com",
  name: "Admin User",
};

// =============================================================================
// Helpers
// =============================================================================

/**
 * Get a JWT access token from Keycloak using the resource owner password
 * credentials grant (direct access grant).
 */
async function getKeycloakJwt(): Promise<string> {
  const response = await fetch(KEYCLOAK_OIDC.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: KEYCLOAK_OIDC.clientId,
      client_secret: KEYCLOAK_OIDC.clientSecret,
      username: KC_TEST_USER.username,
      password: KC_TEST_USER.password,
      scope: "openid",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Keycloak token request failed: ${response.status} ${text}`,
    );
  }

  const data = (await response.json()) as { access_token: string };
  return data.access_token;
}

/**
 * Create an SSO provider via the API with OIDC config pointing to Keycloak.
 * Returns the created provider's ID.
 */
async function createSsoProvider(
  request: Parameters<typeof makeApiRequest>[0]["request"],
  providerId: string,
): Promise<string> {
  const response = await makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/sso-providers",
    data: {
      providerId,
      issuer: KEYCLOAK_OIDC.issuer,
      domain: "jwks-test.example.com",
      oidcConfig: {
        issuer: KEYCLOAK_OIDC.issuer,
        pkce: true,
        clientId: KEYCLOAK_OIDC.clientId,
        clientSecret: KEYCLOAK_OIDC.clientSecret,
        discoveryEndpoint: KEYCLOAK_OIDC.discoveryEndpoint,
        jwksEndpoint: KEYCLOAK_OIDC.jwksEndpoint,
      },
    },
  });

  const provider = await response.json();
  return provider.id;
}

/**
 * Delete an SSO provider via the API.
 */
async function deleteSsoProvider(
  request: Parameters<typeof makeApiRequest>[0]["request"],
  id: string,
): Promise<void> {
  await makeApiRequest({
    request,
    method: "delete",
    urlSuffix: `/api/sso-providers/${id}`,
    ignoreStatusCheck: true,
  });
}

// =============================================================================
// Tests
// =============================================================================

test.describe("MCP Gateway - External IdP JWKS Authentication", () => {
  test("should authenticate with external IdP JWT, call tools, and log external identity", async ({
    request,
    createAgent,
    deleteAgent,
  }) => {
    test.slow();

    // STEP 1: Verify Keycloak is reachable and get a test JWT
    const jwt = await getKeycloakJwt();
    expect(jwt).toBeTruthy();
    expect(jwt.split(".")).toHaveLength(3);

    // STEP 2: Create SSO provider with Keycloak OIDC config
    const providerName = `JwksTest${Date.now()}`;
    const ssoProviderId = await createSsoProvider(request, providerName);

    let profileId: string | undefined;
    try {
      // STEP 3: Create an MCP Gateway profile linked to the IdP
      const agentResponse = await createAgent(
        request,
        `JWKS E2E Test ${Date.now()}`,
      );
      const agent = await agentResponse.json();
      profileId = agent.id;

      // Link the IdP to the profile
      await makeApiRequest({
        request,
        method: "put",
        urlSuffix: `/api/agents/${profileId}`,
        data: { ssoProviderId },
      });

      // STEP 4: Assign Archestra tools to the profile
      await assignArchestraToolsToProfile(request, profileId);

      // STEP 5: Initialize MCP session with the external JWT
      await initializeMcpSession(request, {
        profileId,
        token: jwt,
      });

      // STEP 6: List tools - should succeed with JWKS auth
      const tools = await listMcpTools(request, {
        profileId,
        token: jwt,
      });
      expect(tools.length).toBeGreaterThan(0);

      // Verify archestra tools are present
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain("archestra__whoami");

      // STEP 7: Call whoami tool - should return external identity info
      const result = await callMcpTool(request, {
        profileId,
        token: jwt,
        toolName: "archestra__whoami",
      });
      expect(result.content).toBeDefined();
      expect(result.content.length).toBeGreaterThan(0);

      // STEP 8: Verify audit log contains external identity
      // Wait briefly for the tool call to be logged
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const logsResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/mcp-tool-calls?agentId=${profileId}&limit=10`,
      });
      const logsData = await logsResponse.json();
      expect(logsData.data.length).toBeGreaterThan(0);

      // Find a log entry with external_idp auth method (unique to our test)
      const externalIdpLog = logsData.data.find(
        (log: { authMethod: string | null }) =>
          log.authMethod === "external_idp",
      );
      expect(externalIdpLog).toBeDefined();

      // Verify external identity is stored
      expect(externalIdpLog.externalIdentity).toBeDefined();
      expect(externalIdpLog.externalIdentity.sub).toBeTruthy();
      expect(externalIdpLog.externalIdentity.email).toBe(KC_TEST_USER.email);
      expect(externalIdpLog.externalIdentity.idpName).toBe(providerName);
    } finally {
      // Cleanup
      if (profileId) {
        await deleteAgent(request, profileId);
      }
      await deleteSsoProvider(request, ssoProviderId);
    }
  });

  test("should reject invalid JWT with 401", async ({
    request,
    createAgent,
    deleteAgent,
  }) => {
    // Create SSO provider and profile
    const providerName = `JwksReject${Date.now()}`;
    const ssoProviderId = await createSsoProvider(request, providerName);

    let profileId: string | undefined;
    try {
      const agentResponse = await createAgent(
        request,
        `JWKS Reject Test ${Date.now()}`,
      );
      const agent = await agentResponse.json();
      profileId = agent.id;

      // Link the IdP to the profile
      await makeApiRequest({
        request,
        method: "put",
        urlSuffix: `/api/agents/${profileId}`,
        data: { ssoProviderId },
      });

      // Try to call MCP Gateway with an invalid JWT
      const urlSuffix = `${MCP_GATEWAY_URL_SUFFIX}/${profileId}`;
      const response = await request.post(`${API_BASE_URL}${urlSuffix}`, {
        headers: makeMcpGatewayRequestHeaders("invalid.jwt.token"),
        data: {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            clientInfo: { name: "e2e-test-client", version: "1.0.0" },
          },
        },
      });

      expect(response.status()).toBe(401);
    } finally {
      if (profileId) {
        await deleteAgent(request, profileId);
      }
      await deleteSsoProvider(request, ssoProviderId);
    }
  });

  test("should fall through to archestra token when profile has no IdP", async ({
    request,
    createAgent,
    deleteAgent,
  }) => {
    // Create a profile WITHOUT an IdP linked
    const agentResponse = await createAgent(
      request,
      `No IdP Test ${Date.now()}`,
    );
    const agent = await agentResponse.json();
    const profileId = agent.id;

    try {
      // Assign Archestra tools
      await assignArchestraToolsToProfile(request, profileId);

      // Get org token - should work since no IdP is configured
      const tokensResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/tokens",
      });
      const tokensData = await tokensResponse.json();
      const orgToken = tokensData.tokens.find(
        (t: { isOrganizationToken: boolean }) => t.isOrganizationToken,
      );
      const tokenValueResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/tokens/${orgToken.id}/value`,
      });
      const { value: archestraToken } = await tokenValueResponse.json();

      // Initialize and list tools with archestra token
      await initializeMcpSession(request, {
        profileId,
        token: archestraToken,
      });

      const tools = await listMcpTools(request, {
        profileId,
        token: archestraToken,
      });
      expect(tools.length).toBeGreaterThan(0);
    } finally {
      await deleteAgent(request, profileId);
    }
  });
});
