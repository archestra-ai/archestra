/**
 * biome-ignore-all lint/correctness/noEmptyPattern: oddly enough in extend below this is required
 * see https://vitest.dev/guide/test-context.html#extend-test-context
 */
import { type APIRequestContext, test as base } from "@playwright/test";
import { API_BASE_URL, UI_BASE_URL } from "../../consts";

/**
 * Playwright test extension with fixtures
 * https://playwright.dev/docs/test-fixtures#creating-a-fixture
 */
export interface TestFixtures {
  makeApiRequest: typeof makeApiRequest;
  createAgent: typeof createAgent;
  deleteAgent: typeof deleteAgent;
  createApiKey: typeof createApiKey;
  deleteApiKey: typeof deleteApiKey;
  createToolInvocationPolicy: typeof createToolInvocationPolicy;
  deleteToolInvocationPolicy: typeof deleteToolInvocationPolicy;
  createTrustedDataPolicy: typeof createTrustedDataPolicy;
  deleteTrustedDataPolicy: typeof deleteTrustedDataPolicy;
  createMcpCatalogItem: typeof createMcpCatalogItem;
  deleteMcpCatalogItem: typeof deleteMcpCatalogItem;
  installMcpServer: typeof installMcpServer;
  uninstallMcpServer: typeof uninstallMcpServer;
  createRole: typeof createRole;
  deleteRole: typeof deleteRole;
  waitForAgentTool: typeof waitForAgentTool;
}

const makeApiRequest = async ({
  request,
  method,
  urlSuffix,
  data = null,
  headers = {
    "Content-Type": "application/json",
    Origin: UI_BASE_URL,
  },
  ignoreStatusCheck = false,
}: {
  request: APIRequestContext;
  method: "get" | "post" | "put" | "patch" | "delete";
  urlSuffix: string;
  data?: unknown;
  headers?: Record<string, string>;
  ignoreStatusCheck?: boolean;
}) => {
  const response = await request[method](`${API_BASE_URL}${urlSuffix}`, {
    headers,
    data,
  });

  if (!ignoreStatusCheck && !response.ok()) {
    throw new Error(
      `Failed to ${method} ${urlSuffix} with data ${JSON.stringify(
        data,
      )}: ${response.status()} ${await response.text()}`,
    );
  }

  return response;
};

/**
 * Create an agent
 * (authnz is handled by the authenticated session)
 */
const createAgent = async (request: APIRequestContext, name: string) =>
  makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/agents",
    data: {
      name,
      teams: [],
    },
  });

/**
 * Delete an agent
 * (authnz is handled by the authenticated session)
 */
const deleteAgent = async (request: APIRequestContext, agentId: string) =>
  makeApiRequest({
    request,
    method: "delete",
    urlSuffix: `/api/agents/${agentId}`,
  });

/**
 * Create an API key
 * (authnz is handled by the authenticated session)
 */
const createApiKey = async (
  request: APIRequestContext,
  name: string = "Test API Key",
) =>
  makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/auth/api-key/create",
    data: {
      name,
      expiresIn: 60 * 60 * 24 * 7, // 1 week
    },
  });

/**
 * Delete an API key by ID
 * (authnz is handled by the authenticated session)
 */
const deleteApiKey = async (request: APIRequestContext, keyId: string) =>
  makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/auth/api-key/delete",
    data: {
      keyId,
    },
  });

/**
 * Create a tool invocation policy
 * (authnz is handled by the authenticated session)
 */
const createToolInvocationPolicy = async (
  request: APIRequestContext,
  policy: {
    agentToolId: string;
    argumentPath: string;
    operator: string;
    value: string;
    action: "allow_when_context_is_untrusted" | "block_always";
    reason?: string;
  },
) =>
  makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/autonomy-policies/tool-invocation",
    data: {
      agentToolId: policy.agentToolId,
      argumentName: policy.argumentPath, // argumentPath maps to argumentName in the schema
      operator: policy.operator,
      value: policy.value,
      action: policy.action,
      reason: policy.reason,
    },
  });

/**
 * Delete a tool invocation policy
 * (authnz is handled by the authenticated session)
 */
const deleteToolInvocationPolicy = async (
  request: APIRequestContext,
  policyId: string,
) =>
  makeApiRequest({
    request,
    method: "delete",
    urlSuffix: `/api/autonomy-policies/tool-invocation/${policyId}`,
  });

/**
 * Create a trusted data policy
 * (authnz is handled by the authenticated session)
 */
const createTrustedDataPolicy = async (
  request: APIRequestContext,
  policy: {
    agentToolId: string;
    description: string;
    attributePath: string;
    operator: string;
    value: string;
    action: "block_always" | "mark_as_trusted" | "sanitize_with_dual_llm";
  },
) =>
  makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/trusted-data-policies",
    data: policy,
  });

/**
 * Delete a trusted data policy
 * (authnz is handled by the authenticated session)
 */
