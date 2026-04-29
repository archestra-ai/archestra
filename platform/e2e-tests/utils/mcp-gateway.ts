import {
  type APIRequestContext,
  type APIResponse,
  expect,
  type Page,
} from "@playwright/test";
import { archestraApiSdk, getManageCredentialsButtonTestId } from "@shared";
import {
  DEFAULT_TEAM_NAME,
  E2eTestId,
  ENGINEERING_TEAM_NAME,
  getE2eRequestUrl,
  MARKETING_TEAM_NAME,
  MCP_GATEWAY_URL_SUFFIX,
  UI_BASE_URL,
} from "../consts";
import { closeOpenDialogs } from "./dialogs";

export async function verifyToolCallResultViaApi({
  request,
  expectedResult,
  tokenToUse,
  toolName,
  profileId,
}: {
  request: APIRequestContext;
  expectedResult:
    | "Admin-personal-credential"
    | "Editor-personal-credential"
    | "Member-personal-credential"
    | "AnySuccessText"
    | "Error"
    | string;
  tokenToUse:
    | "default-team"
    | "engineering-team"
    | "marketing-team"
    | "org-token";
  toolName: string;
  profileId: string;
}) {
  const effectiveProfileId = profileId;

  let token: string;
  if (tokenToUse === "default-team") {
    token = await getTeamTokenForProfile(request, DEFAULT_TEAM_NAME);
  } else if (tokenToUse === "engineering-team") {
    token = await getTeamTokenForProfile(request, ENGINEERING_TEAM_NAME);
  } else if (tokenToUse === "marketing-team") {
    token = await getTeamTokenForProfile(request, MARKETING_TEAM_NAME);
  } else {
    token = await getOrgTokenForProfile(request);
  }

  let toolResult: Awaited<ReturnType<typeof callMcpTool>>;

  try {
    toolResult = await callMcpTool(request, {
      profileId: effectiveProfileId,
      token,
      toolName,
      timeoutMs: 60_000,
    });
  } catch (error) {
    if (expectedResult === "Error") {
      return;
    }
    throw error;
  }

  const textContent = toolResult.content.find(
    (content) => content.type === "text",
  );
  if (expectedResult === "AnySuccessText") {
    return;
  }

  if (
    !textContent?.text?.includes(expectedResult) &&
    expectedResult !== "Error"
  ) {
    throw new Error(
      `Expected tool result to contain "${expectedResult}" but got "${textContent?.text}"`,
    );
  }
}

export function makeMcpGatewayRequestHeaders(
  token: string,
): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Origin: UI_BASE_URL,
  };
}

export async function makeApiRequest(params: {
  request: APIRequestContext;
  method: "get" | "post" | "put" | "patch" | "delete";
  urlSuffix: string;
  data?: unknown;
  headers?: Record<string, string>;
  ignoreStatusCheck?: boolean;
  timeoutMs?: number;
}) {
  const requestUrl = getE2eRequestUrl(params.urlSuffix);
  const requestOptions = {
    headers: params.headers ?? {
      "Content-Type": "application/json",
      Origin: UI_BASE_URL,
    },
    data: params.data ?? null,
    timeout: params.timeoutMs,
  };
  let response: APIResponse;

  switch (params.method) {
    case "get":
      response = await params.request.get(requestUrl, requestOptions);
      break;
    case "post":
      response = await params.request.post(requestUrl, requestOptions);
      break;
    case "put":
      response = await params.request.put(requestUrl, requestOptions);
      break;
    case "patch":
      response = await params.request.patch(requestUrl, requestOptions);
      break;
    case "delete":
      response = await params.request.delete(requestUrl, requestOptions);
      break;
  }

  if (!params.ignoreStatusCheck && !response.ok()) {
    throw new Error(
      `Failed to ${params.method} ${params.urlSuffix} with data ${JSON.stringify(
        params.data ?? null,
      )}: ${response.status()} ${await response.text()}`,
    );
  }

  return response;
}

