import { E2eTestId, MCP_SERVER_TOOL_NAME_SEPARATOR } from "@shared";
import { MARKETING_TEAM_NAME, WIREMOCK_INTERNAL_URL } from "../../consts";
import { expect, test } from "../../fixtures";
import { getTeamByName } from "../api/fixtures";
import { makeApiRequest } from "../api/mcp-gateway-utils";

/**
 * Chat - Auth Required Tool UI Tests
 *
 * Tests that the AuthRequiredTool component renders correctly in the chat UI
 * when a tool with "Resolve at call time" credential mode is called
 * and the caller has no matching credentials.
 *
 * Flow:
 * 1. Admin installs a remote MCP server (owns the credential)
 * 2. A tool is assigned to an agent with useDynamicTeamCredential: true
 * 3. Member user (in Marketing Team, but admin is NOT) uses the chat
 * 4. LLM (WireMock) returns a tool_use block for the test tool
 * 5. MCP Gateway resolves dynamic credential -> no match -> auth-required error
 * 6. Chat UI renders AuthRequiredTool with "Authentication Required" alert
 *
 * Uses static WireMock mappings:
 * - helm/e2e-tests/mappings/mcp-auth-ui-e2e-*.json (mock MCP server)
 * - helm/e2e-tests/mappings/anthropic-chat-auth-ui-e2e-*.json (mock LLM responses)
 */
test.describe.configure({ mode: "serial" });

