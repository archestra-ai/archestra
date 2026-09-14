import { E2eTestId } from "@archestra/shared";
import { type APIRequestContext, mergeTests } from "@playwright/test";
import { A2A_FIXTURE_BASE_URL, WIREMOCK_BASE_URL } from "../consts";
import { expect, test as uiTest } from "../fixtures";
import {
  ensureWireMockAnthropicChatProvider,
  expectChatReady,
  goToChat,
} from "../utils";
import { test as apiTest } from "./api-fixtures";

const test = mergeTests(uiTest, apiTest);

type RemoteAgent = {
  id: string;
};

test("delegates from a parent agent to an external A2A agent", async ({
  page,
  request,
  makeRandomString,
  goToPage,
  deleteAgent,
  makeApiRequest,
  syncModels,
}) => {
  test.setTimeout(180_000);

  const suffix = makeRandomString(8).replace(/-/g, "");
  const remoteName = `External A2A ${suffix}`;
  const parentName = `A2A parent ${suffix}`;
  const promptMarker = `outbound-a2a-e2e-${suffix}`;
  const delegatedMessage = `[fixture:delayed] payload-${suffix}`;
  const finalAnswer = `External A2A delegation ${suffix} completed end to end.`;

  let parentId: string | undefined;
  let remoteAgent: RemoteAgent | undefined;
  const wireMockMappingIds: string[] = [];

  try {
    await resetA2aFixture(request);

    // Enter through the consolidated Agents page and its shared source
    // chooser. Checking the base URL exercises Agent Card discovery without
    // creating a half-configured connection.
    await goToPage(page, "/agents");
    await page
      .getByRole("button", { name: "Add Agent", exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(/\/agents\/new$/);
    await page.getByRole("button", { name: /Connect via A2A/ }).click();
    await expect(page).toHaveURL(/\/agents\/a2a\/new$/);
    await expect(
      page.getByRole("heading", {
        name: "Connect external A2A agent",
        level: 1,
      }),
    ).toBeVisible();
    await page.getByLabel("Agent base URL").fill(A2A_FIXTURE_BASE_URL);
    await page.getByLabel("Display name (optional)").fill(remoteName);
    await page.getByRole("button", { name: "Check Agent Card" }).click();
    await expect(
      page.getByRole("status", { name: "Agent Card found" }),
    ).toContainText("Deterministic A2A Test Agent", { timeout: 30_000 });

    const createRemoteResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/a2a/remote-agents") &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Connect agent", exact: true })
      .click();
    const createdResponse = await createRemoteResponse;
    expect(createdResponse.ok()).toBe(true);
    remoteAgent = (await createdResponse.json()) as RemoteAgent;
    await expect(page).toHaveURL(new RegExp(`/agents/a2a/${remoteAgent.id}$`));
    await expect(
      page.getByRole("heading", { name: remoteName, level: 1 }),
    ).toBeVisible({ timeout: 15_000 });

    const parentResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/agents",
      data: {
        name: parentName,
        teams: [],
        scope: "personal",
        agentType: "agent",
      },
    });
    parentId = ((await parentResponse.json()) as { id: string }).id;

    // External assignments deliberately share the Agent form's Save lifecycle:
    // selecting the row only stages it; the POST must happen after Save changes.
    await goToPage(page, `/agents/${parentId}?section=tools`);
    await expect(
      page.locator("#main-content").getByText("External Agents", {
        exact: true,
      }),
    ).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Add outbound agent" }).click();
    await page
      .getByRole("menuitemcheckbox", { name: new RegExp(remoteName) })
      .click();
    await expect(
      page.getByRole("button", { name: `${remoteName} A2A` }),
    ).toBeVisible();

    const assignmentResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/agents/${parentId}/a2a-delegations`) &&
        response.request().method() === "POST",
    );
    await page.getByTestId(E2eTestId.AgentSetupSubmitButton).click();
    expect((await assignmentResponse).ok()).toBe(true);

    const toolsResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/chat/agents/${parentId}/mcp-tools`,
    });
    const tools = (await toolsResponse.json()) as Array<{
      name: string;
      description: string;
      parameters: unknown;
    }>;
    const delegationTool = tools.find((tool) =>
      tool.name.startsWith("agent__"),
    );
    expect(delegationTool).toMatchObject({
      parameters: expect.objectContaining({ type: "object" }),
    });
    if (!delegationTool)
      throw new Error("Outbound A2A tool was not advertised");

    wireMockMappingIds.push(
      await addWireMockMapping(
        request,
        toolCallMapping({
          marker: promptMarker,
          toolName: delegationTool.name,
          message: delegatedMessage,
        }),
      ),
    );
    wireMockMappingIds.push(
      await addWireMockMapping(
        request,
        finalAnswerMapping({ marker: promptMarker, finalAnswer }),
      ),
    );

    const { apiKeyId, runtimeModel } =
      await ensureWireMockAnthropicChatProvider({
        request,
        makeApiRequest,
        syncModels,
      });
    await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/agents/${parentId}`,
      data: {
        llmApiKeyId: apiKeyId,
        modelId: runtimeModel.dbId,
      },
    });
    await goToChat(page, { agentId: parentId });
    await expectChatReady(page);

    const userPrompt = `${promptMarker}: delegate this request to the external agent.`;
    await page.getByTestId(E2eTestId.ChatPromptTextarea).fill(userPrompt);
    await page.keyboard.press("Enter");
    const sendAnyway = page.getByRole("button", { name: "Send anyway" });
    if (
      await sendAnyway
        .waitFor({ state: "visible", timeout: 3_000 })
        .then(() => true)
        .catch(() => false)
    ) {
      await sendAnyway.click();
    }
    await expect(
      page.getByText(finalAnswer, { exact: true }).first(),
    ).toBeVisible({ timeout: 90_000 });
  } finally {
    for (const mappingId of wireMockMappingIds) {
      await request.delete(
        `${WIREMOCK_BASE_URL}/__admin/mappings/${mappingId}`,
      );
    }
    if (parentId) {
      await makeApiRequest({
        request,
        method: "post",
        urlSuffix: `/api/agents/${parentId}/a2a-delegations`,
        data: { connectionIds: [] },
      });
    }
    if (remoteAgent) {
      await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/a2a/remote-agents/${remoteAgent.id}`,
      });
    }
    if (parentId) await deleteAgent(request, parentId);
    await resetA2aFixture(request).catch(() => {});
  }
});

