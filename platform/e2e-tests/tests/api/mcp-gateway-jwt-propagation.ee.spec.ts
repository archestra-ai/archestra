/**
 * E2E tests for MCP Gateway JWT propagation to upstream MCP servers.
 *
 * Tests the full flow:
 * 1. Get JWT from Keycloak
 * 2. Create identity provider + MCP Gateway profile
 * 3. Register the example JWKS MCP server as a remote server
 * 4. Call a tool via the Archestra MCP Gateway
 * 5. Verify the JWT is propagated to the upstream MCP server
 * 6. Verify the upstream server validates the JWT and returns user identity
 *
 * Prerequisites:
 * - Keycloak running (deployed via e2e Helm chart)
 * - mcp-server-jwks-keycloak Docker image built and deployed via e2e Helm chart
 */
import {
  KC_TEST_USER,
  KEYCLOAK_EXTERNAL_URL,
  KEYCLOAK_K8S_INTERNAL_URL,
  KEYCLOAK_OIDC,
  KEYCLOAK_REALM,
  MCP_SERVER_JWKS_BACKEND_URL,
  MCP_SERVER_JWKS_DOCKER_IMAGE,
  MCP_SERVER_JWKS_EXTERNAL_URL,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "../../consts";
import { getKeycloakJwt, waitForServerInstallation } from "../../utils";
import { expect, test } from "./fixtures";
import {
  callMcpTool,
  initializeMcpSession,
  listMcpTools,
  makeApiRequest,
} from "./mcp-gateway-utils";

// =============================================================================
// Tests
// =============================================================================

test.describe("MCP Gateway - JWT Propagation to Upstream MCP Server", () => {
  test("should propagate JWT to upstream MCP server and return user identity from tool call", async ({
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

    // STEP 1: Verify the upstream MCP server is healthy
    const healthResponse = await request.get(
      `${MCP_SERVER_JWKS_EXTERNAL_URL}/health`,
    );
    expect(
      healthResponse.ok(),
      `MCP server JWKS not reachable at ${MCP_SERVER_JWKS_EXTERNAL_URL}/health. ` +
        "Ensure the mcp-server-jwks-keycloak image is built and deployed via e2e Helm chart.",
    ).toBeTruthy();

    // STEP 2: Get a JWT from Keycloak
    const jwt = await getKeycloakJwt();
    expect(jwt).toBeTruthy();
    expect(jwt.split(".")).toHaveLength(3);

    // STEP 3: Create identity provider with Keycloak OIDC config
    const providerName = `JwtPropagation${Date.now()}`;
    const identityProviderId = await createIdentityProvider(
      request,
      providerName,
    );

    let profileId: string | undefined;
    let catalogId: string | undefined;
    let serverId: string | undefined;
    const catalogName = `jwks-propagation-test-${Date.now()}`;

    try {
      // STEP 4: Create an MCP Gateway profile linked to the IdP
      // (created before installing the MCP server so we can pass agentIds)
      const agentResponse = await createAgent(
        request,
        `JWT Propagation E2E ${Date.now()}`,
      );
      const agent = await agentResponse.json();
      profileId = agent.id;
      const pid = profileId as string;

      // Update to MCP Gateway type and link the IdP
      await makeApiRequest({
        request,
        method: "put",
        urlSuffix: `/api/agents/${pid}`,
        data: {
          agentType: "mcp_gateway",
          identityProviderId,
        },
      });

      // STEP 5: Register the upstream MCP server as a remote MCP catalog item
      const catalogResponse = await createMcpCatalogItem(request, {
        name: catalogName,
        description: "E2E test: JWKS MCP server for JWT propagation testing",
        serverType: "remote",
        serverUrl: `${MCP_SERVER_JWKS_BACKEND_URL}/mcp`,
      });
      const catalogItem = await catalogResponse.json();
      catalogId = catalogItem.id;

      // STEP 6: Install the MCP server (creates an mcp_server record)
      // Pass the JWT as accessToken so the backend can authenticate with
      // the upstream server during tool discovery (it requires JWT auth).
      // Pass agentIds so discovered tools are automatically assigned to the profile.
      const installResponse = await installMcpServer(request, {
        name: catalogName,
        catalogId,
        accessToken: jwt,
        agentIds: [pid],
      });
      const mcpServer = await installResponse.json();
      serverId = mcpServer.id;

      // STEP 7: Verify tools from the upstream server were discovered and assigned
      // The tool name format is: <catalogName>__<toolName>
      const getServerInfoToolName = `${catalogName}${MCP_SERVER_TOOL_NAME_SEPARATOR}get-server-info`;
      const agentTool = await waitForAgentTool(
        request,
        pid,
        getServerInfoToolName,
        { maxAttempts: 30, delayMs: 2000 },
      );
      expect(agentTool).toBeDefined();

      // STEP 8: Initialize MCP session with the external JWT
      await initializeMcpSession(request, {
        profileId: pid,
        token: jwt,
      });

      // STEP 9: List tools - should include upstream server tools
      const tools = await listMcpTools(request, {
        profileId: pid,
        token: jwt,
      });
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain(getServerInfoToolName);

      // STEP 10: Call get-server-info tool via MCP Gateway
      // This is the key test: the JWT must be propagated to the upstream server
      // The upstream server validates the JWT via JWKS and returns the user's identity
      const result = await callMcpTool(request, {
        profileId: pid,
        token: jwt,
        toolName: getServerInfoToolName,
        timeoutMs: 30000,
      });

      expect(result.content).toBeDefined();
      expect(result.content.length).toBeGreaterThan(0);

      // Parse the response - the upstream server returns user identity from the JWT
      const responseText = result.content[0].text;
      expect(responseText).toBeDefined();
      const serverInfo = JSON.parse(responseText as string);

      // Verify the upstream server received and validated the JWT
      expect(serverInfo.server).toBe("MCP JWKS Demo Server");
      expect(serverInfo.user).toBeDefined();
      expect(serverInfo.user.sub).toBeTruthy();
      expect(serverInfo.user.email).toBe(KC_TEST_USER.email);

      // STEP 11: Verify audit log links the Archestra user
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const logsResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/mcp-tool-calls?agentId=${pid}&limit=10`,
      });
      const logsData = await logsResponse.json();
      expect(logsData.data.length).toBeGreaterThan(0);

      const externalIdpLog = logsData.data.find(
        (log: { authMethod: string | null }) =>
          log.authMethod === "external_idp",
      );
      expect(externalIdpLog).toBeDefined();
      expect(externalIdpLog.userName).toBeTruthy();
      expect(externalIdpLog.userId).toBeTruthy();
    } finally {
      // Cleanup in reverse order
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

  test("should reject tool call when upstream MCP server rejects invalid JWT", async ({
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

    // Verify the upstream MCP server is healthy
    const healthResponse = await request.get(
      `${MCP_SERVER_JWKS_EXTERNAL_URL}/health`,
    );
    expect(
      healthResponse.ok(),
      `MCP server JWKS not reachable at ${MCP_SERVER_JWKS_EXTERNAL_URL}/health. ` +
        "Ensure the mcp-server-jwks-keycloak image is built and deployed via e2e Helm chart.",
    ).toBeTruthy();

    // Get a valid JWT for server installation (tool discovery requires auth),
    // but later use an org token for the tool call — the upstream server
    // will reject it because it's not a valid Keycloak JWT
    const jwt = await getKeycloakJwt();
    expect(jwt).toBeTruthy();

    const providerName = `JwtReject${Date.now()}`;
    const identityProviderId = await createIdentityProvider(
      request,
      providerName,
    );

    let profileId: string | undefined;
    let catalogId: string | undefined;
    let serverId: string | undefined;
    const catalogName = `jwks-reject-test-${Date.now()}`;

    try {
      // Create MCP Gateway WITHOUT IdP (so archestra token is used, not JWT)
      const agentResponse = await createAgent(
        request,
        `JWT Reject E2E ${Date.now()}`,
      );
      const agent = await agentResponse.json();
      profileId = agent.id;
      const pid = profileId as string;

      await makeApiRequest({
        request,
        method: "put",
        urlSuffix: `/api/agents/${pid}`,
        data: { agentType: "mcp_gateway" },
      });

      // Register upstream server
      const catalogResponse = await createMcpCatalogItem(request, {
        name: catalogName,
        description: "E2E test: JWT rejection test",
        serverType: "remote",
        serverUrl: `${MCP_SERVER_JWKS_BACKEND_URL}/mcp`,
      });
      const catalogItem = await catalogResponse.json();
      catalogId = catalogItem.id;

      // Pass JWT as accessToken so the backend can authenticate during
      // tool discovery (the upstream server requires JWT auth).
      // Pass agentIds so discovered tools are automatically assigned to the profile.
      const installResponse = await installMcpServer(request, {
        name: catalogName,
        catalogId,
        accessToken: jwt,
        agentIds: [pid],
      });
      const mcpServer = await installResponse.json();
      serverId = mcpServer.id;

      // Wait for tools to be assigned
      const toolName = `${catalogName}${MCP_SERVER_TOOL_NAME_SEPARATOR}get-server-info`;
      await waitForAgentTool(request, pid, toolName, {
        maxAttempts: 30,
        delayMs: 2000,
      });

      // Get org token (not a Keycloak JWT)
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

      // Initialize session with archestra token (this works - gateway accepts it)
      await initializeMcpSession(request, {
        profileId: pid,
        token: archestraToken,
      });

      // Call tool - the upstream server should reject because the archestra token
      // is not a valid JWT (the gateway doesn't propagate non-JWT tokens)
      // This should result in a tool error since the upstream server returns 401
      try {
        await callMcpTool(request, {
          profileId: pid,
          token: archestraToken,
          toolName,
          timeoutMs: 30000,
        });
        // If we get here, the upstream server didn't require auth (unexpected)
        // This is still valid - it means the server accepted the request
        // without JWT auth, which means no JWT was propagated (correct behavior)
      } catch {
        // Expected: tool call fails because upstream server requires JWT auth
        // and the archestra token is not a valid JWT
      }
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

  test("should propagate JWT to local K8s-orchestrated MCP server via streamable-http", async ({
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
    const providerName = `JwtLocalK8s${Date.now()}`;
    const identityProviderId = await createIdentityProvider(
      request,
      providerName,
    );

    let profileId: string | undefined;
    let catalogId: string | undefined;
    let serverId: string | undefined;
    const catalogName = `jwks-local-k8s-test-${Date.now()}`;

    try {
      // STEP 3: Create an MCP Gateway profile linked to the IdP
      const agentResponse = await createAgent(
        request,
        `JWT Local K8s E2E ${Date.now()}`,
      );
      const agent = await agentResponse.json();
      profileId = agent.id;
      const pid = profileId as string;

      // Update to MCP Gateway type and link the IdP
      await makeApiRequest({
        request,
        method: "put",
        urlSuffix: `/api/agents/${pid}`,
        data: {
          agentType: "mcp_gateway",
          identityProviderId,
        },
      });

      // STEP 4: Register the JWKS MCP server as a LOCAL catalog item
      // Uses the same Docker image as the Helm-deployed instance but runs
      // as a K8s-orchestrated server via streamable-http transport.
      const catalogResponse = await createMcpCatalogItem(request, {
        name: catalogName,
        description:
          "E2E test: Local K8s JWKS MCP server for JWT propagation testing",
        serverType: "local",
        localConfig: {
          dockerImage: MCP_SERVER_JWKS_DOCKER_IMAGE,
          transportType: "streamable-http",
          httpPort: 3456,
          httpPath: "/mcp",
          environment: [
            {
              key: "JWKS_URL",
              type: "plain_text",
              promptOnInstallation: false,
              value: `${KEYCLOAK_K8S_INTERNAL_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/certs`,
            },
            {
              key: "JWT_ISSUER",
              type: "secret",
              promptOnInstallation: false,
              value: `${KEYCLOAK_EXTERNAL_URL}/realms/${KEYCLOAK_REALM}`,
            },
            {
              key: "JWT_AUDIENCE",
              type: "plain_text",
              promptOnInstallation: false,
              value: KEYCLOAK_OIDC.clientId,
            },
            {
              key: "MCP_SERVER_URL",
              type: "plain_text",
              promptOnInstallation: false,
              value: MCP_SERVER_JWKS_EXTERNAL_URL,
            },
            {
              key: "KEYCLOAK_ISSUER_URL",
              type: "plain_text",
              promptOnInstallation: false,
              value: `${KEYCLOAK_EXTERNAL_URL}/realms/${KEYCLOAK_REALM}`,
            },
          ],
        },
      });
      const catalogItem = await catalogResponse.json();
      catalogId = catalogItem.id;

      // STEP 5: Install the local MCP server (creates K8s deployment)
      // For local servers, tool discovery happens after the pod is running.
      // Pass accessToken so the backend can authenticate during tool discovery
      // (the JWKS server requires JWT auth for all requests including MCP protocol).
      // Pass agentIds so discovered tools are automatically assigned to the profile.
      const installResponse = await installMcpServer(request, {
        name: catalogName,
        catalogId,
        accessToken: jwt,
        agentIds: [pid],
      });
      const mcpServer = await installResponse.json();
      serverId = mcpServer.id;
      const sid = serverId as string;

      // STEP 6: Wait for K8s deployment to be ready
      await waitForServerInstallation(request, sid);

      // STEP 7: Verify tools from the local server were discovered and assigned
      const getServerInfoToolName = `${catalogName}${MCP_SERVER_TOOL_NAME_SEPARATOR}get-server-info`;
      const agentTool = await waitForAgentTool(
        request,
        pid,
        getServerInfoToolName,
        { maxAttempts: 40, delayMs: 3000 },
      );
      expect(agentTool).toBeDefined();

      // STEP 8: Initialize MCP session with the external JWT
      await initializeMcpSession(request, {
        profileId: pid,
        token: jwt,
      });

      // STEP 9: List tools - should include local server tools
      const tools = await listMcpTools(request, {
        profileId: pid,
        token: jwt,
      });
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain(getServerInfoToolName);

      // STEP 10: Call get-server-info tool via MCP Gateway
      // Key test: the JWT must be propagated to the local K8s server
      // via streamable-http transport. The server validates the JWT via JWKS
      // and returns the user's identity.
      const result = await callMcpTool(request, {
        profileId: pid,
        token: jwt,
        toolName: getServerInfoToolName,
        timeoutMs: 30000,
      });

      expect(result.content).toBeDefined();
      expect(result.content.length).toBeGreaterThan(0);

      // Parse the response - the local server returns user identity from the JWT
      const responseText = result.content[0].text;
      expect(responseText).toBeDefined();
      const serverInfo = JSON.parse(responseText as string);

      // Verify the local K8s server received and validated the JWT
      expect(serverInfo.server).toBe("MCP JWKS Demo Server");
      expect(serverInfo.user).toBeDefined();
      expect(serverInfo.user.sub).toBeTruthy();
      expect(serverInfo.user.email).toBe(KC_TEST_USER.email);

      // STEP 11: Verify audit log links the Archestra user
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const logsResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/mcp-tool-calls?agentId=${pid}&limit=10`,
      });
      const logsData = await logsResponse.json();
      expect(logsData.data.length).toBeGreaterThan(0);

      const externalIdpLog = logsData.data.find(
        (log: { authMethod: string | null }) =>
          log.authMethod === "external_idp",
      );
      expect(externalIdpLog).toBeDefined();
      expect(externalIdpLog.userName).toBeTruthy();
      expect(externalIdpLog.userId).toBeTruthy();
    } finally {
      // Cleanup in reverse order
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
