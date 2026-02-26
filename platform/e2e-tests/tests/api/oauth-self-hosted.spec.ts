import type { APIRequestContext } from "@playwright/test";
import {
  IS_CI,
  MCP_EXAMPLE_OAUTH_BACKEND_URL,
  MCP_EXAMPLE_OAUTH_EXTERNAL_URL,
  UI_BASE_URL,
} from "../../consts";
import { expect, test } from "./fixtures";
import type { TestFixtures } from "./fixtures";

/**
 * OAuth for Self-Hosted MCP Servers
 *
 * Tests the full OAuth 2.1 flow for remote, local streamable-http, and local stdio MCP servers
 * using the official MCP example remote server (https://github.com/modelcontextprotocol/example-remote-server)
 * with its built-in mock OAuth provider.
 *
 * In CI: deployed via Helm chart on NodePort 30083
 * In local dev: run manually on port 3232 or via the Helm chart
 *   cd /tmp/example-remote-server && AUTH_MODE=internal PORT=3232 npx tsx src/index.ts
 *
 * The example server provides:
 *   - /.well-known/oauth-authorization-server  (discovery)
 *   - /register  (dynamic client registration)
 *   - /authorize → /mock-upstream-idp/authorize → /mock-upstream-idp/callback (auth flow)
 *   - /token  (token exchange)
 *   - /mcp  (MCP endpoint, requires Bearer token)
 */

// External URL (accessible from test runner / browser)
const MCP_EXAMPLE_SERVER_URL = IS_CI
  ? MCP_EXAMPLE_OAUTH_EXTERNAL_URL
  : (process.env.MCP_EXAMPLE_OAUTH_URL || "http://localhost:3232");
// Backend URL (accessible from Archestra backend for token exchange)
const MCP_EXAMPLE_SERVER_BACKEND_URL = IS_CI
  ? MCP_EXAMPLE_OAUTH_BACKEND_URL
  : MCP_EXAMPLE_SERVER_URL;
const MCP_EXAMPLE_SERVER_MCP_URL = `${MCP_EXAMPLE_SERVER_BACKEND_URL}/mcp`;

// =============================================================================
// Shared OAuth test helpers
// =============================================================================

/**
 * In CI, the backend returns authorization URLs using K8s internal service DNS
 * (from the well-known metadata). The test runner can't reach those URLs,
 * so rewrite them to use the external NodePort URL.
 */
function toExternalUrl(url: string): string {
  if (IS_CI) {
    return url.replace(MCP_EXAMPLE_OAUTH_BACKEND_URL, MCP_EXAMPLE_OAUTH_EXTERNAL_URL);
  }
  return url;
}

/**
 * Programmatically complete the OAuth flow through the example server's mock IdP.
 *
 * 1. GET the authorization URL → extract the mock IdP link (with internal state)
 * 2. Call the mock IdP callback with state + mock code → get redirect to Archestra callback URL
 * 3. Extract code and state from the redirect URL
 */
async function completeExampleServerOAuthFlow(authorizationUrl: string): Promise<{
  code: string;
  state: string;
}> {
  // Step 1: Fetch the authorization page to get the mock IdP link
  const authPageResponse = await fetch(authorizationUrl);
  const authPageHtml = await authPageResponse.text();

  // Extract the mock IdP state from the link on the page
  const mockIdpStateMatch = authPageHtml.match(
    /mock-upstream-idp\/authorize\?redirect_uri=[^&]*&state=([a-f0-9]+)/,
  );
  if (!mockIdpStateMatch) {
    throw new Error(
      "Could not find mock IdP state in authorization page HTML",
    );
  }
  const mockIdpState = mockIdpStateMatch[1];

  // Step 2: Call the mock IdP callback directly (simulates user clicking "Authorize")
  // The example server processes this and redirects directly to Archestra's oauth-callback
  const mockCallbackUrl = `${MCP_EXAMPLE_SERVER_URL}/mock-upstream-idp/callback?state=${mockIdpState}&code=mock-auth-code&userId=e2e-test-user`;
  const callbackResponse = await fetch(mockCallbackUrl, {
    redirect: "manual", // Don't follow the redirect to localhost:3000
  });

  // The redirect goes directly to Archestra's oauth-callback with code + state
  const location = callbackResponse.headers.get("location");
  if (!location) {
    throw new Error("Mock IdP callback did not redirect");
  }

  // Step 3: Extract code and state from the redirect URL
  const redirectUrl = new URL(location);
  const code = redirectUrl.searchParams.get("code");
  const state = redirectUrl.searchParams.get("state");
  if (!code || !state) {
    throw new Error(
      `Missing code or state in redirect URL: ${location}`,
    );
  }

  return { code, state };
}

/**
 * Check if the MCP example server is running
 */
