/**
 * E2E tests for MCP Gateway authentication via external IdP JWKS.
 *
 * Tests the flow:
 * 1. Create identity provider with OIDC config (Keycloak)
 * 2. Create MCP Gateway profile linked to the IdP
 * 3. Obtain JWT from Keycloak (direct grant)
 * 4. Authenticate to MCP Gateway using the JWT
 * 5. Verify tool calls succeed and the Archestra user is linked in audit logs
 */
import { API_BASE_URL, MCP_GATEWAY_URL_SUFFIX, SSO_DOMAIN } from "../consts";
import { getKeycloakJwt } from "../utils";
import {
  assignArchestraToolsToProfile,
  callMcpTool,
  initializeMcpSession,
  listMcpTools,
  makeApiRequest,
  makeMcpGatewayRequestHeaders,
  waitForGatewayIdentityProviderReady,
} from "../utils/mcp-gateway";
import { expect, test } from "./api-fixtures";

// =============================================================================
// Tests
// =============================================================================

test.describe("MCP Gateway - External IdP JWKS Authentication", () => {
  test("should authenticate with external IdP JWT, call tools, and log external identity", async ({
    request,
    deleteAgent,
    createIdentityProvider,
    deleteIdentityProvider,
  }) => {
    test.slow();

    // STEP 1: Verify Keycloak is reachable and get a test JWT
    const jwt = await getKeycloakJwt();
    expect(jwt).toBeTruthy();
    expect(jwt.split(".")).toHaveLength(3);

    // STEP 2: Create identity provider with Keycloak OIDC config
    const providerName = `JwksTest${Date.now()}`;
    const identityProviderId = await createIdentityProvider(
      request,
      providerName,
      { domain: SSO_DOMAIN },
    );

    let profileId: string | undefined;
    try {
      // STEP 3: Create an MCP Gateway profile with the IdP linked directly.
      // This matches the more reliable llm-proxy JWKS flow and avoids a
      // separate update race in CI.
      const agentResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/agents",
        data: {
          name: `JWKS E2E Test ${Date.now()}`,
          teams: [],
          scope: "org",
          agentType: "mcp_gateway",
          identityProviderId,
        },
      });
      const agent = (await agentResponse.json()) as { id: string };
      profileId = agent.id;
      const pid = profileId;

      await waitForGatewayIdentityProviderReady({
        request,
        profileId: pid,
        identityProviderId,
        agentType: "mcp_gateway",
      });

      // STEP 4: Assign Archestra tools to the profile
      await assignArchestraToolsToProfile(request, pid);

      // STEP 5: Wait for IdP linkage/tool assignments to settle before using the
      // external JWT against the gateway. This avoids transient 401s in CI where
      // the profile update is visible before the auth path is fully ready.
      const tools = await waitForExternalJwtGatewayReady({
        request,
        profileId: pid,
        token: jwt,
      });
      expect(tools.length).toBeGreaterThan(0);

      // Verify archestra tools are present
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain("archestra__whoami");

      // STEP 7: Call whoami tool - should return external identity info
      const result = await callMcpTool(request, {
        profileId: pid,
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

      // Verify user is linked (external IdP users are matched to Archestra users)
      expect(externalIdpLog.userName).toBeTruthy();
      expect(externalIdpLog.userId).toBeTruthy();
    } finally {
      // Cleanup
      if (profileId) {
        await deleteAgent(request, profileId);
      }
      await deleteIdentityProvider(request, identityProviderId);
    }
  });

  test("should reject invalid JWT with 401", async ({
    request,
    deleteAgent,
    createIdentityProvider,
    deleteIdentityProvider,
  }) => {
    // Create identity provider and profile
    const providerName = `JwksReject${Date.now()}`;
    const identityProviderId = await createIdentityProvider(
      request,
      providerName,
      { domain: SSO_DOMAIN },
    );

    let profileId: string | undefined;
    try {
      const agentResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/agents",
        data: {
          name: `JWKS Reject Test ${Date.now()}`,
          teams: [],
          scope: "org",
          agentType: "mcp_gateway",
          identityProviderId,
        },
      });
      const agent = (await agentResponse.json()) as { id: string };
      profileId = agent.id;
      await waitForGatewayIdentityProviderReady({
        request,
        profileId,
        identityProviderId,
        agentType: "mcp_gateway",
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
      await deleteIdentityProvider(request, identityProviderId);
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
      "personal",
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

async function waitForExternalJwtGatewayReady(params: {
  request: Parameters<typeof initializeMcpSession>[0];
  profileId: string;
  token: string;
}) {
  let lastError: unknown;

  for (const delayMs of [
    0, 500, 1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000,
  ]) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    try {
      await initializeMcpSession(params.request, {
        profileId: params.profileId,
        token: params.token,
      });

      const tools = await listMcpTools(params.request, {
        profileId: params.profileId,
        token: params.token,
      });

      if (tools.length > 0) {
        return tools;
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw (
    lastError ??
    new Error("MCP Gateway did not become ready for external JWT auth")
  );
}
