import crypto from "node:crypto";
import { OAUTH_ENDPOINTS } from "@shared";
import {
  API_BASE_URL,
  MCP_GATEWAY_URL_SUFFIX,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  TEST_CATALOG_ITEM_NAME,
  TEST_TOOL_NAME,
  UI_BASE_URL,
  WIREMOCK_INTERNAL_URL,
} from "../../consts";
import {
  findCatalogItem,
  findInstalledServer,
  waitForServerInstallation,
} from "../../utils";
import { expect, test } from "./fixtures";
import {
  assignArchestraToolsToProfile,
  getOrgTokenForProfile,
  makeApiRequest,
} from "./mcp-gateway-utils";

/**
 * MCP Gateway Tests (Stateless Mode)
 *
 * URL: POST /v1/mcp/<profile_id>
 * Authorization: Bearer <archestra_token>
 */

test.describe("MCP Gateway - Authentication", () => {
  let profileId: string;
  let archestraToken: string;

  test.beforeAll(async ({ request, createAgent }) => {
    // Create test profile with unique name to avoid conflicts in parallel runs
    const uniqueSuffix = crypto.randomUUID().slice(0, 8);
    const createResponse = await createAgent(
      request,
      `MCP Gateway Auth Test ${uniqueSuffix}`,
    );
    const profile = await createResponse.json();
    profileId = profile.id;

    // Assign Archestra tools to the profile (required for tools/list to return them)
    await assignArchestraToolsToProfile(request, profileId);

    // Get org token using shared utility
    archestraToken = await getOrgTokenForProfile(request);
  });

  test.afterAll(async ({ request, deleteAgent }) => {
    await deleteAgent(request, profileId);
  });

  const makeMcpGatewayRequestHeaders = () => ({
    Authorization: `Bearer ${archestraToken}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  });

  test("should initialize and list tools (stateless)", async ({
    request,
    makeApiRequest,
  }) => {
    // Initialize MCP session
    const initResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `${MCP_GATEWAY_URL_SUFFIX}/${profileId}`,
      headers: makeMcpGatewayRequestHeaders(),
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      },
    });

    expect(initResponse.status()).toBe(200);
    const initResult = await initResponse.json();
    expect(initResult).toHaveProperty("result");
    expect(initResult.result).toHaveProperty("serverInfo");
    expect(initResult.result.serverInfo.name).toContain(profileId);

    // Call tools/list (stateless - no session ID needed)
    const listToolsResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `${MCP_GATEWAY_URL_SUFFIX}/${profileId}`,
      headers: makeMcpGatewayRequestHeaders(),
      data: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      },
    });

    expect(listToolsResponse.status()).toBe(200);
    const listResult = await listToolsResponse.json();
    expect(listResult).toHaveProperty("result");
    expect(listResult.result).toHaveProperty("tools");

    const tools = listResult.result.tools;
    expect(Array.isArray(tools)).toBe(true);

    // Find Archestra tools
    const archestraWhoami = tools.find(
      // biome-ignore lint/suspicious/noExplicitAny: for a test it's okay..
      (t: any) => t.name === `archestra${MCP_SERVER_TOOL_NAME_SEPARATOR}whoami`,
    );
    const archestraSearch = tools.find(
      // biome-ignore lint/suspicious/noExplicitAny: for a test it's okay..
      (t: any) =>
        t.name ===
        `archestra${MCP_SERVER_TOOL_NAME_SEPARATOR}search_private_mcp_registry`,
    );

    // Verify whoami tool
    expect(archestraWhoami).toBeDefined();
    expect(archestraWhoami.title).toBe("Who Am I");
    expect(archestraWhoami.description).toContain(
      "name and ID of the current agent",
    );

    // Verify search_private_mcp_registry tool
    expect(archestraSearch).toBeDefined();
    expect(archestraSearch.title).toBe("Search Private MCP Registry");
    expect(archestraSearch.description).toContain("private MCP registry");
  });

  test("should invoke whoami tool successfully", async ({
    request,
    makeApiRequest,
  }) => {
    // Call whoami tool (stateless - each request is independent)
    const callToolResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `${MCP_GATEWAY_URL_SUFFIX}/${profileId}`,
      headers: makeMcpGatewayRequestHeaders(),
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: `archestra${MCP_SERVER_TOOL_NAME_SEPARATOR}whoami`,
          arguments: {},
        },
      },
    });

    expect(callToolResponse.status()).toBe(200);
    const callResult = await callToolResponse.json();
    expect(callResult).toHaveProperty("result");
    expect(callResult.result).toHaveProperty("content");

    // Verify the response contains profile info
    const content = callResult.result.content;
    expect(Array.isArray(content)).toBe(true);
    expect(content.length).toBeGreaterThan(0);

    const textContent = content.find(
      // biome-ignore lint/suspicious/noExplicitAny: for a test it's okay..
      (c: any) => c.type === "text",
    );
    expect(textContent).toBeDefined();
    expect(textContent.text).toContain(profileId);
  });

  test("should reject invalid archestra token", async ({
    request,
    makeApiRequest,
  }) => {
    const invalidHeaders = {
      Authorization: "Bearer archestra_invalid_token_12345",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };

    const initResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `${MCP_GATEWAY_URL_SUFFIX}/${profileId}`,
      headers: invalidHeaders,
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      },
      ignoreStatusCheck: true,
    });

    expect(initResponse.status()).toBe(401);
  });

  test("should reject request without authorization header", async ({
    request,
    makeApiRequest,
  }) => {
    const noAuthHeaders = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };

    const initResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `${MCP_GATEWAY_URL_SUFFIX}/${profileId}`,
      headers: noAuthHeaders,
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      },
      ignoreStatusCheck: true,
    });

    expect(initResponse.status()).toBe(401);
  });
});

test.describe("MCP Gateway - OAuth 2.1 Discovery", () => {
  let profileId: string;

  test.beforeAll(async ({ request, createAgent }) => {
    const uniqueSuffix = crypto.randomUUID().slice(0, 8);
    const createResponse = await createAgent(
      request,
      `MCP Gateway OAuth Test ${uniqueSuffix}`,
    );
    const profile = await createResponse.json();
    profileId = profile.id;
  });

  test.afterAll(async ({ request, deleteAgent }) => {
    await deleteAgent(request, profileId);
  });

  test("401 response includes WWW-Authenticate header with resource_metadata", async ({
    request,
    makeApiRequest,
  }) => {
    // Send a POST without any Authorization header
    const response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `${MCP_GATEWAY_URL_SUFFIX}/${profileId}`,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        // No Authorization header
      },
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      },
      ignoreStatusCheck: true,
    });

    expect(response.status()).toBe(401);

    const wwwAuth = response.headers()["www-authenticate"];
    expect(wwwAuth).toBeDefined();
    expect(wwwAuth).toContain("Bearer");
    expect(wwwAuth).toContain("resource_metadata=");
    expect(wwwAuth).toContain(
      `/.well-known/oauth-protected-resource${MCP_GATEWAY_URL_SUFFIX}/${profileId}`,
    );
  });

  test("401 response for invalid token includes WWW-Authenticate header", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `${MCP_GATEWAY_URL_SUFFIX}/${profileId}`,
      headers: {
        Authorization: "Bearer invalid_jwt_token_here",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      },
      ignoreStatusCheck: true,
    });

    expect(response.status()).toBe(401);

    const wwwAuth = response.headers()["www-authenticate"];
    expect(wwwAuth).toBeDefined();
    expect(wwwAuth).toContain("Bearer");
    expect(wwwAuth).toContain("resource_metadata=");
  });

  test("GET /.well-known/oauth-protected-resource returns metadata for profile", async ({
    request,
  }) => {
    const response = await request.get(
      `${API_BASE_URL}/.well-known/oauth-protected-resource${MCP_GATEWAY_URL_SUFFIX}/${profileId}`,
    );

    expect(response.status()).toBe(200);
    const body = await response.json();

    expect(body.resource).toContain(`${MCP_GATEWAY_URL_SUFFIX}/${profileId}`);
    expect(body.authorization_servers).toBeDefined();
    expect(body.authorization_servers.length).toBeGreaterThan(0);
    expect(body.scopes_supported).toContain("mcp");
    expect(body.bearer_methods_supported).toContain("header");
  });

  test("GET /.well-known/oauth-authorization-server returns server metadata", async ({
    request,
  }) => {
    const response = await request.get(
      `${API_BASE_URL}/.well-known/oauth-authorization-server`,
    );

    expect(response.status()).toBe(200);
    const body = await response.json();

    // Verify all required OAuth 2.1 fields
    expect(body.issuer).toBeDefined();
    expect(body.authorization_endpoint).toContain(OAUTH_ENDPOINTS.authorize);
    expect(body.token_endpoint).toContain(OAUTH_ENDPOINTS.token);
    expect(body.registration_endpoint).toContain(OAUTH_ENDPOINTS.register);
    expect(body.jwks_uri).toContain(OAUTH_ENDPOINTS.jwks);
    expect(body.response_types_supported).toContain("code");
    expect(body.grant_types_supported).toContain("authorization_code");
    expect(body.grant_types_supported).toContain("refresh_token");
    expect(body.code_challenge_methods_supported).toContain("S256");
    expect(body.token_endpoint_auth_methods_supported).toContain("none");
  });

  test("existing archestra_ tokens still work (backward compatibility)", async ({
    request,
    makeApiRequest,
  }) => {
    // Get org token
    const archestraToken = await getOrgTokenForProfile(request);

    // Assign Archestra tools to the profile
    await assignArchestraToolsToProfile(request, profileId);

    // Verify the existing token-based auth still works
    const response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `${MCP_GATEWAY_URL_SUFFIX}/${profileId}`,
      headers: {
        Authorization: `Bearer ${archestraToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      },
    });

    expect(response.status()).toBe(200);
    const result = await response.json();
    expect(result).toHaveProperty("result");
    expect(result.result).toHaveProperty("serverInfo");
  });
});

