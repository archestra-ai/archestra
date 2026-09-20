import { makeAgent } from "../src/mocks/data/agents";
import { makeLlmProviderApiKey } from "../src/mocks/data/llm-keys";
import { expect, test } from "./fixtures";

test("shows scheduled output while running and replays it after refresh", async ({
  page,
  mswControl,
}, testInfo) => {
  page.on("pageerror", (error) => console.error(error));
  const conversationId = "10000000-0000-4000-8000-000000000001";
  const triggerId = "20000000-0000-4000-8000-000000000001";
  const runId = "30000000-0000-4000-8000-000000000001";
  const now = "2026-09-18T12:00:00.000Z";
  const conversation = {
    id: conversationId,
    userId: "test-user-admin",
    organizationId: "test-org",
    agentId: "test-agent",
    title: "Scheduled progress check",
    titleIsPlaceholder: false,
    origin: "schedule_trigger",
    projectId: null,
    modelId: null,
    selectedModel: "gpt-4o",
    selectedProvider: "openai",
    chatApiKeyId: null,
    thinkingEffort: "low",
    hasCustomToolSelection: false,
    hooksDebugEnabled: false,
    lockedChat: false,
    todoList: null,
    artifact: null,
    pinnedAt: null,
    createdAt: now,
    updatedAt: now,
    lastMessageAt: now,
    deletedAt: null,
    agent: {
      id: "test-agent",
      name: "Schedule agent",
      agentType: "agent",
      systemPrompt: null,
      toolExposureMode: "full",
      llmApiKeyId: null,
    },
    share: null,
    chatErrors: [],
    compactions: [],
    messages: [
      {
        id: "prompt-1",
        role: "user",
        parts: [{ type: "text", text: "Check the weekly report" }],
      },
    ],
  };
  const run = {
    id: runId,
    triggerId,
    organizationId: "test-org",
    status: "running",
    runKind: "manual",
    startedAt: now,
    completedAt: null,
    error: null,
    chatConversationId: conversationId,
    runtimeTaskId: null,
    artifact: null,
    initiatedByUserId: "test-user-admin",
  };
  await mswControl.use({
    method: "get",
    url: "/api/agents/all",
    body: [makeAgent()],
  });
  await mswControl.use({
    method: "get",
    url: "/api/agents/credential-readiness",
    body: [],
  });
  await mswControl.use({
    method: "get",
    url: "/api/llm-provider-api-keys",
    body: [makeLlmProviderApiKey({ provider: "openai" })],
  });
  await mswControl.use({
    method: "get",
    url: "/api/llm-provider-api-keys/available",
    body: [makeLlmProviderApiKey({ provider: "openai" })],
  });
  await mswControl.use({
    method: "get",
    url: "/api/members/default-model",
    body: { modelId: null, chatApiKeyId: null },
  });
  await mswControl.use({
    method: "get",
    url: `/api/chat/conversations/${conversationId}/files`,
    body: [],
  });
  await mswControl.use({
    method: "get",
    url: `/api/chat/conversations/${conversationId}/share`,
    body: null,
  });
  await mswControl.use({
    method: "get",
    url: `/api/chat/conversations/${conversationId}`,
    body: { ...conversation, messages: [] },
  });
  await mswControl.use({
    method: "get",
    url: `/api/schedule-triggers/${triggerId}/runs/${runId}`,
    body: run,
  });
  await mswControl.use({
    method: "get",
    url: `/api/schedule-triggers/${triggerId}`,
    body: {
      id: triggerId,
      name: "Weekly report",
      agentId: "test-agent",
      projectId: null,
    },
  });
  await mswControl.use({
    method: "get",
    url: `/api/schedule-triggers/${triggerId}/runs`,
    body: { data: [run], pagination: { total: 1, limit: 10, offset: 0 } },
  });

  // Keep the SSE response open. Completion cannot explain text appearing here.
  await page.addInitScript(
    ({ id }) => {
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (url.includes(`/api/chat/conversations/${id}/active-run`)) {
          const encoder = new TextEncoder();
          return new Response(
            new ReadableStream({
              start(controller) {
                for (const chunk of [
                  { type: "start", messageId: "assistant-1" },
                  { type: "text-start", id: "text-1" },
                  {
                    type: "text-delta",
                    id: "text-1",
                    delta: "I am checking the report now.",
                  },
                  {
                    type: "tool-input-available",
                    toolCallId: "call-1",
                    toolName: "lookup_report",
                    input: { report: "weekly" },
                  },
                ])
                  controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
                  );
              },
            }),
            {
              headers: {
                "content-type": "text/event-stream",
                "x-vercel-ai-ui-message-stream": "v1",
              },
            },
          );
        }
        return originalFetch(input, init);
      };
    },
    { id: conversationId },
  );
  await page.goto(
    `/chat/${conversationId}?scheduleTriggerId=${triggerId}&scheduleRunId=${runId}`,
  );
  await expect(page.getByAltText("Loading logo")).toBeVisible();
  await expect(page.locator("textarea")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("scheduled-starting.png"),
    fullPage: true,
  });
  await mswControl.use({
    method: "get",
    url: `/api/chat/conversations/${conversationId}`,
    body: conversation,
  });
  await expect(
    page.getByText("I am checking the report now.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /lookup report/ }),
  ).toBeVisible();
  await expect(page.locator("textarea")).toBeVisible();
  await expect(page.getByAltText("Loading logo")).toBeVisible();
  await expect(page.getByRole("button", { name: /Stop/ })).toBeEnabled();
  await expect(
    page.getByText("This chat updates automatically when the run finishes."),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("scheduled-live.png"),
    fullPage: true,
  });
  await page.reload();
  await expect(
    page.getByText("I am checking the report now.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Stop/ })).toBeEnabled();
  await page.locator("textarea").fill("Follow up after this run");
  await expect(page.locator("textarea")).toHaveValue(
    "Follow up after this run",
  );
  await page.locator("textarea").fill("");
  await mswControl.use({
    method: "post",
    url: `/api/chat/conversations/${conversationId}/stop`,
    body: { stopped: true },
  });
  const stopRequest = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url().endsWith(`/api/chat/conversations/${conversationId}/stop`),
  );
  await page.getByRole("button", { name: /Stop/ }).click();
  await stopRequest;
});