async function isExampleServerRunning(): Promise<boolean> {
  try {
    const response = await fetch(
      `${MCP_EXAMPLE_SERVER_URL}/.well-known/oauth-authorization-server`,
      { signal: AbortSignal.timeout(2000) },
    );
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Perform the full OAuth flow: initiate → authorize through mock IdP → exchange code for token.
 * Shared across all OAuth test cases (remote, local streamable-http, local stdio).
 */
async function performOAuthFlow(
  makeApiRequest: TestFixtures["makeApiRequest"],
  request: APIRequestContext,
  catalogId: string,
): Promise<{ secretId: string; accessToken: string }> {
  // 1. Initiate OAuth flow
  const initiateResponse = await makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/oauth/initiate",
    data: { catalogId },
  });
  const { authorizationUrl, state } = await initiateResponse.json();
  expect(authorizationUrl).toContain("/authorize");
  expect(state).toBeTruthy();

  // 2. Complete OAuth flow programmatically through mock IdP
  // In CI, rewrite K8s internal URLs to external NodePort for the test runner
  const { code, state: callbackState } =
    await completeExampleServerOAuthFlow(toExternalUrl(authorizationUrl));
  expect(code).toBeTruthy();
  expect(callbackState).toBe(state);

  // 3. Exchange code for token via Archestra callback
  const callbackResponse = await makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/oauth/callback",
    data: { code, state: callbackState },
  });
  const callbackResult = await callbackResponse.json();
  expect(callbackResult.success).toBe(true);
  expect(callbackResult.catalogId).toBe(catalogId);
  expect(callbackResult.accessToken).toBeTruthy();
  expect(callbackResult.secretId).toBeTruthy();

  return {
    secretId: callbackResult.secretId,
    accessToken: callbackResult.accessToken,
  };
}

/** Shared OAuth config pointing to the example server */
function makeOAuthConfig() {
  return {
    name: "MCP Example OAuth",
    server_url: MCP_EXAMPLE_SERVER_MCP_URL,
    client_id: "",
    client_secret: "",
    redirect_uris: [`${UI_BASE_URL}/oauth-callback`],
    scopes: [],
    default_scopes: [],
    supports_resource_metadata: false,
  };
}

// =============================================================================
// Tests
// =============================================================================