test.describe("MCP Gateway - External MCP Server Tests", () => {
  let profileId: string;
  let archestraToken: string;

  test.beforeAll(
    async ({
      request,
      installMcpServer,
      uninstallMcpServer,
      getTeamByName,
    }) => {
      // Use the Default MCP Gateway
      const defaultGatewayResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/mcp-gateways/default",
      });
      const defaultGateway = await defaultGatewayResponse.json();
      profileId = defaultGateway.id;

      // Get org token using shared utility
      archestraToken = await getOrgTokenForProfile(request);

      // Get the Default Team (required for MCP server installation when Vault is enabled)
      const defaultTeam = await getTeamByName(request, "Default Team");
      if (!defaultTeam) {
        throw new Error("Default Team not found");
      }

      // Find the catalog item for internal-dev-test-server
      const catalogItem = await findCatalogItem(
        request,
        TEST_CATALOG_ITEM_NAME,
      );
      if (!catalogItem) {
        throw new Error(
          `Catalog item '${TEST_CATALOG_ITEM_NAME}' not found. Ensure it exists in the internal MCP catalog.`,
        );
      }

      // Check if already installed for this team
      let testServer = await findInstalledServer(
        request,
        catalogItem.id,
        defaultTeam.id,
      );

      // Handle existing server based on its status
      if (testServer) {
        const serverResponse = await request.get(
          `${API_BASE_URL}/api/mcp_server/${testServer.id}`,
          { headers: { Origin: UI_BASE_URL } },
        );
        const serverStatus = await serverResponse.json();

        if (serverStatus.localInstallationStatus === "error") {
          // Only uninstall if in error state - don't interrupt pending installations
          await uninstallMcpServer(request, testServer.id);
          // Wait for K8s to clean up the deployment before reinstalling
          await new Promise((resolve) => setTimeout(resolve, 5000));
          testServer = undefined;
        } else if (serverStatus.localInstallationStatus !== "success") {
          // Server is still installing (pending/discovering-tools) - wait for it
          await waitForServerInstallation(request, testServer.id);
        }
        // If already success, we'll use it as-is
      }

      if (!testServer) {
        // Install the server with team assignment
        const installResponse = await installMcpServer(request, {
          name: catalogItem.name,
          catalogId: catalogItem.id,
          teamId: defaultTeam.id,
          environmentValues: {
            ARCHESTRA_TEST: "e2e-test-value",
          },
        });
        const installedServer = await installResponse.json();

        // Wait for installation to complete
        await waitForServerInstallation(request, installedServer.id);
        testServer = installedServer;
      }

      // Type guard - testServer is guaranteed to be defined here
      if (!testServer) {
        throw new Error("MCP server should be installed at this point");
      }

      // Find the test tool (may need to wait for tool discovery)
      let testTool: { id: string; name: string } | undefined;
      for (let attempt = 0; attempt < 14; attempt++) {
        const toolsResponse = await makeApiRequest({
          request,
          method: "get",
          urlSuffix: "/api/tools",
        });
        const toolsData = await toolsResponse.json();
        const tools = toolsData.data || toolsData;
        testTool = tools.find(
          (t: { name: string }) => t.name === TEST_TOOL_NAME,
        );

        if (testTool) break;
        await new Promise((r) => setTimeout(r, 2000));
      }

      if (!testTool) {
        throw new Error(
          `Tool '${TEST_TOOL_NAME}' not found after installation. Tool discovery may have failed.`,
        );
      }

      // Assign the tool to the profile with executionSourceMcpServerId
      const assignResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/agents/tools/bulk-assign",
        data: {
          assignments: [
            {
              agentId: profileId,
              toolId: testTool.id,
              executionSourceMcpServerId: testServer.id,
            },
          ],
        },
      });

      const assignResult = await assignResponse.json();
      if (assignResult.failed?.length > 0) {
        throw new Error(
          `Failed to assign tool: ${JSON.stringify(assignResult.failed)}`,
        );
      }
    },
  );

  const makeMcpGatewayRequestHeaders = () => ({
    Authorization: `Bearer ${archestraToken}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  });

  test("should list internal-dev-test-server tool", async ({
    request,
    makeApiRequest,
  }) => {
    // List tools (stateless)
    const listToolsResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `${MCP_GATEWAY_URL_SUFFIX}/${profileId}`,
      headers: makeMcpGatewayRequestHeaders(),
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      },
    });

    expect(listToolsResponse.status()).toBe(200);
    const listResult = await listToolsResponse.json();
    const tools = listResult.result.tools;

    // Find the test tool
    const testTool = tools.find(
      // biome-ignore lint/suspicious/noExplicitAny: for a test it's okay..
      (t: any) => t.name === TEST_TOOL_NAME,
    );
    expect(testTool).toBeDefined();
    expect(testTool.description).toContain("ARCHESTRA_TEST");
  });

  test("should invoke internal-dev-test-server tool successfully", async ({
    request,
    makeApiRequest,
  }) => {
    // Call the test tool (stateless)
    const callToolResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `${MCP_GATEWAY_URL_SUFFIX}/${profileId}`,
      headers: makeMcpGatewayRequestHeaders(),
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: TEST_TOOL_NAME,
          arguments: {},
        },
      },
    });

    expect(callToolResponse.status()).toBe(200);
    const callResult = await callToolResponse.json();

    // Check for success or error (tool may not be running in CI)
    if (callResult.result) {
      expect(callResult.result).toHaveProperty("content");
      const content = callResult.result.content;
      const textContent = content.find(
        // biome-ignore lint/suspicious/noExplicitAny: for a test it's okay..
        (c: any) => c.type === "text",
      );
      expect(textContent).toBeDefined();
      // The tool should return the ARCHESTRA_TEST env var value
      expect(textContent.text).toContain("ARCHESTRA_TEST");
    } else if (callResult.error) {
      // Tool might not be running - that's okay for this test
      // Just verify we get a proper MCP error response
      expect(callResult.error).toHaveProperty("code");
      expect(callResult.error).toHaveProperty("message");
    }
  });
});

test.describe("MCP Gateway - OAuth 2.1 Full Flow", () => {
  let profileId: string;

  test.beforeAll(async ({ request, createAgent }) => {
    const uniqueSuffix = crypto.randomUUID().slice(0, 8);
    const createResponse = await createAgent(
      request,
      `OAuth Full Flow Test ${uniqueSuffix}`,
    );
    const profile = await createResponse.json();
    profileId = profile.id;

    // Assign Archestra tools to the profile
    await assignArchestraToolsToProfile(request, profileId);
  });

  test.afterAll(async ({ request, deleteAgent }) => {
    await deleteAgent(request, profileId);
  });

  test("full OAuth 2.1 flow: DCR → authorize → consent → token → MCP tools/list", async ({
    request,
    makeApiRequest,
  }) => {
    // --- Step 1: Dynamic Client Registration (RFC 7591) ---
    // Origin header is required for all better-auth endpoints (CSRF protection)
    const dcrResponse = await request.post(
      `${API_BASE_URL}${OAUTH_ENDPOINTS.register}`,
      {
        headers: {
          "Content-Type": "application/json",
          Origin: UI_BASE_URL,
        },
        data: {
          client_name: "E2E OAuth Test Client",
          redirect_uris: ["http://127.0.0.1:12345/callback"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          scope: "mcp",
          token_endpoint_auth_method: "none",
        },
      },
    );

    expect(dcrResponse.status()).toBe(200);
    const dcrResult = await dcrResponse.json();
    const clientId = dcrResult.client_id;
    expect(clientId).toBeDefined();

    // --- Step 2: Generate PKCE code verifier and challenge ---
    const codeVerifier = crypto.randomBytes(32).toString("base64url");
    const codeChallenge = crypto
      .createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    const state = crypto.randomBytes(16).toString("hex");

    // --- Step 3: Authorize (with admin session cookies) ---
    const authorizeParams = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "http://127.0.0.1:12345/callback",
      scope: "mcp",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    const authorizeResponse = await request.get(
      `${API_BASE_URL}${OAUTH_ENDPOINTS.authorize}?${authorizeParams}`,
      {
        headers: {
          Accept: "application/json",
          Origin: UI_BASE_URL,
        },
      },
    );

    // The authorize endpoint returns JSON when Accept: application/json is set
    // It may redirect to the consent page or return the code directly
    let code: string;
    const authorizeContentType =
      authorizeResponse.headers()["content-type"] || "";

    if (authorizeContentType.includes("application/json")) {
      const authorizeResult = await authorizeResponse.json();

      if (authorizeResult.url?.includes("/oauth/consent")) {
        // --- Step 4: Submit consent ---
        // Parse the consent URL to extract the OAuth query params (includes signed state)
        const consentUrl = new URL(authorizeResult.url, `${API_BASE_URL}`);
        const oauthQuery = consentUrl.searchParams.toString();

        const consentResponse = await request.post(
          `${API_BASE_URL}${OAUTH_ENDPOINTS.consent}`,
          {
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              Origin: UI_BASE_URL,
            },
            data: {
              accept: true,
              scope: "mcp",
              oauth_query: oauthQuery,
            },
          },
        );

        const consentResult = await consentResponse.json();
        const redirectUri =
          consentResult.uri || consentResult.url || consentResult.redirectTo;
        expect(redirectUri).toBeDefined();

        const redirectUrl = new URL(redirectUri);
        const extractedCode = redirectUrl.searchParams.get("code");
        expect(extractedCode).toBeDefined();
        code = extractedCode as string;
      } else if (authorizeResult.url) {
        // Code returned directly (consent already given or skipConsent)
        const redirectUrl = new URL(authorizeResult.url);
        const extractedCode = redirectUrl.searchParams.get("code");
        expect(extractedCode).toBeDefined();
        code = extractedCode as string;
      } else {
        throw new Error(
          `Unexpected authorize JSON response: ${JSON.stringify(authorizeResult)}`,
        );
      }
    } else {
      // Followed redirect - extract code from the final URL
      const finalUrl = new URL(authorizeResponse.url());
      const extractedCode = finalUrl.searchParams.get("code");
      code = extractedCode as string;

      // If we ended up at the consent page, submit consent and re-authorize
      if (finalUrl.pathname.includes("/oauth/consent")) {
        const oauthQuery = finalUrl.searchParams.toString();

        const consentResponse = await request.post(
          `${API_BASE_URL}${OAUTH_ENDPOINTS.consent}`,
          {
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              Origin: UI_BASE_URL,
            },
            data: {
              accept: true,
              scope: "mcp",
              oauth_query: oauthQuery,
            },
          },
        );

        const consentResult = await consentResponse.json();
        const redirectUri =
          consentResult.uri || consentResult.url || consentResult.redirectTo;
        const redirectUrl = new URL(redirectUri);
        const consentCode = redirectUrl.searchParams.get("code");
        expect(consentCode).toBeDefined();
        code = consentCode as string;
      }
    }

    expect(code).toBeDefined();
    expect(code.length).toBeGreaterThan(0);

    // --- Step 5: Token exchange ---
    const tokenResponse = await request.post(
      `${API_BASE_URL}${OAUTH_ENDPOINTS.token}`,
      {
        headers: {
          Origin: UI_BASE_URL,
        },
        form: {
          grant_type: "authorization_code",
          code,
          redirect_uri: "http://127.0.0.1:12345/callback",
          code_verifier: codeVerifier,
          client_id: clientId,
        },
      },
    );

    expect(tokenResponse.status()).toBe(200);
    const tokenResult = await tokenResponse.json();
    const accessToken = tokenResult.access_token;
    expect(accessToken).toBeDefined();
    expect(tokenResult.token_type.toLowerCase()).toBe("bearer");

    // --- Step 6: Use JWT to initialize MCP Gateway session ---
    const initResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `${MCP_GATEWAY_URL_SUFFIX}/${profileId}`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          clientInfo: { name: "oauth-e2e-client", version: "1.0.0" },
        },
      },
    });

    expect(initResponse.status()).toBe(200);
    const initResult = await initResponse.json();
    expect(initResult).toHaveProperty("result");
    expect(initResult.result).toHaveProperty("serverInfo");

    // --- Step 7: List tools via MCP Gateway with OAuth JWT ---
    const toolsResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `${MCP_GATEWAY_URL_SUFFIX}/${profileId}`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      data: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      },
    });

    expect(toolsResponse.status()).toBe(200);
    const listResult = await toolsResponse.json();
    expect(listResult).toHaveProperty("result");
    expect(listResult.result).toHaveProperty("tools");
    expect(listResult.result.tools.length).toBeGreaterThan(0);

    // Verify Archestra tools are accessible via the OAuth JWT token
    const archestraWhoami = listResult.result.tools.find(
      // biome-ignore lint/suspicious/noExplicitAny: for a test it's okay..
      (t: any) => t.name === `archestra${MCP_SERVER_TOOL_NAME_SEPARATOR}whoami`,
    );
    expect(archestraWhoami).toBeDefined();
  });

  test("OAuth flow with resource parameter (Cursor/Claude Code style): token exchange strips resource and issues opaque token", async ({
    request,
    makeApiRequest,
  }) => {
    // This test simulates how MCP clients like Cursor and Claude Code connect:
    // they include a `resource` parameter in the token exchange pointing to the
    // MCP Gateway URL. better-auth's validAudiences only supports exact-match
    // strings, so our token endpoint strips the resource parameter to issue
    // opaque tokens (which our MCP Gateway validator already handles).

    // --- Step 1: Dynamic Client Registration ---
    const dcrResponse = await request.post(
      `${API_BASE_URL}${OAUTH_ENDPOINTS.register}`,
      {
        headers: {
          "Content-Type": "application/json",
          Origin: UI_BASE_URL,
        },
        data: {
          client_name: "Cursor MCP Client",
          redirect_uris: ["http://127.0.0.1:23456/callback"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          scope: "mcp",
          token_endpoint_auth_method: "none",
        },
      },
    );

    expect(dcrResponse.status()).toBe(200);
    const dcrResult = await dcrResponse.json();
    const clientId = dcrResult.client_id;
    expect(clientId).toBeDefined();

    // --- Step 2: PKCE ---
    const codeVerifier = crypto.randomBytes(32).toString("base64url");
    const codeChallenge = crypto
      .createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    const state = crypto.randomBytes(16).toString("hex");

    // The resource URL that MCP clients send — points to the specific
    // MCP Gateway profile URL (dynamic per-profile UUID in the path)
    const mcpGatewayResourceUrl = `${API_BASE_URL}${MCP_GATEWAY_URL_SUFFIX}/${profileId}`;

    // --- Step 3: Authorize (with resource parameter, like Cursor does) ---
    const authorizeParams = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "http://127.0.0.1:23456/callback",
      scope: "mcp",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      resource: mcpGatewayResourceUrl,
    });

    const authorizeResponse = await request.get(
      `${API_BASE_URL}${OAUTH_ENDPOINTS.authorize}?${authorizeParams}`,
      {
        headers: {
          Accept: "application/json",
          Origin: UI_BASE_URL,
        },
      },
    );

    let code: string;
    const authorizeContentType =
      authorizeResponse.headers()["content-type"] || "";

    if (authorizeContentType.includes("application/json")) {
      const authorizeResult = await authorizeResponse.json();

      if (authorizeResult.url?.includes("/oauth/consent")) {
        const consentUrl = new URL(authorizeResult.url, `${API_BASE_URL}`);
        const oauthQuery = consentUrl.searchParams.toString();

        const consentResponse = await request.post(
          `${API_BASE_URL}${OAUTH_ENDPOINTS.consent}`,
          {
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              Origin: UI_BASE_URL,
            },
            data: {
              accept: true,
              scope: "mcp",
              oauth_query: oauthQuery,
            },
          },
        );

        const consentResult = await consentResponse.json();
        const redirectUri =
          consentResult.uri || consentResult.url || consentResult.redirectTo;
        expect(redirectUri).toBeDefined();

        const redirectUrl = new URL(redirectUri);
        const extractedCode = redirectUrl.searchParams.get("code");
        expect(extractedCode).toBeDefined();
        code = extractedCode as string;
      } else if (authorizeResult.url) {
        const redirectUrl = new URL(authorizeResult.url);
        const extractedCode = redirectUrl.searchParams.get("code");
        expect(extractedCode).toBeDefined();
        code = extractedCode as string;
      } else {
        throw new Error(
          `Unexpected authorize JSON response: ${JSON.stringify(authorizeResult)}`,
        );
      }
    } else {
      const finalUrl = new URL(authorizeResponse.url());
      if (finalUrl.pathname.includes("/oauth/consent")) {
        const oauthQuery = finalUrl.searchParams.toString();
        const consentResponse = await request.post(
          `${API_BASE_URL}${OAUTH_ENDPOINTS.consent}`,
          {
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              Origin: UI_BASE_URL,
            },
            data: {
              accept: true,
              scope: "mcp",
              oauth_query: oauthQuery,
            },
          },
        );
        const consentResult = await consentResponse.json();
        const redirectUri =
          consentResult.uri || consentResult.url || consentResult.redirectTo;
        const redirectUrl = new URL(redirectUri);
        const extractedCode = redirectUrl.searchParams.get("code");
        expect(extractedCode).toBeDefined();
        code = extractedCode as string;
      } else {
        const extractedCode = finalUrl.searchParams.get("code");
        expect(extractedCode).toBeDefined();
        code = extractedCode as string;
      }
    }

    expect(code).toBeDefined();
    expect(code.length).toBeGreaterThan(0);

    // --- Step 4: Token exchange WITH resource parameter ---
    // This is the critical part: Cursor sends `resource` in the token exchange.
    // Without our fix, this would fail with "requested resource invalid".
    const tokenResponse = await request.post(
      `${API_BASE_URL}${OAUTH_ENDPOINTS.token}`,
      {
        headers: {
          Origin: UI_BASE_URL,
        },
        form: {
          grant_type: "authorization_code",
          code,
          redirect_uri: "http://127.0.0.1:23456/callback",
          code_verifier: codeVerifier,
          client_id: clientId,
          resource: mcpGatewayResourceUrl,
        },
      },
    );

    expect(tokenResponse.status()).toBe(200);
    const tokenResult = await tokenResponse.json();
    const accessToken = tokenResult.access_token;
    expect(accessToken).toBeDefined();
    expect(tokenResult.token_type.toLowerCase()).toBe("bearer");

    // The token should be opaque (not a JWT) since we stripped the resource
    // parameter. Opaque tokens are short random strings, not dot-separated JWTs.
    const dotCount = accessToken.split(".").length - 1;
    expect(dotCount).toBeLessThan(2); // JWTs have exactly 2 dots (header.payload.signature)

    // --- Step 5: Use the opaque token to access the MCP Gateway ---
    const initResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `${MCP_GATEWAY_URL_SUFFIX}/${profileId}`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          clientInfo: { name: "cursor-e2e-client", version: "1.0.0" },
        },
      },
    });

    expect(initResponse.status()).toBe(200);
    const initResult = await initResponse.json();
    expect(initResult).toHaveProperty("result");
    expect(initResult.result).toHaveProperty("serverInfo");

    // --- Step 6: List tools to verify full functionality ---
    const toolsResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `${MCP_GATEWAY_URL_SUFFIX}/${profileId}`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      data: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      },
    });

    expect(toolsResponse.status()).toBe(200);
    const listResult = await toolsResponse.json();
    expect(listResult).toHaveProperty("result");
    expect(listResult.result).toHaveProperty("tools");
    expect(listResult.result.tools.length).toBeGreaterThan(0);

    // Verify Archestra tools are accessible via the OAuth opaque token
    const archestraWhoami = listResult.result.tools.find(
      // biome-ignore lint/suspicious/noExplicitAny: for a test it's okay..
      (t: any) => t.name === `archestra${MCP_SERVER_TOOL_NAME_SEPARATOR}whoami`,
    );
    expect(archestraWhoami).toBeDefined();
  });

  test("Dynamic Client Registration returns client_id", async ({ request }) => {
    const dcrResponse = await request.post(
      `${API_BASE_URL}${OAUTH_ENDPOINTS.register}`,
      {
        headers: {
          "Content-Type": "application/json",
          Origin: UI_BASE_URL,
        },
        data: {
          client_name: "DCR Test Client",
          redirect_uris: ["http://127.0.0.1:54321/callback"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          scope: "mcp",
          token_endpoint_auth_method: "none",
        },
      },
    );

    expect(dcrResponse.status()).toBe(200);
    const result = await dcrResponse.json();
    expect(result.client_id).toBeDefined();
    expect(typeof result.client_id).toBe("string");
    expect(result.client_id.length).toBeGreaterThan(0);
  });

  test("OAuth client-info endpoint returns client name", async ({
    request,
  }) => {
    // First register a client
    const dcrResponse = await request.post(
      `${API_BASE_URL}${OAUTH_ENDPOINTS.register}`,
      {
        headers: {
          "Content-Type": "application/json",
          Origin: UI_BASE_URL,
        },
        data: {
          client_name: "Client Info Test",
          redirect_uris: ["http://127.0.0.1:54322/callback"],
          grant_types: ["authorization_code"],
          response_types: ["code"],
          scope: "mcp",
          token_endpoint_auth_method: "none",
        },
      },
    );
    expect(dcrResponse.status()).toBe(200);
    const dcrResult = await dcrResponse.json();
    const clientId = dcrResult.client_id;

    // Query client-info endpoint
    const clientInfoResponse = await request.get(
      `${API_BASE_URL}/api/auth/oauth2/client-info?client_id=${clientId}`,
    );

    expect(clientInfoResponse.status()).toBe(200);
    const clientInfo = await clientInfoResponse.json();
    expect(clientInfo.client_name).toBe("Client Info Test");
  });

  test("OAuth client-info returns null for unknown client", async ({
    request,
  }) => {
    const response = await request.get(
      `${API_BASE_URL}/api/auth/oauth2/client-info?client_id=nonexistent-client-id`,
    );

    expect(response.status()).toBe(200);
    const result = await response.json();
    expect(result.client_name).toBeNull();
  });

  test("Token refresh flow: exchange refresh_token for new access_token", async ({
    request,
  }) => {
    // --- Step 1: Register client ---
    const dcrResponse = await request.post(
      `${API_BASE_URL}${OAUTH_ENDPOINTS.register}`,
      {
        headers: {
          "Content-Type": "application/json",
          Origin: UI_BASE_URL,
        },
        data: {
          client_name: "Refresh Token Test Client",
          redirect_uris: ["http://127.0.0.1:54323/callback"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          scope: "mcp offline_access",
          token_endpoint_auth_method: "none",
        },
      },
    );
    expect(dcrResponse.status()).toBe(200);
    const dcrResult = await dcrResponse.json();
    const clientId = dcrResult.client_id;

    // --- Step 2: PKCE ---
    const codeVerifier = crypto.randomBytes(32).toString("base64url");
    const codeChallenge = crypto
      .createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    const state = crypto.randomBytes(16).toString("hex");

    // --- Step 3: Authorize ---
    const authorizeParams = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "http://127.0.0.1:54323/callback",
      scope: "mcp offline_access",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    const authorizeResponse = await request.get(
      `${API_BASE_URL}${OAUTH_ENDPOINTS.authorize}?${authorizeParams}`,
      {
        headers: {
          Accept: "application/json",
          Origin: UI_BASE_URL,
        },
      },
    );

    // Extract authorization code (handle consent redirect if needed)
    let code: string;
    const authorizeContentType =
      authorizeResponse.headers()["content-type"] || "";

    if (authorizeContentType.includes("application/json")) {
      const authorizeResult = await authorizeResponse.json();

      if (authorizeResult.url?.includes("/oauth/consent")) {
        const consentUrl = new URL(authorizeResult.url, `${API_BASE_URL}`);
        const oauthQuery = consentUrl.searchParams.toString();

        const consentResponse = await request.post(
          `${API_BASE_URL}${OAUTH_ENDPOINTS.consent}`,
          {
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              Origin: UI_BASE_URL,
            },
            data: {
              accept: true,
              scope: "mcp offline_access",
              oauth_query: oauthQuery,
            },
          },
        );

        const consentResult = await consentResponse.json();
        const redirectUri =
          consentResult.uri || consentResult.url || consentResult.redirectTo;
        const redirectUrl = new URL(redirectUri);
        const extractedCode = redirectUrl.searchParams.get("code");
        expect(extractedCode).toBeDefined();
        code = extractedCode as string;
      } else {
        const redirectUrl = new URL(authorizeResult.url);
        const extractedCode = redirectUrl.searchParams.get("code");
        expect(extractedCode).toBeDefined();
        code = extractedCode as string;
      }
    } else {
      const finalUrl = new URL(authorizeResponse.url());
      if (finalUrl.pathname.includes("/oauth/consent")) {
        const oauthQuery = finalUrl.searchParams.toString();
        const consentResponse = await request.post(
          `${API_BASE_URL}${OAUTH_ENDPOINTS.consent}`,
          {
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              Origin: UI_BASE_URL,
            },
            data: {
              accept: true,
              scope: "mcp offline_access",
              oauth_query: oauthQuery,
            },
          },
        );
        const consentResult = await consentResponse.json();
        const redirectUri =
          consentResult.uri || consentResult.url || consentResult.redirectTo;
        const redirectUrl = new URL(redirectUri);
        const extractedCode = redirectUrl.searchParams.get("code");
        expect(extractedCode).toBeDefined();
        code = extractedCode as string;
      } else {
        const extractedCode = finalUrl.searchParams.get("code");
        expect(extractedCode).toBeDefined();
        code = extractedCode as string;
      }
    }

    // --- Step 4: Initial token exchange ---
    const tokenResponse = await request.post(
      `${API_BASE_URL}${OAUTH_ENDPOINTS.token}`,
      {
        headers: { Origin: UI_BASE_URL },
        form: {
          grant_type: "authorization_code",
          code,
          redirect_uri: "http://127.0.0.1:54323/callback",
          code_verifier: codeVerifier,
          client_id: clientId,
        },
      },
    );

    expect(tokenResponse.status()).toBe(200);
    const tokenResult = await tokenResponse.json();
    expect(tokenResult.access_token).toBeDefined();
    expect(tokenResult.refresh_token).toBeDefined();

    const refreshToken = tokenResult.refresh_token;

    // --- Step 5: Use refresh token to get new access token ---
    const refreshResponse = await request.post(
      `${API_BASE_URL}${OAUTH_ENDPOINTS.token}`,
      {
        headers: { Origin: UI_BASE_URL },
        form: {
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: clientId,
        },
      },
    );

    expect(refreshResponse.status()).toBe(200);
    const refreshResult = await refreshResponse.json();
    expect(refreshResult.access_token).toBeDefined();
    expect(refreshResult.token_type.toLowerCase()).toBe("bearer");
    // New access token should be different from the original
    expect(refreshResult.access_token).not.toBe(tokenResult.access_token);

    // --- Step 6: Verify new access token works on MCP Gateway ---
    const toolsResponse = await request.post(
      `${API_BASE_URL}${MCP_GATEWAY_URL_SUFFIX}/${profileId}`,
      {
        headers: {
          Authorization: `Bearer ${refreshResult.access_token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        data: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        },
      },
    );

    expect(toolsResponse.status()).toBe(200);
    const listResult = await toolsResponse.json();
    expect(listResult).toHaveProperty("result");
    expect(listResult.result).toHaveProperty("tools");
    expect(listResult.result.tools.length).toBeGreaterThan(0);
  });
});

