/**
 * E2E tests for MCP Gateway JWKS credential resolution priority.
 *
 * Verifies the credential resolution behavior when a user authenticates
 * via an external IdP (JWKS) and the upstream MCP server has its own
 * credentials configured:
 *
 * 1. Upstream credentials should take priority over the caller's JWT
 * 2. When no upstream credentials exist, the JWT should be propagated as fallback
 *
 * Uses WireMock stubs (helm/e2e-tests/mappings/mcp-jwks-cred-priority-e2e-*.json)
 * that echo back the Authorization header received by the upstream server,
 * allowing us to verify exactly which token was sent.
 *
 * Prerequisites:
 * - Keycloak running (deployed via e2e Helm chart)
 * - WireMock running with jwks-cred-priority-e2e stubs loaded
 */
import {
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  WIREMOCK_INTERNAL_URL,
} from "../consts";
import { getKeycloakJwt } from "../utils";
import {
  callMcpTool,
  initializeMcpSession,
  makeApiRequest,
} from "../utils/mcp-gateway";
import { expect, test } from "./api-fixtures";

const WIREMOCK_MCP_URL = `${WIREMOCK_INTERNAL_URL}/mcp/jwks-cred-priority-e2e`;
const STATIC_TOKEN = "static-test-token-for-cred-priority-e2e";

