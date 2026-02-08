import crypto from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import { E2eTestId, MCP_SERVER_TOOL_NAME_SEPARATOR } from "@shared";
import {
  MARKETING_TEAM_NAME,
  WIREMOCK_BASE_URL,
  WIREMOCK_INTERNAL_URL,
} from "../../consts";
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
 * 2. A tool is assigned to a profile with useDynamicTeamCredential: true
 * 3. Member user (in Marketing Team, but admin is NOT) uses the chat
 * 4. LLM (WireMock) returns a tool_use block for the test tool
 * 5. MCP Gateway resolves dynamic credential -> no match -> auth-required error
 * 6. Chat UI renders AuthRequiredTool with "Authentication Required" alert
 *
 * Uses WireMock for both the mock MCP server (tool discovery) and mock LLM (Anthropic SSE).
 */
test.describe.configure({ mode: "serial" });

test.describe("Chat - Auth Required Tool", () => {
  test.setTimeout(120_000);

  const uniqueId = crypto.randomUUID().slice(0, 8);
  const CATALOG_NAME = `auth-ui-${uniqueId}`;
  const MCP_TOOL_BASE_NAME = "test_ui_auth_tool";
  const FULL_TOOL_NAME = `${CATALOG_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${MCP_TOOL_BASE_NAME}`;
  const WIREMOCK_MCP_PATH = `/mcp/auth-ui-${uniqueId}`;
  const TEST_MESSAGE_TAG = `auth-calltime-ui-${uniqueId}`;

  let catalogItemId: string;
  let serverId: string;
  let profileId: string;
  let profileName: string;
  const wiremockStubIds: string[] = [];

  async function registerWiremockStub(
    request: APIRequestContext,
    stub: object,
  ) {
    const response = await request.post(
      `${WIREMOCK_BASE_URL}/__admin/mappings`,
      { data: stub },
    );
    const result = await response.json();
    if (result.id) {
      wiremockStubIds.push(result.id);
    }
  }

  test.beforeAll(async ({ request }) => {
    // 1. Register WireMock stubs for mock remote MCP server

    // Initialize handler
    await registerWiremockStub(request, {
      request: {
        method: "POST",
        urlPath: WIREMOCK_MCP_PATH,
        bodyPatterns: [
          { matchesJsonPath: "$[?(@.method == 'initialize')]" },
        ],
      },
      response: {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: `{"jsonrpc":"2.0","id":{{jsonPath request.body '$.id'}},"result":{"protocolVersion":"2024-11-05","serverInfo":{"name":"${CATALOG_NAME}","version":"1.0.0"},"capabilities":{"tools":{"listChanged":false}}}}`,
      },
    });

    // Tools list handler
    await registerWiremockStub(request, {
      request: {
        method: "POST",
        urlPath: WIREMOCK_MCP_PATH,
        bodyPatterns: [
          { matchesJsonPath: "$[?(@.method == 'tools/list')]" },
        ],
      },
      response: {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: `{"jsonrpc":"2.0","id":{{jsonPath request.body '$.id'}},"result":{"tools":[{"name":"${MCP_TOOL_BASE_NAME}","description":"Test tool for auth-at-call-time UI testing","inputSchema":{"type":"object","properties":{}}}]}}`,
      },
    });

    // Catch-all for notifications and other methods (lower priority)
    await registerWiremockStub(request, {
      priority: 10,
      request: {
        method: "POST",
        urlPath: WIREMOCK_MCP_PATH,
      },
      response: {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: "",
      },
    });

    // 2. Create remote catalog item pointing to WireMock
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

    // 3. Install server as admin (personal install, no team)
    const installResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/mcp_server",
      data: { name: CATALOG_NAME, catalogId: catalogItemId },
    });
    const server = await installResponse.json();
    serverId = server.id;

    // 4. Wait for tool discovery (poll for the tool to appear)
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

    // 5. Get Marketing Team (admin is NOT a member of this team)
    const marketingTeam = await getTeamByName(request, MARKETING_TEAM_NAME);

    // 6. Create profile and assign Marketing Team so the member can access it
    profileName = `Auth UI Test ${uniqueId}`;
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

    // 7. Assign tool to profile with useDynamicTeamCredential: true
    await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/api/agents/${profileId}/tools/${discoveredTool.id}`,
      data: { useDynamicTeamCredential: true },
    });

    // 8. Register Anthropic WireMock stubs for chat LLM responses
    // Uses WireMock scenarios to handle the two-step flow:
    // 1st call: LLM returns tool_use for the auth test tool
    // 2nd call: LLM returns follow-up text after receiving the tool error result

    const toolUseSseBody = [
      "event: message_start",
      'data: {"type":"message_start","message":{"id":"msg_auth_ui_test","type":"message","role":"assistant","model":"claude-3-5-sonnet-20241022","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":50,"output_tokens":0}}}',
      "",
      "event: content_block_start",
      `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_auth_ui_01","name":"${FULL_TOOL_NAME}","input":{}}}`,
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}',
      "",
      "event: content_block_stop",
      'data: {"type":"content_block_stop","index":0}',
      "",
      "event: message_delta",
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":20}}',
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
      "",
    ].join("\n");

    await registerWiremockStub(request, {
      scenarioName: `auth-ui-${uniqueId}`,
      requiredScenarioState: "Started",
      newScenarioState: "tool_result_received",
      priority: 1,
      request: {
        method: "POST",
        urlPath: "/anthropic/v1/messages",
        bodyPatterns: [{ contains: TEST_MESSAGE_TAG }],
      },
      response: {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
        body: toolUseSseBody,
      },
    });

    // Follow-up response after tool result is sent back to LLM
    const followUpSseBody = [
      "event: message_start",
      'data: {"type":"message_start","message":{"id":"msg_auth_ui_followup","type":"message","role":"assistant","model":"claude-3-5-sonnet-20241022","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":100,"output_tokens":0}}}',
      "",
      "event: content_block_start",
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"It seems you need to set up credentials first."}}',
      "",
      "event: content_block_stop",
      'data: {"type":"content_block_stop","index":0}',
      "",
      "event: message_delta",
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":15}}',
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
      "",
    ].join("\n");

    await registerWiremockStub(request, {
      scenarioName: `auth-ui-${uniqueId}`,
      requiredScenarioState: "tool_result_received",
      priority: 1,
      request: {
        method: "POST",
        urlPath: "/anthropic/v1/messages",
        bodyPatterns: [{ contains: TEST_MESSAGE_TAG }],
      },
      response: {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
        body: followUpSseBody,
      },
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
    // Remove WireMock stubs
    for (const stubId of wiremockStubIds) {
      await request
        .delete(`${WIREMOCK_BASE_URL}/__admin/mappings/${stubId}`)
        .catch(() => {});
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

    // Select our test profile via the agent selector
    // The initial agent selector is a combobox at the top of the chat
    const agentSelector = memberPage.getByRole("combobox").first();
    await expect(agentSelector).toBeVisible({ timeout: 5_000 });
    await agentSelector.click();

    // Search for our test profile
    const searchInput = memberPage.getByPlaceholder("Search agent...");
    await expect(searchInput).toBeVisible({ timeout: 3_000 });
    await searchInput.fill(profileName);

    // Select the test profile from the dropdown
    const profileOption = memberPage.getByRole("option", {
      name: profileName,
    });
    await expect(profileOption).toBeVisible({ timeout: 5_000 });
    await profileOption.click();

    // The default model (Claude Sonnet 4.5 / anthropic) routes through WireMock
    // via ARCHESTRA_ANTHROPIC_BASE_URL, so no model selection needed.

    // Send a message containing the unique tag for WireMock matching
    const testMessage = `Test message ${TEST_MESSAGE_TAG}: Please use the test tool.`;
    await textarea.fill(testMessage);
    await memberPage.keyboard.press("Enter");

    // Wait for the AuthRequiredTool component to render
    // The flow: LLM returns tool_use -> MCP Gateway returns auth-required error -> UI renders AuthRequiredTool
    await expect(
      memberPage.getByText("Authentication Required"),
    ).toBeVisible({ timeout: 30_000 });

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
