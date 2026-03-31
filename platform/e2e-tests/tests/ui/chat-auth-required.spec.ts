import { E2eTestId, MCP_SERVER_TOOL_NAME_SEPARATOR } from "@shared";
import { MARKETING_TEAM_NAME, WIREMOCK_INTERNAL_URL } from "../../consts";
import { expect, test } from "../../fixtures";
import {
  getTeamByName,
  LLM_PROVIDER_API_KEYS_AVAILABLE_ROUTE,
} from "../api/fixtures";
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
 * 2. A tool is assigned to an agent with resolveAtCallTime enabled
 * 3. Member user (in Marketing Team, but admin is NOT) uses the chat
 * 4. LLM (WireMock) returns a tool_use block for the test tool
 * 5. MCP Gateway resolves dynamic credential -> no match -> auth-required error
 * 6. Chat UI renders AuthRequiredTool with "Authentication Required" alert
 *
 * Uses static WireMock mappings:
 * - helm/e2e-tests/mappings/mcp-auth-ui-e2e-*.json (mock MCP server)
 * - helm/e2e-tests/mappings/gemini-chat-auth-ui-e2e-*.json (mock LLM responses)
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
  let chatApiKeyId: string;

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

    // 5. Use an already-available Gemini key so the test does not depend on
    // provider-key creation/validation. The WireMock mappings match the prompt tag.
    const availableKeysResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: LLM_PROVIDER_API_KEYS_AVAILABLE_ROUTE,
    });
    const availableKeys = (await availableKeysResponse.json()) as Array<{
      id: string;
      provider: string;
      bestModelId?: string | null;
    }>;
    const geminiKey = availableKeys.find((key) => key.provider === "gemini");
    if (!geminiKey) {
      throw new Error(
        "Expected an available Gemini key for chat auth-required e2e",
      );
    }
    chatApiKeyId = geminiKey.id;

    // 6. Create agent and assign Marketing Team so the member can access it.
    const profileResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/agents",
      data: {
        name: "Auth UI Test E2E",
        teams: [],
        agentType: "agent",
        scope: "team",
        llmApiKeyId: chatApiKeyId,
      },
    });
    const profile = await profileResponse.json();
    profileId = profile.id;

    await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/agents/${profileId}`,
      data: { teams: [marketingTeam.id] },
    });

    // 7. Assign tool to agent with resolveAtCallTime enabled
    await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/api/agents/${profileId}/tools/${discoveredTool.id}`,
      data: { resolveAtCallTime: true, credentialResolutionMode: "dynamic" },
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

  test("surfaces missing credentials guidance when tool call fails due to missing credentials", async ({
    memberPage,
    goToMemberPage,
  }) => {
    // Navigate directly to chat with the test agent selected. The chat page
    // supports agentId in the URL, which is more stable than driving the
    // selector UI and keeps this test focused on the auth-required flow.
    await goToMemberPage(`/chat?agentId=${profileId}`);
    await memberPage.waitForLoadState("domcontentloaded");

    // Wait for the chat page to load
    const textarea = memberPage.getByTestId(E2eTestId.ChatPromptTextarea);
    await expect(textarea).toBeVisible({ timeout: 15_000 });

    // Send a message containing the unique tag for WireMock matching
    const testMessage = `Test message ${TEST_MESSAGE_TAG}: Please use the test tool.`;
    await textarea.fill(testMessage);
    await memberPage.keyboard.press("Enter");

    const authRequiredCard = memberPage.getByText(
      /Authentication Required: No credentials found/i,
    );
    const setupCredentialsButton = memberPage.getByRole("button", {
      name: /set up credentials/i,
    });

    await expect(authRequiredCard).toBeVisible({
      timeout: 45_000,
    });
    await expect(setupCredentialsButton).toBeVisible();
  });
});