test.describe("MCP Gateway - JWKS Credential Resolution Priority", () => {
  test("should prefer upstream server credentials over JWT propagation", async ({
    request,
    createAgent,
    deleteAgent,
    createIdentityProvider,
    deleteIdentityProvider,
    createMcpCatalogItem,
    deleteMcpCatalogItem,
    installMcpServer,
    uninstallMcpServer,
    waitForAgentTool,
  }) => {
    test.slow();

    // STEP 1: Get a JWT from Keycloak
    const jwt = await getKeycloakJwt();
    expect(jwt).toBeTruthy();
    expect(jwt.split(".")).toHaveLength(3);

    // STEP 2: Create identity provider with Keycloak OIDC config
    const providerName = `JwksCredPriority${Date.now()}`;
    const identityProviderId = await createIdentityProvider(
      request,
      providerName,
    );

    let profileId: string | undefined;
    let catalogId: string | undefined;
    let serverId: string | undefined;
    const catalogName = `jwks-cred-priority-${Date.now()}`;
    const echoAuthToolName = `${catalogName}${MCP_SERVER_TOOL_NAME_SEPARATOR}echo_auth`;

    try {
      // STEP 3: Create an MCP Gateway profile linked to the IdP
      const agentResponse = await createAgent(
        request,
        `JWKS Cred Priority E2E ${Date.now()}`,
        "personal",
      );
      const agent = await agentResponse.json();
      profileId = agent.id;
      const pid = profileId as string;

      await makeApiRequest({
        request,
        method: "put",
        urlSuffix: `/api/agents/${pid}`,
        data: {
          agentType: "mcp_gateway",
          identityProviderId,
        },
      });

      // STEP 4: Create remote catalog item pointing to WireMock
      const catalogResponse = await createMcpCatalogItem(request, {
        name: catalogName,
        description:
          "E2E test: JWKS credential resolution priority — upstream creds preferred",
        serverType: "remote",
        serverUrl: WIREMOCK_MCP_URL,
      });
      const catalogItem = await catalogResponse.json();
      catalogId = catalogItem.id;

      // STEP 5: Install server WITH a static token (stored as upstream credential)
      const installResponse = await installMcpServer(request, {
        name: catalogName,
        catalogId,
        accessToken: STATIC_TOKEN,
        agentIds: [pid],
      });
      const mcpServer = await installResponse.json();
      serverId = mcpServer.id;

      // STEP 6: Wait for tool discovery
      const agentTool = await waitForAgentTool(request, pid, echoAuthToolName, {
        maxAttempts: 30,
        delayMs: 2000,
      });
      expect(agentTool).toBeDefined();

      // STEP 7: Initialize MCP session with the external JWT
      await initializeMcpSession(request, {
        profileId: pid,
        token: jwt,
      });

      // STEP 8: Call echo_auth tool via MCP Gateway
      // The upstream WireMock server echoes back the Authorization header it received.
      // After the credential resolution priority fix, the upstream should receive
      // the static token (stored credential), NOT the Keycloak JWT.
      const result = await callMcpTool(request, {
        profileId: pid,
        token: jwt,
        toolName: echoAuthToolName,
        timeoutMs: 30000,
      });

      expect(result.content).toBeDefined();
      expect(result.content.length).toBeGreaterThan(0);

      const responseText = result.content[0].text;
      expect(responseText).toBeDefined();

      // Verify the upstream server received the STATIC token, not the JWT
      expect(responseText).toContain(`Bearer ${STATIC_TOKEN}`);
      expect(responseText).not.toContain(jwt);
    } finally {
      if (profileId) {
        await deleteAgent(request, profileId);
      }
      if (serverId) {
        await uninstallMcpServer(request, serverId);
      }
      if (catalogId) {
        await deleteMcpCatalogItem(request, catalogId);
      }
      await deleteIdentityProvider(request, identityProviderId);
    }
  });

  test("should propagate JWT as fallback when no upstream credentials exist", async ({
    request,
    createAgent,
    deleteAgent,
    createIdentityProvider,
    deleteIdentityProvider,
    createMcpCatalogItem,
    deleteMcpCatalogItem,
    installMcpServer,
    uninstallMcpServer,
    waitForAgentTool,
  }) => {
    test.slow();

    // STEP 1: Get a JWT from Keycloak
    const jwt = await getKeycloakJwt();
    expect(jwt).toBeTruthy();
    expect(jwt.split(".")).toHaveLength(3);

    // STEP 2: Create identity provider with Keycloak OIDC config
    const providerName = `JwksJwtFallback${Date.now()}`;
    const identityProviderId = await createIdentityProvider(
      request,
      providerName,
    );

    let profileId: string | undefined;
    let catalogId: string | undefined;
    let serverId: string | undefined;
    const catalogName = `jwks-jwt-fallback-${Date.now()}`;
    const echoAuthToolName = `${catalogName}${MCP_SERVER_TOOL_NAME_SEPARATOR}echo_auth`;

    try {
      // STEP 3: Create an MCP Gateway profile linked to the IdP
      const agentResponse = await createAgent(
        request,
        `JWKS JWT Fallback E2E ${Date.now()}`,
        "personal",
      );
      const agent = await agentResponse.json();
      profileId = agent.id;
      const pid = profileId as string;

      await makeApiRequest({
        request,
        method: "put",
        urlSuffix: `/api/agents/${pid}`,
        data: {
          agentType: "mcp_gateway",
          identityProviderId,
        },
      });

      // STEP 4: Create remote catalog item pointing to WireMock
      const catalogResponse = await createMcpCatalogItem(request, {
        name: catalogName,
        description:
          "E2E test: JWKS JWT propagation fallback — no upstream credentials",
        serverType: "remote",
        serverUrl: WIREMOCK_MCP_URL,
      });
      const catalogItem = await catalogResponse.json();
      catalogId = catalogItem.id;

      // STEP 5: Install server WITHOUT credentials (no accessToken)
      // WireMock stubs don't require auth, so tool discovery works without credentials
      const installResponse = await installMcpServer(request, {
        name: catalogName,
        catalogId,
        agentIds: [pid],
      });
      const mcpServer = await installResponse.json();
      serverId = mcpServer.id;

      // STEP 6: Wait for tool discovery
      const agentTool = await waitForAgentTool(request, pid, echoAuthToolName, {
        maxAttempts: 30,
        delayMs: 2000,
      });
      expect(agentTool).toBeDefined();

      // STEP 7: Initialize MCP session with the external JWT
      await initializeMcpSession(request, {
        profileId: pid,
        token: jwt,
      });

      // STEP 8: Call echo_auth tool via MCP Gateway
      // Without upstream credentials, the gateway should propagate the Keycloak JWT
      // to the upstream server as a fallback (end-to-end JWKS pattern).
      const result = await callMcpTool(request, {
        profileId: pid,
        token: jwt,
        toolName: echoAuthToolName,
        timeoutMs: 30000,
      });

      expect(result.content).toBeDefined();
      expect(result.content.length).toBeGreaterThan(0);

      const responseText = result.content[0].text;
      expect(responseText).toBeDefined();

      // Verify the upstream server received a JWT (three dot-separated base64url segments)
      expect(responseText).toContain("RECEIVED_AUTH=Bearer ");
      const receivedToken = responseText?.replace("RECEIVED_AUTH=Bearer ", "");
      expect(receivedToken?.split(".")).toHaveLength(3);
    } finally {
      if (profileId) {
        await deleteAgent(request, profileId);
      }
      if (serverId) {
        await uninstallMcpServer(request, serverId);
      }
      if (catalogId) {
        await deleteMcpCatalogItem(request, catalogId);
      }
      await deleteIdentityProvider(request, identityProviderId);
    }
  });
});