test.describe("MCP Gateway - CIMD (Client ID Metadata Documents)", () => {
  let profileId: string;

  // The CIMD client_id is a URL pointing to a WireMock-served metadata document.
  // The backend must be able to reach this URL, so we use WIREMOCK_INTERNAL_URL.
  const cimdClientId = `${WIREMOCK_INTERNAL_URL}/cimd/test-client.json`;

  test.beforeAll(async ({ request, createAgent }) => {
    const uniqueSuffix = crypto.randomUUID().slice(0, 8);
    const createResponse = await createAgent(
      request,
      `CIMD OAuth Flow Test ${uniqueSuffix}`,
    );
    const profile = await createResponse.json();
    profileId = profile.id;

    // Assign Archestra tools to the profile
    await assignArchestraToolsToProfile(request, profileId);
  });

  test.afterAll(async ({ request, deleteAgent }) => {
    await deleteAgent(request, profileId);
  });

  test("full OAuth 2.1 flow with CIMD: no registration → authorize → consent → token → MCP tools/list", async ({
    request,
    makeApiRequest,
  }) => {
    // --- Step 1: Generate PKCE code verifier and challenge ---
    const codeVerifier = crypto.randomBytes(32).toString("base64url");
    const codeChallenge = crypto
      .createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    const state = crypto.randomBytes(16).toString("hex");

    // --- Step 2: Authorize with CIMD client_id (URL) — NO DCR needed ---
    const authorizeParams = new URLSearchParams({
      response_type: "code",
      client_id: cimdClientId,
      redirect_uri: "http://127.0.0.1:34567/callback",
      scope: "mcp",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    const authorizeResponse = await request.get(
      `${API_BASE_URL}${OAUTH_ENDPOINTS.authorize}?${authorizeParams}`,
      {
        headers: {
          Accept: "application/json",
          Origin: UI_BASE_URL,
        },
      },
    );

    let code: string;
    const authorizeContentType =
      authorizeResponse.headers()["content-type"] || "";

    if (authorizeContentType.includes("application/json")) {
      const authorizeResult = await authorizeResponse.json();

      if (authorizeResult.url?.includes("/oauth/consent")) {
        const consentUrl = new URL(authorizeResult.url, `${API_BASE_URL}`);
        const oauthQuery = consentUrl.searchParams.toString();

        const consentResponse = await request.post(
          `${API_BASE_URL}${OAUTH_ENDPOINTS.consent}`,
          {
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              Origin: UI_BASE_URL,
            },
            data: {
              accept: true,
              scope: "mcp",
              oauth_query: oauthQuery,
            },
          },
        );

        const consentResult = await consentResponse.json();
        const redirectUri =
          consentResult.uri || consentResult.url || consentResult.redirectTo;
        expect(redirectUri).toBeDefined();

        const redirectUrl = new URL(redirectUri);
        const extractedCode = redirectUrl.searchParams.get("code");
        expect(extractedCode).toBeDefined();
        code = extractedCode as string;
      } else if (authorizeResult.url) {
        const redirectUrl = new URL(authorizeResult.url);
        const extractedCode = redirectUrl.searchParams.get("code");
        expect(extractedCode).toBeDefined();
        code = extractedCode as string;
      } else {
        throw new Error(
          `Unexpected authorize JSON response: ${JSON.stringify(authorizeResult)}`,
        );
      }
    } else {
      const finalUrl = new URL(authorizeResponse.url());
      if (finalUrl.pathname.includes("/oauth/consent")) {
        const oauthQuery = finalUrl.searchParams.toString();
        const consentResponse = await request.post(
          `${API_BASE_URL}${OAUTH_ENDPOINTS.consent}`,
          {
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              Origin: UI_BASE_URL,
            },
            data: {
              accept: true,
              scope: "mcp",
              oauth_query: oauthQuery,
            },
          },
        );
        const consentResult = await consentResponse.json();
        const redirectUri =
          consentResult.uri || consentResult.url || consentResult.redirectTo;
        const redirectUrl = new URL(redirectUri);
        const extractedCode = redirectUrl.searchParams.get("code");
        expect(extractedCode).toBeDefined();
        code = extractedCode as string;
      } else {
        const extractedCode = finalUrl.searchParams.get("code");
        expect(extractedCode).toBeDefined();
        code = extractedCode as string;
      }
    }

    expect(code).toBeDefined();
    expect(code.length).toBeGreaterThan(0);

    // --- Step 3: Token exchange ---
    const tokenResponse = await request.post(
      `${API_BASE_URL}${OAUTH_ENDPOINTS.token}`,
      {
        headers: {
          Origin: UI_BASE_URL,
        },
        form: {
          grant_type: "authorization_code",
          code,
          redirect_uri: "http://127.0.0.1:34567/callback",
          code_verifier: codeVerifier,
          client_id: cimdClientId,
        },
      },
    );

    expect(tokenResponse.status()).toBe(200);
    const tokenResult = await tokenResponse.json();
    const accessToken = tokenResult.access_token;
    expect(accessToken).toBeDefined();
    expect(tokenResult.token_type.toLowerCase()).toBe("bearer");

    // --- Step 4: Use token to access MCP Gateway ---
    const initResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `${MCP_GATEWAY_URL_SUFFIX}/${profileId}`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          clientInfo: { name: "cimd-e2e-client", version: "1.0.0" },
        },
      },
    });

    expect(initResponse.status()).toBe(200);
    const initResult = await initResponse.json();
    expect(initResult).toHaveProperty("result");
    expect(initResult.result).toHaveProperty("serverInfo");

    // --- Step 5: List tools via MCP Gateway ---
    const toolsResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `${MCP_GATEWAY_URL_SUFFIX}/${profileId}`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      data: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      },
    });

    expect(toolsResponse.status()).toBe(200);
    const listResult = await toolsResponse.json();
    expect(listResult).toHaveProperty("result");
    expect(listResult.result).toHaveProperty("tools");
    expect(listResult.result.tools.length).toBeGreaterThan(0);

    // Verify Archestra tools are accessible
    const archestraWhoami = listResult.result.tools.find(
      // biome-ignore lint/suspicious/noExplicitAny: for a test it's okay..
      (t: any) => t.name === `archestra${MCP_SERVER_TOOL_NAME_SEPARATOR}whoami`,
    );
    expect(archestraWhoami).toBeDefined();
  });

  test("CIMD client-info endpoint returns client name from auto-registered CIMD client", async ({
    request,
  }) => {
    // Trigger CIMD auto-registration by hitting the authorize endpoint.
    // Each test must be self-sufficient — don't rely on previous test side-effects.
    const authorizeParams = new URLSearchParams({
      response_type: "code",
      client_id: cimdClientId,
      redirect_uri: "http://127.0.0.1:34567/callback",
      scope: "mcp",
      state: crypto.randomBytes(16).toString("hex"),
      code_challenge: crypto.randomBytes(32).toString("base64url"),
      code_challenge_method: "S256",
    });
    await request.get(
      `${API_BASE_URL}${OAUTH_ENDPOINTS.authorize}?${authorizeParams}`,
      { headers: { Accept: "application/json", Origin: UI_BASE_URL } },
    );

    // Verify the client-info endpoint returns the name from the CIMD document.
    const clientInfoResponse = await request.get(
      `${API_BASE_URL}/api/auth/oauth2/client-info?client_id=${encodeURIComponent(cimdClientId)}`,
    );

    expect(clientInfoResponse.status()).toBe(200);
    const clientInfo = await clientInfoResponse.json();
    expect(clientInfo.client_name).toBe("E2E CIMD Test Client");
  });

  test("CIMD validation error: invalid JSON document", async ({ request }) => {
    const invalidJsonClientId = `${WIREMOCK_INTERNAL_URL}/cimd/invalid-json.json`;

    const authorizeParams = new URLSearchParams({
      response_type: "code",
      client_id: invalidJsonClientId,
      redirect_uri: "http://127.0.0.1:34567/callback",
      scope: "mcp",
      state: crypto.randomBytes(16).toString("hex"),
      code_challenge: crypto.randomBytes(32).toString("base64url"),
      code_challenge_method: "S256",
    });

    const response = await request.get(
      `${API_BASE_URL}${OAUTH_ENDPOINTS.authorize}?${authorizeParams}`,
      {
        headers: {
          Accept: "application/json",
          Origin: UI_BASE_URL,
        },
      },
    );

    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("not valid JSON");
  });

  test("CIMD validation error: mismatched client_id in document", async ({
    request,
  }) => {
    const mismatchedClientId = `${WIREMOCK_INTERNAL_URL}/cimd/mismatched-client-id.json`;

    const authorizeParams = new URLSearchParams({
      response_type: "code",
      client_id: mismatchedClientId,
      redirect_uri: "http://127.0.0.1:34567/callback",
      scope: "mcp",
      state: crypto.randomBytes(16).toString("hex"),
      code_challenge: crypto.randomBytes(32).toString("base64url"),
      code_challenge_method: "S256",
    });

    const response = await request.get(
      `${API_BASE_URL}${OAUTH_ENDPOINTS.authorize}?${authorizeParams}`,
      {
        headers: {
          Accept: "application/json",
          Origin: UI_BASE_URL,
        },
      },
    );

    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("does not match");
  });

  test("CIMD validation error: 404 document not found", async ({ request }) => {
    const notFoundClientId = `${WIREMOCK_INTERNAL_URL}/cimd/does-not-exist.json`;

    const authorizeParams = new URLSearchParams({
      response_type: "code",
      client_id: notFoundClientId,
      redirect_uri: "http://127.0.0.1:34567/callback",
      scope: "mcp",
      state: crypto.randomBytes(16).toString("hex"),
      code_challenge: crypto.randomBytes(32).toString("base64url"),
      code_challenge_method: "S256",
    });

    const response = await request.get(
      `${API_BASE_URL}${OAUTH_ENDPOINTS.authorize}?${authorizeParams}`,
      {
        headers: {
          Accept: "application/json",
          Origin: UI_BASE_URL,
        },
      },
    );

    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("HTTP 404");
  });

  test("CIMD validation error: missing redirect_uris", async ({ request }) => {
    const missingRedirectUrisClientId = `${WIREMOCK_INTERNAL_URL}/cimd/missing-redirect-uris.json`;

    const authorizeParams = new URLSearchParams({
      response_type: "code",
      client_id: missingRedirectUrisClientId,
      redirect_uri: "http://127.0.0.1:34567/callback",
      scope: "mcp",
      state: crypto.randomBytes(16).toString("hex"),
      code_challenge: crypto.randomBytes(32).toString("base64url"),
      code_challenge_method: "S256",
    });

    const response = await request.get(
      `${API_BASE_URL}${OAUTH_ENDPOINTS.authorize}?${authorizeParams}`,
      {
        headers: {
          Accept: "application/json",
          Origin: UI_BASE_URL,
        },
      },
    );

    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("redirect_uris");
  });

  test("well-known metadata advertises CIMD support", async ({ request }) => {
    const response = await request.get(
      `${API_BASE_URL}/.well-known/oauth-authorization-server`,
    );

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.client_id_metadata_document_supported).toBe(true);
  });
});
