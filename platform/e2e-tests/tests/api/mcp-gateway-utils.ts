/**
 * Shared MCP Gateway utilities for E2E tests
 */
import type { APIRequestContext, APIResponse } from "@playwright/test";
import {
  API_BASE_URL,
  MCP_GATEWAY_URL_SUFFIX,
  UI_BASE_URL,
} from "../../consts";

/**
 * Parse response based on content type.
 * Handles both JSON and SSE (Server-Sent Events) responses.
 */
export async function parseResponse(response: APIResponse): Promise<unknown> {
  const contentType = response.headers()["content-type"] || "";

  // If it's SSE, we need to parse the event stream
  if (contentType.includes("text/event-stream")) {
    const text = await response.text();
    // SSE format: "event: message\ndata: {json}\n\n"
    const lines = text.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const jsonStr = line.slice(6); // Remove "data: " prefix
        return JSON.parse(jsonStr);
      }
    }
    throw new Error(`No data found in SSE response: ${text}`);
  }

  // Otherwise assume JSON
  return response.json();
}

/**
 * Create MCP gateway request headers
 */
export function makeMcpGatewayRequestHeaders(
  token: string,
  sessionId?: string,
): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Origin: UI_BASE_URL,
    ...(sessionId && { "mcp-session-id": sessionId }),
  };
}

/**
 * Make an API request to the backend
 */
export async function makeApiRequest({
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
}) {
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
}

/**
 * Get organization token value
 * Note: profileId parameter is kept for backward compatibility but not used
 */
export async function getOrgTokenForProfile(
  request: APIRequestContext,
): Promise<string> {
  // Get all tokens (org token + team tokens)
  const tokensResponse = await makeApiRequest({
    request,
    method: "get",
    urlSuffix: "/api/tokens",
  });
  const tokensData = await tokensResponse.json();
  const orgToken = tokensData.tokens.find(
    (t: { isOrganizationToken: boolean }) => t.isOrganizationToken,
  );

  if (!orgToken) {
    throw new Error("No organization token found");
  }

  // Get the token value (don't rotate - causes race conditions in parallel tests)
  const valueResponse = await makeApiRequest({
    request,
    method: "get",
    urlSuffix: `/api/tokens/${orgToken.id}/value`,
  });
  const tokenData = await valueResponse.json();
  return tokenData.value;
}

/**
 * Initialize MCP session and return session ID
 *
 * @param profileId - If provided, uses new auth pattern: /v1/mcp/{profileId}
 *                    If not provided, uses legacy auth: /v1/mcp with token as profile ID
 * @param token - Either the profile ID (legacy) or archestra token (new auth)
 */
export async function initializeMcpSession(
  request: APIRequestContext,
  options: {
    profileId?: string;
    token: string;
  },
): Promise<string> {
  const { profileId, token } = options;

  // Build URL based on auth pattern
  const urlSuffix = profileId
    ? `${MCP_GATEWAY_URL_SUFFIX}/${profileId}`
    : MCP_GATEWAY_URL_SUFFIX;

  const initResponse = await makeApiRequest({
    request,
    method: "post",
    urlSuffix,
    headers: makeMcpGatewayRequestHeaders(token),
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

  const sessionId = initResponse.headers()["mcp-session-id"];
  if (!sessionId) {
    throw new Error("No mcp-session-id header in initialize response");
  }

  return sessionId;
}

/**
 * Call a tool via MCP gateway
 */
export async function callMcpTool(
  request: APIRequestContext,
  options: {
    profileId?: string;
    token: string;
    sessionId: string;
    toolName: string;
    arguments?: Record<string, unknown>;
  },
): Promise<{ content: Array<{ type: string; text?: string }> }> {
  const {
    profileId,
    token,
    sessionId,
    toolName,
    arguments: args = {},
  } = options;

  // Build URL based on auth pattern
  const urlSuffix = profileId
    ? `${MCP_GATEWAY_URL_SUFFIX}/${profileId}`
    : MCP_GATEWAY_URL_SUFFIX;

  const callToolResponse = await makeApiRequest({
    request,
    method: "post",
    urlSuffix,
    headers: makeMcpGatewayRequestHeaders(token, sessionId),
    data: {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
      },
    },
  });

  const callResult = await callToolResponse.json();

  if (callResult.error) {
    throw new Error(
      `Tool call failed: ${callResult.error.message} (code: ${callResult.error.code})`,
    );
  }

  return callResult.result;
}

/**
 * Get team token value by team name
 * @param teamName - The name of the team to get the token for
 * Note: profileId parameter is kept for backward compatibility but not used
 */
export async function getTeamTokenForProfile(
  request: APIRequestContext,
  teamName: string,
): Promise<string> {
  // Get all tokens (org token + team tokens)
  const tokensResponse = await makeApiRequest({
    request,
    method: "get",
    urlSuffix: "/api/tokens",
  });
  const tokensData = await tokensResponse.json();

  // Find the team token by team name
  const teamToken = tokensData.tokens.find(
    (t: { isOrganizationToken: boolean; team?: { name: string } }) =>
      !t.isOrganizationToken && t.team?.name === teamName,
  );

  if (!teamToken) {
    throw new Error(`No team token found for team ${teamName}`);
  }

  // Get the token value (don't rotate - causes race conditions in parallel tests)
  const valueResponse = await makeApiRequest({
    request,
    method: "get",
    urlSuffix: `/api/tokens/${teamToken.id}/value`,
  });
  const tokenData = await valueResponse.json();
  return tokenData.value;
}

/**
 * List tools available via MCP gateway
 */
export async function listMcpTools(
  request: APIRequestContext,
  options: {
    profileId?: string;
    token: string;
    sessionId: string;
  },
): Promise<
  Array<{ name: string; description?: string; inputSchema?: unknown }>
> {
  const { profileId, token, sessionId } = options;

  // Build URL based on auth pattern
  const urlSuffix = profileId
    ? `${MCP_GATEWAY_URL_SUFFIX}/${profileId}`
    : MCP_GATEWAY_URL_SUFFIX;

  const listToolsResponse = await makeApiRequest({
    request,
    method: "post",
    urlSuffix,
    headers: makeMcpGatewayRequestHeaders(token, sessionId),
    data: {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    },
  });

  const listResult = await listToolsResponse.json();

  if (listResult.error) {
    throw new Error(
      `List tools failed: ${listResult.error.message} (code: ${listResult.error.code})`,
    );
  }

  return listResult.result.tools;
}

/**
 * Assign all Archestra tools to a profile
 * This is required because Archestra tools are not auto-assigned to profiles.
 * @returns Array of assigned tool IDs
 */
export async function assignArchestraToolsToProfile(
  request: APIRequestContext,
  profileId: string,
): Promise<string[]> {
  // 1. Get all tools
  const toolsResponse = await makeApiRequest({
    request,
    method: "get",
    urlSuffix: "/api/tools",
  });
  const tools = await toolsResponse.json();

  // 2. Filter for Archestra tools (name starts with "archestra__")
  const archestraTools = tools.filter((t: { name: string }) =>
    t.name.startsWith("archestra__"),
  );

  // 3. Assign each archestra tool to the profile
  const assignedToolIds: string[] = [];
  for (const tool of archestraTools) {
    await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/api/agents/${profileId}/tools/${tool.id}`,
      data: {},
    });
    assignedToolIds.push(tool.id);
  }

  return assignedToolIds;
}