const deleteTrustedDataPolicy = async (
  request: APIRequestContext,
  policyId: string,
) =>
  makeApiRequest({
    request,
    method: "delete",
    urlSuffix: `/api/trusted-data-policies/${policyId}`,
  });

/**
 * Create an MCP catalog item
 * (authnz is handled by the authenticated session)
 */
const createMcpCatalogItem = async (
  request: APIRequestContext,
  catalogItem: {
    name: string;
    description: string;
    serverType: "local" | "remote";
    localConfig?: unknown;
    serverUrl?: string;
    authFields?: unknown;
  },
) =>
  makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/internal_mcp_catalog",
    data: catalogItem,
  });

/**
 * Delete an MCP catalog item
 * (authnz is handled by the authenticated session)
 */
const deleteMcpCatalogItem = async (
  request: APIRequestContext,
  catalogId: string,
) =>
  makeApiRequest({
    request,
    method: "delete",
    urlSuffix: `/api/internal_mcp_catalog/${catalogId}`,
  });

/**
 * Install an MCP server
 * (authnz is handled by the authenticated session)
 */
const installMcpServer = async (
  request: APIRequestContext,
  serverData: {
    name: string;
    catalogId?: string;
    teams?: string[];
    userConfigValues?: Record<string, string>;
    environmentValues?: Record<string, string>;
    accessToken?: string;
  },
) =>
  makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/mcp_server",
    data: serverData,
  });

/**
 * Uninstall an MCP server
 * (authnz is handled by the authenticated session)
 */
const uninstallMcpServer = async (
  request: APIRequestContext,
  serverId: string,
) =>
  makeApiRequest({
    request,
    method: "delete",
    urlSuffix: `/api/mcp_server/${serverId}`,
  });

/**
 * Create a custom role
 * (authnz is handled by the authenticated session)
 */
const createRole = async (
  request: APIRequestContext,
  roleData: {
    name: string;
    permission: Record<string, string[]>;
  },
) =>
  makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/roles",
    data: roleData,
  });

/**
 * Delete a role by ID
 * (authnz is handled by the authenticated session)
 */
const deleteRole = async (request: APIRequestContext, roleId: string) =>
  makeApiRequest({
    request,
    method: "delete",
    urlSuffix: `/api/roles/${roleId}`,
  });

/**
 * Wait for an agent-tool to be registered with retry/polling logic.
 * This helps avoid race conditions when a tool is registered asynchronously.
 */
const waitForAgentTool = async (
  request: APIRequestContext,
  agentId: string,
  toolName: string,
  options?: {
    maxAttempts?: number;
    delayMs?: number;
  },
): Promise<{ id: string; agent: { id: string }; tool: { name: string } }> => {
  const maxAttempts = options?.maxAttempts ?? 10;
  const delayMs = options?.delayMs ?? 500;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const agentToolsResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/agent-tools",
    });

    if (agentToolsResponse.ok()) {
      const agentTools = await agentToolsResponse.json();
      const foundTool = agentTools.data.find(
        (at: { agent: { id: string }; tool: { name: string } }) =>
          at.agent.id === agentId && at.tool.name === toolName,
      );

      if (foundTool) {
        return foundTool;
      }
    }

    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error(
    `Agent-tool '${toolName}' for agent '${agentId}' not found after ${maxAttempts} attempts`,
  );
};

export * from "@playwright/test";
export const test = base.extend<TestFixtures>({
  makeApiRequest: async ({}, use) => {
    await use(makeApiRequest);
  },
  createAgent: async ({}, use) => {
    await use(createAgent);
  },
  deleteAgent: async ({}, use) => {
    await use(deleteAgent);
  },
  createApiKey: async ({}, use) => {
    await use(createApiKey);
  },
  deleteApiKey: async ({}, use) => {
    await use(deleteApiKey);
  },
  createToolInvocationPolicy: async ({}, use) => {
    await use(createToolInvocationPolicy);
  },
  deleteToolInvocationPolicy: async ({}, use) => {
    await use(deleteToolInvocationPolicy);
  },
  createTrustedDataPolicy: async ({}, use) => {
    await use(createTrustedDataPolicy);
  },
  deleteTrustedDataPolicy: async ({}, use) => {
    await use(deleteTrustedDataPolicy);
  },
  createMcpCatalogItem: async ({}, use) => {
    await use(createMcpCatalogItem);
  },
  deleteMcpCatalogItem: async ({}, use) => {
    await use(deleteMcpCatalogItem);
  },
  installMcpServer: async ({}, use) => {
    await use(installMcpServer);
  },
  uninstallMcpServer: async ({}, use) => {
    await use(uninstallMcpServer);
  },
  createRole: async ({}, use) => {
    await use(createRole);
  },
  deleteRole: async ({}, use) => {
    await use(deleteRole);
  },
  waitForAgentTool: async ({}, use) => {
    await use(waitForAgentTool);
  },
});