test.describe("OAuth for Self-Hosted MCP Servers", () => {
  test.describe.configure({ retries: 1 });

  test.beforeAll(async () => {
    const running = await isExampleServerRunning();
    if (!running) {
      test.skip(
        true,
        "MCP example server not running on port 3232. Start it with: cd /tmp/example-remote-server && AUTH_MODE=internal PORT=3232 npx tsx src/index.ts",
      );
    }
  });

  test("remote server: full OAuth flow (initiate → authorize → callback → install)", async ({
    request,
    makeApiRequest,
    deleteMcpCatalogItem,
    uninstallMcpServer,
  }) => {
    // 1. Create a remote catalog item with OAuth config
    const createResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/internal_mcp_catalog",
      data: {
        name: `oauth-remote-test-${Date.now()}`,
        description: "E2E test: remote server with OAuth",
        serverUrl: MCP_EXAMPLE_SERVER_MCP_URL,
        serverType: "remote",
        authMethod: "oauth",
        oauthConfig: makeOAuthConfig(),
      },
    });
    const catalogItem = await createResponse.json();
    expect(catalogItem.id).toBeTruthy();
    expect(catalogItem.oauthConfig).toBeTruthy();

    try {
      // 2-4. Full OAuth flow
      const { secretId, accessToken } = await performOAuthFlow(
        makeApiRequest, request, catalogItem.id,
      );

      // 5. Install the MCP server with the OAuth secret
      const installResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/mcp_server",
        data: {
          name: catalogItem.name,
          catalogId: catalogItem.id,
          secretId,
        },
      });
      const server = await installResponse.json();
      expect(server.id).toBeTruthy();
      expect(server.secretId).toBe(secretId);
      expect(server.serverType).toBe("remote");

      // 6. Verify the access token works against the MCP server
      // Use external URL since the test runner is outside K8s
      const mcpResponse = await fetch(`${MCP_EXAMPLE_SERVER_URL}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
          Accept: "text/event-stream, application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "archestra-e2e-test", version: "1.0.0" },
          },
        }),
      });
      expect(mcpResponse.ok).toBe(true);
      const mcpBody = await mcpResponse.text();
      expect(mcpBody).toContain("protocolVersion");

      // Cleanup
      await uninstallMcpServer(request, server.id);
    } finally {
      await deleteMcpCatalogItem(request, catalogItem.id);
    }
  });

  test("local streamable-http server: OAuth flow creates server with correct type", async ({
    request,
    makeApiRequest,
    deleteMcpCatalogItem,
    uninstallMcpServer,
  }) => {
    // 1. Create a local catalog item with streamable-http transport + OAuth
    const createResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/internal_mcp_catalog",
      data: {
        name: `oauth-local-http-test-${Date.now()}`,
        description: "E2E test: self-hosted streamable-http server with OAuth",
        serverType: "local",
        authMethod: "oauth",
        localConfig: {
          transportType: "streamable-http",
          streamableHttpPort: 3232,
          dockerImage: "example/mcp-oauth-test:latest",
        },
        oauthConfig: makeOAuthConfig(),
      },
    });
    const catalogItem = await createResponse.json();
    expect(catalogItem.id).toBeTruthy();
    expect(catalogItem.serverType).toBe("local");
    expect(catalogItem.oauthConfig).toBeTruthy();

    try {
      // 2-4. Full OAuth flow
      const { secretId } = await performOAuthFlow(
        makeApiRequest, request, catalogItem.id,
      );

      // 5. Install with secretId + environmentValues
      const installResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/mcp_server",
        data: {
          name: catalogItem.name,
          catalogId: catalogItem.id,
          secretId,
          environmentValues: { CUSTOM_ENV: "test-value" },
        },
      });
      const server = await installResponse.json();
      expect(server.id).toBeTruthy();
      expect(server.secretId).toBe(secretId);
      expect(server.serverType).toBe("local");

      // Cleanup
      await uninstallMcpServer(request, server.id);
    } finally {
      await deleteMcpCatalogItem(request, catalogItem.id);
    }
  });

  test("local stdio server: OAuth token injected via access_token_env_var", async ({
    request,
    makeApiRequest,
    deleteMcpCatalogItem,
    uninstallMcpServer,
  }) => {
    // 1. Create a local catalog item with stdio transport + OAuth + access_token_env_var
    // The backend injects the OAuth access token as the specified env var for stdio containers
    const createResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/internal_mcp_catalog",
      data: {
        name: `oauth-local-stdio-test-${Date.now()}`,
        description: "E2E test: self-hosted stdio server with OAuth token via env var",
        serverType: "local",
        authMethod: "oauth",
        localConfig: {
          transportType: "stdio",
          dockerImage: "example/mcp-oauth-stdio:latest",
        },
        oauthConfig: {
          ...makeOAuthConfig(),
          access_token_env_var: "MCP_OAUTH_TOKEN",
        },
      },
    });
    const catalogItem = await createResponse.json();
    expect(catalogItem.id).toBeTruthy();
    expect(catalogItem.serverType).toBe("local");
    expect(catalogItem.oauthConfig).toBeTruthy();
    expect(catalogItem.oauthConfig.access_token_env_var).toBe("MCP_OAUTH_TOKEN");
    expect(catalogItem.localConfig.transportType).toBe("stdio");

    try {
      // 2-4. Full OAuth flow (identical for all server types)
      const { secretId } = await performOAuthFlow(
        makeApiRequest, request, catalogItem.id,
      );

      // 5. Install the server - backend will inject access_token as MCP_OAUTH_TOKEN env var
      // because transportType is "stdio" and access_token_env_var is set
      const installResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/mcp_server",
        data: {
          name: catalogItem.name,
          catalogId: catalogItem.id,
          secretId,
          environmentValues: { ADDITIONAL_VAR: "some-config" },
        },
      });
      const server = await installResponse.json();
      expect(server.id).toBeTruthy();
      expect(server.secretId).toBe(secretId);
      expect(server.serverType).toBe("local");

      // Cleanup
      await uninstallMcpServer(request, server.id);
    } finally {
      await deleteMcpCatalogItem(request, catalogItem.id);
    }
  });

  test("OAuth initiate fails for non-OAuth catalog item", async ({
    request,
    makeApiRequest,
    createMcpCatalogItem,
    deleteMcpCatalogItem,
  }) => {
    // Create a catalog item without OAuth
    const createResponse = await createMcpCatalogItem(request, {
      name: `no-oauth-test-${Date.now()}`,
      description: "E2E test: server without OAuth",
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
    });
    const catalogItem = await createResponse.json();

    try {
      // Initiating OAuth should fail
      const initiateResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/oauth/initiate",
        data: { catalogId: catalogItem.id },
        ignoreStatusCheck: true,
      });
      expect(initiateResponse.status()).toBe(400);
      const body = await initiateResponse.json();
      expect(body.error.message).toContain("does not support OAuth");
    } finally {
      await deleteMcpCatalogItem(request, catalogItem.id);
    }
  });

  test("OAuth callback fails with invalid state", async ({
    request,
    makeApiRequest,
  }) => {
    const callbackResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/oauth/callback",
      data: { code: "fake-code", state: "invalid-state" },
      ignoreStatusCheck: true,
    });
    expect(callbackResponse.status()).toBe(400);
    const body = await callbackResponse.json();
    expect(body.error.message).toContain("Invalid or expired OAuth state");
  });
});
