import type { APIRequestContext, Browser } from "@playwright/test";
import {
  adminAuthFile,
  KEYCLOAK_OIDC,
  MCP_SERVER_JWKS_BACKEND_URL,
  MCP_SERVER_JWKS_EXTERNAL_URL,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  SSO_DOMAIN,
  UI_BASE_URL,
} from "../consts";
import {
  getAdminKeycloakJwt,
  getMemberKeycloakJwt,
  loginViaKeycloak,
  waitForApiEndpointHealthy,
  waitForServerInstallation,
} from "../utils";
import {
  callMcpTool,
  initializeMcpSession,
  makeApiRequest,
  waitForGatewayIdentityProviderReady,
  waitForMcpGatewayJwtReady,
} from "../utils/mcp-gateway";
import {
  createIdentityProvider,
  deleteIdentityProvider,
  expect,
  test,
} from "./api-fixtures";

const DEBUG_TOOL_SHORT_NAME = "debug-auth-token";

// Serial: every test shares the one SSO-linked identity provider created in
// beforeAll, and concurrent browser OIDC logins for the same Keycloak user
// only add flake surface. Serial keeps the whole file in one worker so the
// beforeAll link is done exactly once per attempt.
test.describe.configure({ mode: "serial" });

test.describe("Enterprise-managed MCP credentials", () => {
  // One Keycloak identity provider, SSO-linked to the admin once, shared by
  // every test in this file. Two forces make this shared instead of per-test:
  //  - install-time discovery for enterprise-managed catalogs requires the
  //    INSTALLING user to hold an SSO-linked account for the catalog's IdP,
  //    which needs a real browser OIDC login (slow, ~30s in CI); and
  //  - better-auth caps live SSO providers (ssoConfig providersLimit: 10). A
  //    provider per test, leaked whenever the login step failed before the
  //    per-test cleanup, previously overflowed the cap across CI retries
  //    (403 "You have reached the maximum number of SSO providers").
  let adminApi: APIRequestContext;
  let sharedProviderName: string;
  let sharedIdentityProviderId: string;

  test.beforeAll(async ({ playwright, browser }) => {
    test.setTimeout(240_000);

    adminApi = await playwright.request.newContext({
      storageState: adminAuthFile,
    });
    sharedProviderName = `EnterpriseManaged${Date.now()}`;
    sharedIdentityProviderId = await createIdentityProvider(
      adminApi,
      sharedProviderName,
      {
        // The admin signs in through this provider in a real browser. Two
        // fields are load-bearing for that login:
        //  - domain must cover admin@example.com so the SSO callback treats
        //    this (domainVerified) provider as trusted for account linking;
        //  - scopes must be pinned WITHOUT offline_access: with no scopes
        //    configured, better-auth's SSO sign-in defaults to
        //    ["openid","email","profile","offline_access"], and the e2e
        //    Keycloak realm rejects the code-for-token exchange with
        //    CODE_TO_TOKEN_ERROR "Offline tokens not allowed for the user or
        //    client", which the SSO callback collapses into
        //    "?error=invalid_provider&error_description=token_response_not_found".
        // Explicit authorization/token endpoints are deliberately NOT set:
        // the backend re-runs OIDC discovery at registration and overwrites
        // them anyway (identity-provider.ee.ts discoverOidcConfig), and the
        // discovered endpoints are the ones that work in CI.
        domain: SSO_DOMAIN,
        oidcConfig: {
          scopes: ["openid", "email", "profile"],
        },
        enterpriseManagedCredentials: {
          clientId: KEYCLOAK_OIDC.clientId,
          clientSecret: KEYCLOAK_OIDC.clientSecret,
          tokenEndpoint: KEYCLOAK_OIDC.tokenEndpoint,
          tokenEndpointAuthentication: "client_secret_post",
          subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
        },
      },
    );
    await linkAdminSsoAccount({
      browser,
      request: adminApi,
      providerName: sharedProviderName,
      identityProviderId: sharedIdentityProviderId,
    });
  });

  // Runs even when beforeAll failed part-way (e.g. the SSO login threw), so a
  // created provider never leaks into the next retry's providersLimit budget.
  test.afterAll(async () => {
    if (adminApi) {
      if (sharedIdentityProviderId) {
        await deleteIdentityProvider(adminApi, sharedIdentityProviderId);
      }
      await adminApi.dispose();
    }
  });

  test("installs a protected remote MCP server without a manual access token", async ({
    request,
    deleteMcpCatalogItem,
    uninstallMcpServer,
  }) => {
    test.setTimeout(300_000);

    await expectProtectedDemoServerHealthy(request);

    let catalogId: string | undefined;
    let serverId: string | undefined;

    try {
      const catalogName = `enterprise-managed-install-${Date.now()}`;
      catalogId = await createProtectedEnterpriseManagedCatalogItem({
        request,
        name: catalogName,
        identityProviderId: sharedIdentityProviderId,
      });

      const installResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/mcp_server",
        data: {
          name: catalogName,
          catalogId,
        },
      });
      const server = (await installResponse.json()) as { id: string };
      serverId = server.id;

      await waitForServerInstallation(request, serverId);

      const toolsResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/mcp_server/${serverId}/tools`,
      });
      const tools = (await toolsResponse.json()) as Array<{ name: string }>;

      expect(
        tools.some(
          (tool) =>
            tool.name ===
            `${catalogName}${MCP_SERVER_TOOL_NAME_SEPARATOR}${DEBUG_TOOL_SHORT_NAME}`,
        ),
      ).toBe(true);
    } finally {
      if (serverId) {
        await uninstallMcpServer(request, serverId);
      }
      if (catalogId) {
        await deleteMcpCatalogItem(request, catalogId);
      }
    }
  });

  test("uses per-user exchanged credentials for agent tool execution", async ({
    request,
    deleteMcpCatalogItem,
    uninstallMcpServer,
    deleteAgent,
  }) => {
    test.setTimeout(300_000);

    await expectProtectedDemoServerHealthy(request);

    const adminJwt = await getAdminKeycloakJwt();
    const memberJwt = await getMemberKeycloakJwt();

    let agentId: string | undefined;
    let catalogId: string | undefined;
    let serverId: string | undefined;

    try {
      agentId = await createProfile({
        request,
        name: `Enterprise Managed Agent ${Date.now()}`,
        agentType: "agent",
        identityProviderId: sharedIdentityProviderId,
      });

      const catalogName = `enterprise-managed-agent-${Date.now()}`;
      catalogId = await createProtectedEnterpriseManagedCatalogItem({
        request,
        name: catalogName,
        identityProviderId: sharedIdentityProviderId,
      });

      serverId = await installProtectedCatalogServer({
        request,
        catalogId,
        name: catalogName,
      });

      await waitForServerInstallation(request, serverId);

      const fullToolName = `${catalogName}${MCP_SERVER_TOOL_NAME_SEPARATOR}${DEBUG_TOOL_SHORT_NAME}`;
      const toolId = await waitForCatalogTool({
        request,
        fullToolName,
      });

      await assignEnterpriseManagedTool({
        request,
        agentId,
        toolId,
      });

      await waitForMcpGatewayJwtReady({
        request,
        profileId: agentId,
        token: adminJwt,
        expectedToolName: fullToolName,
      });

      const adminResult = await callDebugAuthTool({
        request,
        profileId: agentId,
        token: adminJwt,
        toolName: fullToolName,
      });
      expect(adminResult.authorizationHeader).toMatch(/^Bearer\s+/);
      expect(adminResult.bearerToken).not.toBe(adminJwt);
      expect(adminResult.tokenClaims.email).toBe("admin@example.com");
      expect(adminResult.tokenClaims.demoTokenValue).toBe("admin_user_token");

      const memberResult = await callDebugAuthTool({
        request,
        profileId: agentId,
        token: memberJwt,
        toolName: fullToolName,
      });
      expect(memberResult.authorizationHeader).toMatch(/^Bearer\s+/);
      expect(memberResult.bearerToken).not.toBe(memberJwt);
      expect(memberResult.tokenClaims.email).toBe("member@example.com");
      expect(memberResult.tokenClaims.demoTokenValue).toBe("member_user_token");
      expect(memberResult.bearerToken).not.toBe(adminResult.bearerToken);
    } finally {
      if (agentId) {
        await deleteAgent(request, agentId);
      }
      if (serverId) {
        await uninstallMcpServer(request, serverId);
      }
      if (catalogId) {
        await deleteMcpCatalogItem(request, catalogId);
      }
    }
  });

  test("uses per-user exchanged credentials for MCP gateway tool execution", async ({
    request,
    deleteMcpCatalogItem,
    uninstallMcpServer,
    deleteAgent,
  }) => {
    test.setTimeout(300_000);

    await expectProtectedDemoServerHealthy(request);

    const adminJwt = await getAdminKeycloakJwt();
    const memberJwt = await getMemberKeycloakJwt();

    let gatewayId: string | undefined;
    let catalogId: string | undefined;
    let serverId: string | undefined;

    try {
      gatewayId = await createProfile({
        request,
        name: `Enterprise Managed Gateway ${Date.now()}`,
        agentType: "mcp_gateway",
        identityProviderId: sharedIdentityProviderId,
      });

      const catalogName = `enterprise-managed-gateway-${Date.now()}`;
      catalogId = await createProtectedEnterpriseManagedCatalogItem({
        request,
        name: catalogName,
        identityProviderId: sharedIdentityProviderId,
      });

      serverId = await installProtectedCatalogServer({
        request,
        catalogId,
        name: catalogName,
      });

      await waitForServerInstallation(request, serverId);

      const fullToolName = `${catalogName}${MCP_SERVER_TOOL_NAME_SEPARATOR}${DEBUG_TOOL_SHORT_NAME}`;
      const toolId = await waitForCatalogTool({
        request,
        fullToolName,
      });

      await assignEnterpriseManagedTool({
        request,
        agentId: gatewayId,
        toolId,
      });

      await waitForMcpGatewayJwtReady({
        request,
        profileId: gatewayId,
        token: adminJwt,
        expectedToolName: fullToolName,
      });

      const adminResult = await callDebugAuthTool({
        request,
        profileId: gatewayId,
        token: adminJwt,
        toolName: fullToolName,
      });
      expect(adminResult.bearerToken).not.toBe(adminJwt);
      expect(adminResult.tokenClaims.email).toBe("admin@example.com");
      expect(adminResult.tokenClaims.demoTokenValue).toBe("admin_user_token");

      const memberResult = await callDebugAuthTool({
        request,
        profileId: gatewayId,
        token: memberJwt,
        toolName: fullToolName,
      });
      expect(memberResult.bearerToken).not.toBe(memberJwt);
      expect(memberResult.tokenClaims.email).toBe("member@example.com");
      expect(memberResult.tokenClaims.demoTokenValue).toBe("member_user_token");
      expect(memberResult.bearerToken).not.toBe(adminResult.bearerToken);
    } finally {
      if (gatewayId) {
        await deleteAgent(request, gatewayId);
      }
      if (serverId) {
        await uninstallMcpServer(request, serverId);
      }
      if (catalogId) {
        await deleteMcpCatalogItem(request, catalogId);
      }
    }
  });
});

async function expectProtectedDemoServerHealthy(
  request: APIRequestContext,
): Promise<void> {
  await waitForApiEndpointHealthy({
    request,
    url: `${MCP_SERVER_JWKS_EXTERNAL_URL}/health`,
    maxAttempts: 20,
    delayMs: 2000,
    description: `Protected demo MCP server at ${MCP_SERVER_JWKS_EXTERNAL_URL}/health`,
  });
}

/**
 * Install-time tool discovery for enterprise-managed catalogs refuses to run
 * unless the INSTALLING user has an SSO-linked better-auth account for the
 * catalog's identity provider: the backend resolves that account's token as
 * the RFC 8693 subject token (see getInstallDiscoveryAccessToken in
 * backend/src/routes/mcp-server.ts) and otherwise rejects the install with
 * "Sign in with SSO to link your identity provider…". The fixture admin is
 * password-authenticated, so the describe's beforeAll links it to the shared
 * Keycloak provider through a real browser OIDC login; account linking by
 * email (trusted provider + matching admin@example.com) attaches the Keycloak
 * tokens to the existing admin user.
 */
async function linkAdminSsoAccount(params: {
  browser: Browser;
  request: APIRequestContext;
  providerName: string;
  identityProviderId: string;
}): Promise<void> {
  const context = await params.browser.newContext({ storageState: undefined });
  try {
    const page = await context.newPage();
    await page.goto(`${UI_BASE_URL}/auth/sign-in`);
    await page.waitForLoadState("domcontentloaded");

    const ssoButton = page.getByRole("button", {
      name: new RegExp(params.providerName, "i"),
    });
    await expect(ssoButton).toBeVisible({ timeout: 15_000 });
    await ssoButton.click();

    if (!(await loginViaKeycloak(page))) {
      // loginViaKeycloak collapses every failure mode into a boolean; the URL
      // it landed on carries better-auth's ?error=…&error_description=… and
      // is the fastest way to diagnose a broken callback from CI output.
      throw new Error(
        `SSO login via ${params.providerName} did not produce a session; landed on ${page.url()}`,
      );
    }
  } finally {
    await context.close();
  }

  // The SSO callback persists the linked account row after the browser is
  // already redirected; poll until the backend reports a usable link so the
  // install below cannot race it.
  await expect(async () => {
    const response = await makeApiRequest({
      request: params.request,
      method: "get",
      urlSuffix: `/api/identity-providers/${params.identityProviderId}/link-status`,
    });
    const status = (await response.json()) as { connected: boolean };
    expect(status.connected).toBe(true);
  }).toPass({ timeout: 30_000, intervals: [500, 1000, 2000, 4000] });
}

async function createProfile(params: {
  request: APIRequestContext;
  name: string;
  agentType: "agent" | "mcp_gateway";
  identityProviderId: string;
}): Promise<string> {
  const response = await makeApiRequest({
    request: params.request,
    method: "post",
    urlSuffix: "/api/agents",
    data: {
      name: params.name,
      teams: [],
      scope: "org",
      agentType: params.agentType,
      identityProviderId: params.identityProviderId,
    },
  });

  const profile = (await response.json()) as { id: string };
  await waitForGatewayIdentityProviderReady({
    request: params.request,
    profileId: profile.id,
    identityProviderId: params.identityProviderId,
    agentType: params.agentType,
  });
  return profile.id;
}

async function createProtectedEnterpriseManagedCatalogItem(params: {
  request: APIRequestContext;
  name: string;
  identityProviderId?: string;
}): Promise<string> {
  const response = await makeApiRequest({
    request: params.request,
    method: "post",
    urlSuffix: "/api/internal_mcp_catalog",
    data: {
      name: params.name,
      description:
        "Protected demo MCP server for enterprise-managed credential exchange tests",
      serverType: "remote",
      serverUrl: `${MCP_SERVER_JWKS_BACKEND_URL}/mcp`,
      authMethod: "enterprise_managed",
      enterpriseManagedConfig: {
        identityProviderId: params.identityProviderId,
        requestedCredentialType: "bearer_token",
        resourceIdentifier: KEYCLOAK_OIDC.clientId,
        tokenInjectionMode: "authorization_bearer",
      },
    },
  });

  const catalog = (await response.json()) as { id: string };
  return catalog.id;
}

async function installProtectedCatalogServer(params: {
  request: APIRequestContext;
  catalogId: string;
  name: string;
  accessToken?: string;
}): Promise<string> {
  const response = await makeApiRequest({
    request: params.request,
    method: "post",
    urlSuffix: "/api/mcp_server",
    data: {
      name: params.name,
      catalogId: params.catalogId,
      ...(params.accessToken ? { accessToken: params.accessToken } : {}),
    },
  });

  const server = (await response.json()) as { id: string };
  return server.id;
}

async function waitForCatalogTool(params: {
  request: APIRequestContext;
  fullToolName: string;
}): Promise<string> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await makeApiRequest({
      request: params.request,
      method: "get",
      urlSuffix: "/api/tools?limit=200",
    });
    const data = (await response.json()) as
      | Array<{ id: string; name: string }>
      | { data?: Array<{ id: string; name: string }> };
    const tools = Array.isArray(data) ? data : (data.data ?? []);
    const tool = tools.find((item) => item.name === params.fullToolName);
    if (tool) {
      return tool.id;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(`Tool ${params.fullToolName} was not discovered in time`);
}

async function assignEnterpriseManagedTool(params: {
  request: APIRequestContext;
  agentId: string;
  toolId: string;
}): Promise<void> {
  await makeApiRequest({
    request: params.request,
    method: "post",
    urlSuffix: `/api/agents/${params.agentId}/tools/${params.toolId}`,
    data: {
      resolveAtCallTime: true,
      credentialResolutionMode: "enterprise_managed",
    },
  });
}

async function callDebugAuthTool(params: {
  request: APIRequestContext;
  profileId: string;
  token: string;
  toolName: string;
}): Promise<{
  authorizationHeader: string;
  bearerToken: string;
  tokenClaims: {
    email?: string;
    demoTokenValue?: string;
  };
}> {
  await initializeMcpSession(params.request, {
    profileId: params.profileId,
    token: params.token,
  });

  const result = await callMcpTool(params.request, {
    profileId: params.profileId,
    token: params.token,
    toolName: params.toolName,
    timeoutMs: 30000,
  });

  const responseText = result.content[0]?.text;
  expect(responseText).toBeTruthy();
  return JSON.parse(String(responseText));
}