async function resetA2aFixture(request: APIRequestContext): Promise<void> {
  const health = await request.get(`${A2A_FIXTURE_BASE_URL}/health`);
  expect(
    health.ok(),
    `A2A fixture is not reachable at ${A2A_FIXTURE_BASE_URL}`,
  ).toBe(true);
  const reset = await request.post(`${A2A_FIXTURE_BASE_URL}/reset`);
  expect(reset.status()).toBe(204);
}

async function addWireMockMapping(
  request: APIRequestContext,
  mapping: Record<string, unknown>,
): Promise<string> {
  const response = await request.post(`${WIREMOCK_BASE_URL}/__admin/mappings`, {
    data: mapping,
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { id: string }).id;
}

function toolCallMapping(params: {
  marker: string;
  toolName: string;
  message: string;
}): Record<string, unknown> {
  return {
    priority: 2,
    request: {
      method: "POST",
      urlPath: "/anthropic/v1/messages",
      bodyPatterns: [
        { contains: params.marker },
        { doesNotMatch: ".*tool_result.*" },
      ],
    },
    response: {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
      body: anthropicSse([
        {
          event: "message_start",
          data: {
            type: "message_start",
            message: {
              id: "msg_outbound_a2a_tool",
              type: "message",
              role: "assistant",
              model: "claude-3-5-sonnet-20241022",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 20, output_tokens: 0 },
            },
          },
        },
        {
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "toolu_outbound_a2a",
              name: params.toolName,
              input: {},
            },
          },
        },
        {
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify({ message: params.message }),
            },
          },
        },
        {
          event: "content_block_stop",
          data: { type: "content_block_stop", index: 0 },
        },
        {
          event: "message_delta",
          data: {
            type: "message_delta",
            delta: { stop_reason: "tool_use", stop_sequence: null },
            usage: { output_tokens: 15 },
          },
        },
        { event: "message_stop", data: { type: "message_stop" } },
      ]),
    },
  };
}

function finalAnswerMapping(params: {
  marker: string;
  finalAnswer: string;
}): Record<string, unknown> {
  return {
    priority: 1,
    request: {
      method: "POST",
      urlPath: "/anthropic/v1/messages",
      bodyPatterns: [
        { contains: params.marker },
        { contains: "tool_result" },
        { contains: "Fixture response:" },
      ],
    },
    response: {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
      body: anthropicSse([
        {
          event: "message_start",
          data: {
            type: "message_start",
            message: {
              id: "msg_outbound_a2a_final",
              type: "message",
              role: "assistant",
              model: "claude-3-5-sonnet-20241022",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 30, output_tokens: 0 },
            },
          },
        },
        {
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
        },
        {
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: params.finalAnswer },
          },
        },
        {
          event: "content_block_stop",
          data: { type: "content_block_stop", index: 0 },
        },
        {
          event: "message_delta",
          data: {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 15 },
          },
        },
        { event: "message_stop", data: { type: "message_stop" } },
      ]),
    },
  };
}

function anthropicSse(
  events: Array<{ event: string; data: Record<string, unknown> }>,
): string {
  return events
    .map(
      ({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    )
    .join("");
}