export async function getOrgTokenForProfile(
  request: APIRequestContext,
): Promise<string> {
  const tokensResponse = await makeApiRequest({
    request,
    method: "get",
    urlSuffix: "/api/tokens",
  });
  const tokensData = await tokensResponse.json();
  const orgToken = tokensData.tokens.find(
    (token: { isOrganizationToken: boolean }) => token.isOrganizationToken,
  );

  if (!orgToken) {
    throw new Error("No organization token found");
  }

  const valueResponse = await makeApiRequest({
    request,
    method: "get",
    urlSuffix: `/api/tokens/${orgToken.id}/value`,
  });
  return (await valueResponse.json()).value;
}

export async function initializeMcpSession(
  request: APIRequestContext,
  options: {
    profileId: string;
    token: string;
  },
): Promise<void> {
  await makeApiRequest({
    request,
    method: "post",
    urlSuffix: `${MCP_GATEWAY_URL_SUFFIX}/${options.profileId}`,
    headers: makeMcpGatewayRequestHeaders(options.token),
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
}

export async function waitForGatewayIdentityProviderReady(params: {
  request: APIRequestContext;
  profileId: string;
  identityProviderId: string;
  agentType?: "agent" | "mcp_gateway";
}): Promise<void> {
  await expect(async () => {
    const response = await makeApiRequest({
      request: params.request,
      method: "get",
      urlSuffix: `/api/agents/${params.profileId}`,
    });
    const agent = (await response.json()) as {
      identityProviderId?: string | null;
      agentType?: "agent" | "mcp_gateway" | "profile" | "llm_proxy";
    };

    expect(agent.identityProviderId).toBe(params.identityProviderId);
    if (params.agentType) {
      expect(agent.agentType).toBe(params.agentType);
    }
  }).toPass({ timeout: 30_000, intervals: [500, 1000, 2000, 4000] });
}

export async function callMcpTool(
  request: APIRequestContext,
  options: {
    profileId: string;
    token: string;
    toolName: string;
    arguments?: Record<string, unknown>;
    timeoutMs?: number;
  },
): Promise<{ content: Array<{ type: string; text?: string }> }> {
  const callToolResponse = await makeApiRequest({
    request,
    method: "post",
    urlSuffix: `${MCP_GATEWAY_URL_SUFFIX}/${options.profileId}`,
    headers: makeMcpGatewayRequestHeaders(options.token),
    data: {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: options.toolName,
        arguments: options.arguments ?? {},
      },
    },
    timeoutMs: options.timeoutMs,
  });

  const callResult = await callToolResponse.json();
  if (callResult.error) {
    throw new Error(
      `Tool call failed: ${callResult.error.message} (code: ${callResult.error.code})`,
    );
  }

  return callResult.result;
}

export async function getTeamTokenForProfile(
  request: APIRequestContext,
  teamName: string,
): Promise<string> {
  const tokensResponse = await makeApiRequest({
    request,
    method: "get",
    urlSuffix: "/api/tokens",
  });
  const tokensData = await tokensResponse.json();
  const teamToken = tokensData.tokens.find(
    (token: { isOrganizationToken: boolean; team?: { name: string } }) =>
      !token.isOrganizationToken && token.team?.name === teamName,
  );

  if (!teamToken) {
    throw new Error(`No team token found for team ${teamName}`);
  }

  const valueResponse = await makeApiRequest({
    request,
    method: "get",
    urlSuffix: `/api/tokens/${teamToken.id}/value`,
  });
  return (await valueResponse.json()).value;
}

export async function listMcpTools(
  request: APIRequestContext,
  options: {
    profileId: string;
    token: string;
  },
): Promise<
  Array<{ name: string; description?: string; inputSchema?: unknown }>
> {
  const listToolsResponse = await makeApiRequest({
    request,
    method: "post",
    urlSuffix: `${MCP_GATEWAY_URL_SUFFIX}/${options.profileId}`,
    headers: makeMcpGatewayRequestHeaders(options.token),
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

export async function assignArchestraToolsToProfile(
  request: APIRequestContext,
  profileId: string,
): Promise<string[]> {
  const toolsResponse = await makeApiRequest({
    request,
    method: "get",
    urlSuffix: "/api/tools",
  });
  const tools = await toolsResponse.json();
  const archestraTools = tools.filter((tool: { name: string }) =>
    tool.name.startsWith("archestra__"),
  );

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

export async function openManageCredentialsDialog(
  page: Page,
  catalogItemName: string,
): Promise<void> {
  const searchInput = page.getByRole("textbox", {
    name: "Search MCP servers by name",
  });
  if (await searchInput.isVisible().catch(() => false)) {
    await searchInput.fill(catalogItemName);
  }

  const targetCard = page.getByTestId(
    `${E2eTestId.McpServerCard}-${catalogItemName}`,
  );
  const settingsDialog = page.getByRole("dialog", {
    name: new RegExp(`^${escapeRegExp(catalogItemName)} Settings$`),
  });
  const connectionsNavButton = settingsDialog.getByTestId(
    E2eTestId.McpServerSettingsConnectionsNavButton,
  );
  const connectionsHeading = settingsDialog.getByRole("heading", {
    name: "Connections",
    exact: true,
  });
  if (await settingsDialog.isVisible().catch(() => false)) {
    if (!(await connectionsHeading.isVisible().catch(() => false))) {
      await connectionsNavButton.click();
    }
    await expect(connectionsHeading).toBeVisible({ timeout: 10_000 });
    return;
  }

  const standaloneDialog = page.getByTestId(E2eTestId.ManageCredentialsDialog);
  if (await standaloneDialog.isVisible().catch(() => false)) {
    return;
  }

  await expect(async () => {
    if (await settingsDialog.isVisible().catch(() => false)) {
      if (!(await connectionsHeading.isVisible().catch(() => false))) {
        await connectionsNavButton.click();
      }
      await expect(connectionsHeading).toBeVisible({ timeout: 2_000 });
      return;
    }

    if (await standaloneDialog.isVisible().catch(() => false)) {
      return;
    }

    const anyVisibleDialog = page.getByRole("dialog").filter({ visible: true });
    if ((await anyVisibleDialog.count()) > 0) {
      await closeOpenDialogs(page, { timeoutMs: 3_000 });
    }

    await expect(targetCard).toBeVisible({ timeout: 2_000 });

    const manageButton = targetCard.getByTestId(
      getManageCredentialsButtonTestId(catalogItemName),
    );
    const deploymentButton = targetCard.getByRole("button", {
      name: /^\d+\/\d+$/,
    });

    if (await manageButton.isVisible().catch(() => false)) {
      await manageButton.click({ force: true });
    } else {
      await expect(deploymentButton).toBeVisible({ timeout: 5_000 });
      await deploymentButton.click();
    }

    await expect(settingsDialog).toBeVisible({ timeout: 2_000 });
    if (!(await connectionsHeading.isVisible().catch(() => false))) {
      await connectionsNavButton.click();
    }
    await expect(connectionsHeading).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 10_000, intervals: [250, 500, 1000] });
}

export async function getVisibleCredentials(page: Page): Promise<string[]> {
  const visibleDialog = page
    .getByRole("dialog")
    .filter({ visible: true })
    .last();
  const connectionsNavButton = visibleDialog.getByRole("button", {
    name: /^Connections\b/,
  });
  const badgeText =
    (await connectionsNavButton.textContent().catch(() => "")) ?? "";
  const expectedConnectionCount = Number.parseInt(
    badgeText.match(/\d+/)?.[0] ?? "0",
    10,
  );

  if (expectedConnectionCount > 0) {
    await expect
      .poll(
        async () =>
          await visibleDialog.getByTestId(E2eTestId.CredentialOwner).count(),
        { timeout: 10_000, intervals: [250, 500, 1000] },
      )
      .toBeGreaterThan(0);
  }

  return await visibleDialog
    .getByTestId(E2eTestId.CredentialOwner)
    .allTextContents();
}

export async function getVisibleStaticCredentials(
  page: Page,
): Promise<string[]> {
  const credentialLabels = await page
    .getByTestId(E2eTestId.StaticCredentialToUse)
    .allTextContents();

  return credentialLabels.map(stripStaticCredentialDescription);
}

function stripStaticCredentialDescription(text: string): string {
  const [labelBeforeTeamDescription, teamDescription] =
    text.split("Shared with team");
  if (teamDescription !== undefined) {
    return labelBeforeTeamDescription.trim() || teamDescription.trim();
  }

  return text.split("Owned by")[0].trim();
}

export async function createSharedTestGatewayViaApi({
  cookieHeaders,
  gatewayName,
}: {
  cookieHeaders: string;
  gatewayName: string;
}): Promise<{ id: string; name: string }> {
  const teamsResponse = await archestraApiSdk.getTeams({
    headers: { Cookie: cookieHeaders },
  });
  if (teamsResponse.error) {
    throw new Error(
      `Failed to get teams: ${JSON.stringify(teamsResponse.error)}`,
    );
  }
  const teams = teamsResponse.data?.data ?? [];
  if (teams.length === 0) {
    throw new Error(
      `No teams returned from API. Response: ${JSON.stringify(teamsResponse)}`,
    );
  }

  const defaultTeam = teams.find((team) => team.name === DEFAULT_TEAM_NAME);
  if (!defaultTeam) {
    const teamNames = teams.map((team) => team.name).join(", ");
    throw new Error(
      `Team "${DEFAULT_TEAM_NAME}" not found. Available teams: [${teamNames}]`,
    );
  }
  const engineeringTeam = teams.find(
    (team) => team.name === ENGINEERING_TEAM_NAME,
  );
  if (!engineeringTeam) {
    const teamNames = teams.map((team) => team.name).join(", ");
    throw new Error(
      `Team "${ENGINEERING_TEAM_NAME}" not found. Available teams: [${teamNames}]`,
    );
  }

  const createResponse = await archestraApiSdk.createAgent({
    headers: { Cookie: cookieHeaders },
    body: {
      name: gatewayName,
      agentType: "mcp_gateway",
      scope: "team",
      teams: [defaultTeam.id, engineeringTeam.id],
    },
  });
  if (createResponse.error) {
    throw new Error(
      `Failed to create shared test MCP gateway: ${JSON.stringify(createResponse.error)}`,
    );
  }
  if (!createResponse.data) {
    throw new Error(
      `No data returned from createAgent. Response: ${JSON.stringify(createResponse)}`,
    );
  }
  return { id: createResponse.data.id, name: createResponse.data.name };
}

export async function createTeamMcpGatewayViaApi({
  cookieHeaders,
  teamName,
  gatewayName,
}: {
  cookieHeaders: string;
  teamName: string;
  gatewayName: string;
}): Promise<{ id: string; name: string }> {
  const teamsResponse = await archestraApiSdk.getTeams({
    headers: { Cookie: cookieHeaders },
  });
  if (teamsResponse.error) {
    throw new Error(
      `Failed to get teams: ${JSON.stringify(teamsResponse.error)}`,
    );
  }
  const teams = teamsResponse.data?.data ?? [];
  const team = teams.find((item) => item.name === teamName);
  if (!team) {
    const teamNames = teams.map((item) => item.name).join(", ");
    throw new Error(
      `Team "${teamName}" not found. Available teams: [${teamNames}]`,
    );
  }

  const createResponse = await archestraApiSdk.createAgent({
    headers: { Cookie: cookieHeaders },
    body: {
      name: gatewayName,
      agentType: "mcp_gateway",
      scope: "team",
      teams: [team.id],
    },
  });
  if (createResponse.error) {
    throw new Error(
      `Failed to create team MCP gateway: ${JSON.stringify(createResponse.error)}`,
    );
  }
  if (!createResponse.data) {
    throw new Error(
      `No data returned from createAgent. Response: ${JSON.stringify(createResponse)}`,
    );
  }
  return { id: createResponse.data.id, name: createResponse.data.name };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
