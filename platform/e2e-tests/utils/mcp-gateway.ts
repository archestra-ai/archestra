import { type APIRequestContext, expect, type Page } from "@playwright/test";
import { archestraApiSdk, getManageCredentialsButtonTestId } from "@shared";
import {
  DEFAULT_TEAM_NAME,
  E2eTestId,
  ENGINEERING_TEAM_NAME,
  MARKETING_TEAM_NAME,
} from "../consts";
import {
  callMcpTool,
  getOrgTokenForProfile,
  getTeamTokenForProfile,
} from "../tests/api/mcp-gateway-utils";
import { closeOpenDialogs } from "./dialogs";

export async function verifyToolCallResultViaApi({
  request,
  expectedResult,
  tokenToUse,
  toolName,
  cookieHeaders,
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
  cookieHeaders: string;
  profileId?: string;
}) {
  let effectiveProfileId = profileId;
  if (!effectiveProfileId) {
    const defaultMcpGatewayResponse =
      await archestraApiSdk.getDefaultMcpGateway({
        headers: { Cookie: cookieHeaders },
      });
    if (defaultMcpGatewayResponse.error) {
      throw new Error(
        `Failed to get default MCP gateway: ${JSON.stringify(defaultMcpGatewayResponse.error)}`,
      );
    }
    if (!defaultMcpGatewayResponse.data) {
      throw new Error(
        `No default MCP gateway returned from API. Response: ${JSON.stringify(defaultMcpGatewayResponse)}`,
      );
    }
    effectiveProfileId = defaultMcpGatewayResponse.data.id;
  }

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
  return await page
    .getByTestId(E2eTestId.StaticCredentialToUse)
    .allTextContents();
}

export async function assignEngineeringTeamToDefaultProfileViaApi({
  cookieHeaders,
}: {
  cookieHeaders: string;
}) {
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

  const defaultMcpGatewayResponse = await archestraApiSdk.getDefaultMcpGateway({
    headers: { Cookie: cookieHeaders },
  });
  if (defaultMcpGatewayResponse.error) {
    throw new Error(
      `Failed to get default MCP gateway: ${JSON.stringify(defaultMcpGatewayResponse.error)}`,
    );
  }
  if (!defaultMcpGatewayResponse.data) {
    throw new Error(
      `No default MCP gateway returned from API. Response: ${JSON.stringify(defaultMcpGatewayResponse)}`,
    );
  }

  const updateResponse = await archestraApiSdk.updateAgent({
    headers: { Cookie: cookieHeaders },
    path: { id: defaultMcpGatewayResponse.data.id },
    body: {
      teams: [defaultTeam.id, engineeringTeam.id],
    },
  });
  if (updateResponse.error) {
    throw new Error(
      `Failed to update agent: ${JSON.stringify(updateResponse.error)}`,
    );
  }
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