test.describe("Chat - Auth Required Tool", () => {
  test.setTimeout(120_000);

  const CATALOG_NAME = "auth-ui-e2e";
  const MCP_TOOL_BASE_NAME = "test_ui_auth_tool";
  const FULL_TOOL_NAME = `${CATALOG_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${MCP_TOOL_BASE_NAME}`;
  const WIREMOCK_MCP_PATH = `/mcp/${CATALOG_NAME}`;
  const TEST_MESSAGE_TAG = "auth-calltime-ui-e2e";

  let catalogItemId: string;
  let serverId: string;
  let profileId: string;
  let profileName: string;

  test.beforeAll(async ({ request }) => {
    // 1. Create remote catalog item pointing to WireMock (static stubs pre-loaded)
    const catalogResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/internal_mcp_catalog",
      data: {
        name: CATALOG_NAME,
        description: "Test server for auth-at-call-time UI e2e test",
        serverType: "remote",
        serverUrl: `${WIREMOCK_INTERNAL_URL}${WIREMOCK_MCP_PATH}`,
      },
    });
    const catalog = await catalogResponse.json();
    catalogItemId = catalog.id;

    // 2. Install server as admin (personal install, no team)
    const installResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/mcp_server",
      data: { name: CATALOG_NAME, catalogId: catalogItemId },
    });
    const server = await installResponse.json();
    serverId = server.id;

    // 3. Wait for tool discovery (poll for the tool to appear)
    let discoveredTool: { id: string; name: string } | undefined;
    for (let attempt = 0; attempt < 30; attempt++) {
      const toolsResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/tools",
      });
      const toolsData = await toolsResponse.json();
      const tools = Array.isArray(toolsData)
        ? toolsData
        : (toolsData.data ?? []);
      discoveredTool = tools.find(
        (t: { name: string }) => t.name === FULL_TOOL_NAME,
      );
      if (discoveredTool) break;
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (!discoveredTool) {
      throw new Error(
        `Tool '${FULL_TOOL_NAME}' not discovered after 60 seconds. ` +
          `Check WireMock stubs at ${WIREMOCK_MCP_PATH}`,
      );
    }

    // 4. Get Marketing Team (admin is NOT a member of this team)
    const marketingTeam = await getTeamByName(request, MARKETING_TEAM_NAME);

    // 5. Create agent (agentType: "agent" so it appears in chat selector)
    //    and assign Marketing Team so the member can access it
    profileName = "Auth UI Test E2E";
    const profileResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/agents",
      data: { name: profileName, teams: [], agentType: "agent" },
    });
    const profile = await profileResponse.json();
    profileId = profile.id;

    await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/agents/${profileId}`,
      data: { teams: [marketingTeam.id] },
    });

    // 6. Assign tool to agent with useDynamicTeamCredential: true
    await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/api/agents/${profileId}/tools/${discoveredTool.id}`,
      data: { useDynamicTeamCredential: true },
    });
  });

  test.afterAll(async ({ request }) => {
    // Clean up resources (ignore errors to avoid masking test failures)
    if (profileId) {
      await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/agents/${profileId}`,
        ignoreStatusCheck: true,
      }).catch(() => {});
    }
    if (serverId) {
      await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/mcp_server/${serverId}`,
        ignoreStatusCheck: true,
      }).catch(() => {});
    }
    if (catalogItemId) {
      await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/internal_mcp_catalog/${catalogItemId}`,
        ignoreStatusCheck: true,
      }).catch(() => {});
    }
  });

  test("renders AuthRequiredTool when tool call fails due to missing credentials", async ({
    memberPage,
    goToMemberPage,
  }) => {
    // Navigate to chat as member user
    await goToMemberPage("/chat");
    await memberPage.waitForLoadState("networkidle");

    // Skip onboarding if present
    const skipButton = memberPage.getByTestId(E2eTestId.OnboardingSkipButton);
    if (await skipButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await skipButton.click();
      await memberPage.waitForTimeout(500);
    }

    // Wait for the chat page to load
    const textarea = memberPage.getByTestId(E2eTestId.ChatPromptTextarea);
    await expect(textarea).toBeVisible({ timeout: 15_000 });

    // Select our test agent via the agent selector
    const agentSelector = memberPage.getByRole("combobox").first();
    await expect(agentSelector).toBeVisible({ timeout: 5_000 });
    await agentSelector.click();

    // Search for our test agent
    const searchInput = memberPage.getByPlaceholder("Search agent...");
    await expect(searchInput).toBeVisible({ timeout: 3_000 });
    await searchInput.fill(profileName);

    // Select the test agent from the dropdown
    const profileOption = memberPage.getByRole("option", {
      name: profileName,
    });
    await expect(profileOption).toBeVisible({ timeout: 5_000 });
    await profileOption.click();

    // Select an Anthropic model — the member's default may be a different
    // provider (e.g. Cohere in CI) whose WireMock stubs won't return our
    // tool_use response. Only the Anthropic stubs are configured for this test.
    const modelTrigger = memberPage.getByTestId(
      E2eTestId.ChatModelSelectorTrigger,
    );
    await expect(modelTrigger).toBeVisible({ timeout: 5_000 });
    await modelTrigger.click();

    const modelSearch = memberPage.getByPlaceholder("Search models...");
    await expect(modelSearch).toBeVisible({ timeout: 3_000 });
    await modelSearch.fill("claude");

    // Pick the first Anthropic Claude model from the results
    const claudeOption = memberPage
      .getByRole("option", { name: /claude/i })
      .first();
    await expect(claudeOption).toBeVisible({ timeout: 5_000 });
    await claudeOption.click();

    // Send a message containing the unique tag for WireMock matching
    const testMessage = `Test message ${TEST_MESSAGE_TAG}: Please use the test tool.`;
    await textarea.fill(testMessage);
    await memberPage.keyboard.press("Enter");

    // Wait for the AuthRequiredTool component to render
    // The flow: LLM returns tool_use -> MCP Gateway returns auth-required error -> UI renders AuthRequiredTool
    await expect(memberPage.getByText("Authentication Required")).toBeVisible({
      timeout: 30_000,
    });

    // Verify the catalog name is displayed in the alert description
    await expect(
      memberPage.getByText(
        new RegExp(`No credentials found for .*${CATALOG_NAME}`),
      ),
    ).toBeVisible();

    // Verify the "Set up credentials" link points to the install URL
    const link = memberPage.getByRole("link", {
      name: /Set up credentials/i,
    });
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    expect(href).toContain("/mcp-catalog/registry");
    expect(href).toContain(catalogItemId);
  });
});
