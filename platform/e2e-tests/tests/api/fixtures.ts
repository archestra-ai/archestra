/**
 * biome-ignore-all lint/correctness/noEmptyPattern: oddly enough in extend below this is required
 * see https://vitest.dev/guide/test-context.html#extend-test-context
 */
import { type APIRequestContext, test as base } from "@playwright/test";
import type { SupportedProvider } from "@shared";
import {
  API_BASE_URL,
  editorAuthFile,
  memberAuthFile,
  UI_BASE_URL,
  WIREMOCK_BASE_URL,
} from "../../consts";

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
  restartMcpServer: typeof restartMcpServer;
  createRole: typeof createRole;
  deleteRole: typeof deleteRole;
  waitForAgentTool: typeof waitForAgentTool;
  getTeamByName: typeof getTeamByName;
  addTeamMember: typeof addTeamMember;
  removeTeamMember: typeof removeTeamMember;
  getActiveOrganizationId: typeof getActiveOrganizationId;
  createOptimizationRule: typeof createOptimizationRule;
  deleteOptimizationRule: typeof deleteOptimizationRule;
  updateOptimizationRule: typeof updateOptimizationRule;
  createLimit: typeof createLimit;
  deleteLimit: typeof deleteLimit;
  getLimits: typeof getLimits;
  createTokenPrice: typeof createTokenPrice;
  deleteTokenPrice: typeof deleteTokenPrice;
  getTokenPrices: typeof getTokenPrices;
  getOrganization: typeof getOrganization;
  updateOrganization: typeof updateOrganization;
  getInteractions: typeof getInteractions;
  getWiremockRequests: typeof getWiremockRequests;
  clearWiremockRequests: typeof clearWiremockRequests;
  /** API request context authenticated as admin (same as default `request`) */
  adminRequest: APIRequestContext;
  /** API request context authenticated as editor */
  editorRequest: APIRequestContext;
  /** API request context authenticated as member */
  memberRequest: APIRequestContext;
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
    toolId: string;
    conditions: Array<{ key: string; operator: string; value: string }>;
    action:
      | "allow_when_context_is_untrusted"
      | "block_when_context_is_untrusted"
      | "block_always";
    reason?: string;
  },
) =>
  makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/autonomy-policies/tool-invocation",
    data: {
      toolId: policy.toolId,
      conditions: policy.conditions,
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
    toolId: string;
    conditions: Array<{ key: string; operator: string; value: string }>;
    action:
      | "block_always"
      | "mark_as_trusted"
      | "mark_as_untrusted"
      | "sanitize_with_dual_llm";
    description?: string;
  },
) =>
  makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/trusted-data-policies",
    data: {
      toolId: policy.toolId,
      conditions: policy.conditions,
      action: policy.action,
      description: policy.description,
    },
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
    teamId?: string;
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
 * Restart an MCP server (local servers only)
 * (authnz is handled by the authenticated session)
 */
