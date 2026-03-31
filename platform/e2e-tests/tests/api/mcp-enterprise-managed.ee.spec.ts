import type { APIRequestContext } from "@playwright/test";
import {
  KEYCLOAK_OIDC,
  MCP_SERVER_JWKS_BACKEND_URL,
  MCP_SERVER_JWKS_EXTERNAL_URL,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "../../consts";
import {
  getAdminKeycloakJwt,
  getMemberKeycloakJwt,
  waitForApiEndpointHealthy,
  waitForServerInstallation,
} from "../../utils";
import { expect, test } from "./fixtures";
import {
  callMcpTool,
  initializeMcpSession,
  listMcpTools,
  makeApiRequest,
} from "./mcp-gateway-utils";

const DEBUG_TOOL_SHORT_NAME = "debug-auth-token";

test.describe("Enterprise-managed MCP credentials", () => {
  test.skip("installs a protected remote MCP server without a manual access token", async ({
    request,
    createIdentityProvider,
    deleteIdentityProvider,
    deleteMcpCatalogItem,
    uninstallMcpServer,
  }) => {
    test.slow();

    await expectProtectedDemoServerHealthy(request);

    const providerName = `EnterpriseManagedInstall${Date.now()}`;
    const identityProviderId = await createIdentityProvider(
      request,
      providerName,
      {
        enterpriseManagedCredentials: {
          clientId: KEYCLOAK_OIDC.clientId,
          clientSecret: KEYCLOAK_OIDC.clientSecret,
          tokenEndpoint: KEYCLOAK_OIDC.tokenEndpoint,
          tokenEndpointAuthentication: "client_secret_post",
          subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
        },
      },
    );

    let catalogId: string | undefined;
    let serverId: string | undefined;

    try {
      const catalogName = `enterprise-managed-install-${Date.now()}`;
      catalogId = await createProtectedEnterpriseManagedCatalogItem({
        request,
        name: catalogName,
        identityProviderId,
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
      await deleteIdentityProvider(request, identityProviderId);
    }
  });

  test("uses per-user exchanged credentials for agent tool execution", async ({
    request,
    createIdentityProvider,
    deleteIdentityProvider,
    deleteMcpCatalogItem,
    uninstallMcpServer,
    deleteAgent,
  }) => {
    test.slow();

    await expectProtectedDemoServerHealthy(request);

    const adminJwt = await getAdminKeycloakJwt();
    const memberJwt = await getMemberKeycloakJwt();
    const providerName = `EnterpriseManagedAgent${Date.now()}`;
    const identityProviderId = await createIdentityProvider(
      request,
      providerName,
      {
        enterpriseManagedCredentials: {
          clientId: KEYCLOAK_OIDC.clientId,
          clientSecret: KEYCLOAK_OIDC.clientSecret,
          tokenEndpoint: KEYCLOAK_OIDC.tokenEndpoint,
          tokenEndpointAuthentication: "client_secret_post",
          subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
        },
      },
    );

    let agentId: string | undefined;
    let catalogId: string | undefined;
    let serverId: string | undefined;

    try {
      agentId = await createProfile({
        request,
        name: `Enterprise Managed Agent ${Date.now()}`,
        agentType: "agent",
        identityProviderId,
      });

      const catalogName = `enterprise-managed-agent-${Date.now()}`;
      catalogId = await createProtectedEnterpriseManagedCatalogItem({
        request,
        name: catalogName,
      });

      serverId = await installProtectedCatalogServer({
        request,
        catalogId,
        name: catalogName,
        accessToken: adminJwt,
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

      await waitForGatewayTool({
        request,
        profileId: agentId,
        token: adminJwt,
        toolName: fullToolName,
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
      await deleteIdentityProvider(request, identityProviderId);
    }
  });

  test("uses per-user exchanged credentials for MCP gateway tool execution", async ({
    request,
    createIdentityProvider,
    deleteIdentityProvider,
    deleteMcpCatalogItem,
    uninstallMcpServer,
    deleteAgent,
  }) => {
    test.slow();

    await expectProtectedDemoServerHealthy(request);

    const adminJwt = await getAdminKeycloakJwt();
    const memberJwt = await getMemberKeycloakJwt();
    const providerName = `EnterpriseManagedGateway${Date.now()}`;
    const identityProviderId = await createIdentityProvider(
      request,
      providerName,
      {
        enterpriseManagedCredentials: {
          clientId: KEYCLOAK_OIDC.clientId,
          clientSecret: KEYCLOAK_OIDC.clientSecret,
          tokenEndpoint: KEYCLOAK_OIDC.tokenEndpoint,
          tokenEndpointAuthentication: "client_secret_post",
          subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
        },
      },
    );

    let gatewayId: string | undefined;
    let catalogId: string | undefined;
    let serverId: string | undefined;

    try {
      gatewayId = await createProfile({
        request,
        name: `Enterprise Managed Gateway ${Date.now()}`,
        agentType: "mcp_gateway",
        identityProviderId,
      });

      const catalogName = `enterprise-managed-gateway-${Date.now()}`;
      catalogId = await createProtectedEnterpriseManagedCatalogItem({
        request,
        name: catalogName,
      });

      serverId = await installProtectedCatalogServer({
        request,
        catalogId,
        name: catalogName,
        accessToken: adminJwt,
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

      await waitForGatewayTool({
        request,
        profileId: gatewayId,
        token: adminJwt,
        toolName: fullToolName,
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
      await deleteIdentityProvider(request, identityProviderId);
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
  accessToken: string;
}): Promise<string> {
  const response = await makeApiRequest({
    request: params.request,
    method: "post",
    urlSuffix: "/api/mcp_server",
    data: {
      name: params.name,
      catalogId: params.catalogId,
      accessToken: params.accessToken,
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

async function waitForGatewayTool(params: {
  request: APIRequestContext;
  profileId: string;
  token: string;
  toolName: string;
}): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await initializeMcpSession(params.request, {
      profileId: params.profileId,
      token: params.token,
    });
    const tools = await listMcpTools(params.request, {
      profileId: params.profileId,
      token: params.token,
    });
    if (tools.some((tool) => tool.name === params.toolName)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  throw new Error(`Tool ${params.toolName} was not exposed by the MCP gateway`);
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