const restartMcpServer = async (request: APIRequestContext, serverId: string) =>
  makeApiRequest({
    request,
    method: "post",
    urlSuffix: `/api/mcp_server/${serverId}/restart`,
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
 * In CI with parallel workers, tool registration can take longer due to resource contention.
 *
 * IMPORTANT: Uses server-side filtering by agentId to avoid pagination issues.
 * The default API limit is 20 items, so without filtering, the tool might not
 * appear in results if there are many agent-tools in the database.
 */
const waitForAgentTool = async (
  request: APIRequestContext,
  agentId: string,
  toolName: string,
  options?: {
    maxAttempts?: number;
    delayMs?: number;
  },
): Promise<{
  id: string;
  agent: { id: string };
  tool: { id: string; name: string };
}> => {
  // Increased defaults for CI stability: 20 attempts × 1000ms = 20 seconds total wait
  const maxAttempts = options?.maxAttempts ?? 20;
  const delayMs = options?.delayMs ?? 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Use server-side filtering by agentId and increase limit to avoid pagination issues
    const agentToolsResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/agent-tools?agentId=${agentId}&limit=100`,
      ignoreStatusCheck: true,
    });

    if (agentToolsResponse.ok()) {
      const agentTools = await agentToolsResponse.json();
      // Defense-in-depth: validate both agentId AND toolName client-side
      // in case the API silently ignores unknown query params
      const foundTool = agentTools.data.find(
        (at: { agent: { id: string }; tool: { id: string; name: string } }) =>
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

/**
 * Get a team by name (includes members)
 */
export const getTeamByName = async (
  request: APIRequestContext,
  teamName: string,
): Promise<{
  id: string;
  name: string;
  members: Array<{ userId: string; email: string }>;
}> => {
  const teamsResponse = await makeApiRequest({
    request,
    method: "get",
    urlSuffix: "/api/teams",
  });
  const teams = await teamsResponse.json();
  const team = teams.find((t: { name: string }) => t.name === teamName);
  if (!team) {
    throw new Error(`Team '${teamName}' not found`);
  }

  // Get team members
  const membersResponse = await makeApiRequest({
    request,
    method: "get",
    urlSuffix: `/api/teams/${team.id}/members`,
  });
  const members = await membersResponse.json();

  return { ...team, members };
};

/**
 * Add a member to a team
 */
const addTeamMember = async (
  request: APIRequestContext,
  teamId: string,
  userId: string,
  role: "member" | "owner" = "member",
) =>
  makeApiRequest({
    request,
    method: "post",
    urlSuffix: `/api/teams/${teamId}/members`,
    data: { userId, role },
  });

/**
 * Remove a member from a team
 */
export const removeTeamMember = async (
  request: APIRequestContext,
  teamId: string,
  userId: string,
) =>
  makeApiRequest({
    request,
    method: "delete",
    urlSuffix: `/api/teams/${teamId}/members/${userId}`,
  });

/**
 * Get the active organization ID from the current session
 */
const getActiveOrganizationId = async (
  request: APIRequestContext,
): Promise<string> => {
  const response = await makeApiRequest({
    request,
    method: "get",
    urlSuffix: "/api/auth/get-session",
  });
  const data = await response.json();
  const organizationId = data?.session?.activeOrganizationId;
  if (!organizationId) {
    throw new Error("Failed to get organization ID from session");
  }
  return organizationId;
};

/**
 * Optimization rule condition types
 */
type OptimizationRuleCondition = { maxLength: number } | { hasTools: boolean };

/**
 * Create an optimization rule
 * (authnz is handled by the authenticated session)
 */
const createOptimizationRule = async (
  request: APIRequestContext,
  rule: {
    entityType: "organization" | "team" | "agent";
    entityId: string;
    provider: SupportedProvider;
    conditions: OptimizationRuleCondition[];
    targetModel: string;
    enabled?: boolean;
  },
) =>
  makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/optimization-rules",
    data: {
      ...rule,
      enabled: rule.enabled ?? true,
    },
  });

/**
 * Update an optimization rule
 * (authnz is handled by the authenticated session)
 */
const updateOptimizationRule = async (
  request: APIRequestContext,
  ruleId: string,
  updates: {
    conditions?: OptimizationRuleCondition[];
    targetModel?: string;
    enabled?: boolean;
  },
) =>
  makeApiRequest({
    request,
    method: "put",
    urlSuffix: `/api/optimization-rules/${ruleId}`,
    data: updates,
  });

/**
 * Delete an optimization rule
 * (authnz is handled by the authenticated session)
 */
const deleteOptimizationRule = async (
  request: APIRequestContext,
  ruleId: string,
) =>
  makeApiRequest({
    request,
    method: "delete",
    urlSuffix: `/api/optimization-rules/${ruleId}`,
  });

/**
 * Create a limit (token cost, mcp_server_calls, or tool_calls)
 * (authnz is handled by the authenticated session)
 */
const createLimit = async (
  request: APIRequestContext,
  limit: {
    entityType: "organization" | "team" | "agent";
    entityId: string;
    limitType: "token_cost" | "mcp_server_calls" | "tool_calls";
    limitValue: number;
    model?: string[];
    mcpServerName?: string;
    toolName?: string;
  },
) =>
  makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/limits",
    data: limit,
  });

/**
 * Delete a limit by ID
 * (authnz is handled by the authenticated session)
 */
const deleteLimit = async (request: APIRequestContext, limitId: string) =>
  makeApiRequest({
    request,
    method: "delete",
    urlSuffix: `/api/limits/${limitId}`,
  });

/**
 * Get limits with optional filtering
 * (authnz is handled by the authenticated session)
 */
const getLimits = async (
  request: APIRequestContext,
  entityType?: "organization" | "team" | "agent",
  entityId?: string,
) => {
  const params = new URLSearchParams();
  if (entityType) params.append("entityType", entityType);
  if (entityId) params.append("entityId", entityId);
  const queryString = params.toString();
  return makeApiRequest({
    request,
    method: "get",
    urlSuffix: `/api/limits${queryString ? `?${queryString}` : ""}`,
  });
};

/**
 * Create a token price for a model
 * (authnz is handled by the authenticated session)
 */
const createTokenPrice = async (
  request: APIRequestContext,
  tokenPrice: {
    provider: SupportedProvider;
    model: string;
    pricePerMillionInput: string;
    pricePerMillionOutput: string;
  },
) =>
  makeApiRequest({
    request,
    method: "post",
    urlSuffix: "/api/token-prices",
    data: tokenPrice,
    ignoreStatusCheck: true, // May return 409 if already exists
  });

/**
 * Delete a token price by ID
 * (authnz is handled by the authenticated session)
 */
const deleteTokenPrice = async (
  request: APIRequestContext,
  tokenPriceId: string,
) =>
  makeApiRequest({
    request,
    method: "delete",
    urlSuffix: `/api/token-prices/${tokenPriceId}`,
    ignoreStatusCheck: true, // May already be deleted
  });

/**
 * Get all token prices
 * (authnz is handled by the authenticated session)
 */
const getTokenPrices = async (request: APIRequestContext) =>
  makeApiRequest({
    request,
    method: "get",
    urlSuffix: "/api/token-prices",
  });

/**
 * Get organization details
 * (authnz is handled by the authenticated session)
 */
const getOrganization = async (request: APIRequestContext) =>
  makeApiRequest({
    request,
    method: "get",
    urlSuffix: "/api/organization",
  });

/**
 * Update organization settings
 * (authnz is handled by the authenticated session)
 */
const updateOrganization = async (
  request: APIRequestContext,
  updates: {
    convertToolResultsToToon?: boolean;
    compressionScope?: "organization" | "team";
    globalToolPolicy?: "permissive" | "restrictive";
  },
) =>
  makeApiRequest({
    request,
    method: "patch",
    urlSuffix: "/api/organization",
    data: updates,
  });

/**
 * Get interactions with optional filtering by profileId
 * (authnz is handled by the authenticated session)
 */
const getInteractions = async (
  request: APIRequestContext,
  options?: {
    profileId?: string;
    limit?: number;
    offset?: number;
    sortBy?: string;
    sortDirection?: "asc" | "desc";
  },
) => {
  const params = new URLSearchParams();
  if (options?.profileId) params.append("profileId", options.profileId);
  if (options?.limit) params.append("limit", String(options.limit));
  if (options?.offset) params.append("offset", String(options.offset));
  if (options?.sortBy) params.append("sortBy", options.sortBy);
  if (options?.sortDirection)
    params.append("sortDirection", options.sortDirection);
  const queryString = params.toString();
  return makeApiRequest({
    request,
    method: "get",
    urlSuffix: `/api/interactions${queryString ? `?${queryString}` : ""}`,
  });
};

/**
 * WireMock request journal entry structure
 */
export interface WiremockRequest {
  id: string;
  request: {
    url: string;
    absoluteUrl: string;
    method: string;
    headers: Record<string, string>;
    body: string;
    loggedDate: number;
    loggedDateString: string;
  };
  responseDefinition: {
    status: number;
  };
}

/**
 * Get requests from WireMock's request journal
 * Useful for verifying what was actually sent to mock LLM providers
 */
const getWiremockRequests = async (
  request: APIRequestContext,
  options?: {
    limit?: number;
    method?: string;
    urlPattern?: string;
  },
): Promise<WiremockRequest[]> => {
  const params = new URLSearchParams();
  if (options?.limit) params.append("limit", String(options.limit));

  const queryString = params.toString();
  const response = await request.get(
    `${WIREMOCK_BASE_URL}/__admin/requests${queryString ? `?${queryString}` : ""}`,
  );
  const data = await response.json();

  let requests: WiremockRequest[] = data.requests || [];

  // Filter by method if specified
  if (options?.method) {
    requests = requests.filter(
      (r) => r.request.method.toUpperCase() === options.method?.toUpperCase(),
    );
  }

  // Filter by URL pattern if specified
  if (options?.urlPattern) {
    const pattern = new RegExp(options.urlPattern);
    requests = requests.filter((r) => pattern.test(r.request.url));
  }

  return requests;
};

/**
 * Clear WireMock's request journal
 * Useful for test isolation - call in beforeEach to ensure clean state
 */
const clearWiremockRequests = async (request: APIRequestContext) => {
  await request.delete(`${WIREMOCK_BASE_URL}/__admin/requests`);
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
  restartMcpServer: async ({}, use) => {
    await use(restartMcpServer);
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
  getTeamByName: async ({}, use) => {
    await use(getTeamByName);
  },
  addTeamMember: async ({}, use) => {
    await use(addTeamMember);
  },
  removeTeamMember: async ({}, use) => {
    await use(removeTeamMember);
  },
  getActiveOrganizationId: async ({}, use) => {
    await use(getActiveOrganizationId);
  },
  createOptimizationRule: async ({}, use) => {
    await use(createOptimizationRule);
  },
  deleteOptimizationRule: async ({}, use) => {
    await use(deleteOptimizationRule);
  },
  updateOptimizationRule: async ({}, use) => {
    await use(updateOptimizationRule);
  },
  createLimit: async ({}, use) => {
    await use(createLimit);
  },
  deleteLimit: async ({}, use) => {
    await use(deleteLimit);
  },
  getLimits: async ({}, use) => {
    await use(getLimits);
  },
  createTokenPrice: async ({}, use) => {
    await use(createTokenPrice);
  },
  deleteTokenPrice: async ({}, use) => {
    await use(deleteTokenPrice);
  },
  getTokenPrices: async ({}, use) => {
    await use(getTokenPrices);
  },
  getOrganization: async ({}, use) => {
    await use(getOrganization);
  },
  updateOrganization: async ({}, use) => {
    await use(updateOrganization);
  },
  getInteractions: async ({}, use) => {
    await use(getInteractions);
  },
  getWiremockRequests: async ({}, use) => {
    await use(getWiremockRequests);
  },
  clearWiremockRequests: async ({}, use) => {
    await use(clearWiremockRequests);
  },
  /**
   * Admin request - same auth as default `request` fixture
   */
  adminRequest: async ({ request }, use) => {
    // Default request is already admin (via storageState in config)
    await use(request);
  },
  /**
   * Editor request - creates a new request context with editor auth
   */
  editorRequest: async ({ playwright }, use) => {
    const context = await playwright.request.newContext({
      storageState: editorAuthFile,
    });
    await use(context);
    await context.dispose();
  },
  /**
   * Member request - creates a new request context with member auth
   */
  memberRequest: async ({ playwright }, use) => {
    const context = await playwright.request.newContext({
      storageState: memberAuthFile,
    });
    await use(context);
    await context.dispose();
  },
});
