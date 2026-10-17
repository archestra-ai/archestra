import { E2eTestId } from "@archestra/shared/e2e-test-ids";
import type { Page } from "@playwright/test";
import { makeAgent } from "../src/mocks/data/agents";
import { makeLlmProviderApiKey } from "../src/mocks/data/llm-keys";
import { expect, test } from "./fixtures";

const NOW = "2026-09-18T12:00:00.000Z";

function conversation(id: string, title: string, agentId: string) {
  return {
    id,
    userId: "test-user-admin",
    organizationId: "test-org",
    agentId,
    title,
    titleIsPlaceholder: false,
    origin: "user",
    projectId: null,
    modelId: null,
    selectedModel: "gpt-4o",
    selectedProvider: "openai",
    chatApiKeyId: null,
    thinkingEffort: null,
    hasCustomToolSelection: false,
    hooksDebugEnabled: false,
    encryptedChat: false,
    todoList: null,
    artifact: null,
    pinnedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastMessageAt: NOW,
    deletedAt: null,
    agent: {
      id: agentId,
      name: "Load agent",
      agentType: "agent",
      systemPrompt: null,
      toolExposureMode: "full",
      llmApiKeyId: null,
    },
    share: null,
    unread: false,
    chatErrors: [],
    compactions: [],
    messages: [
      { id: `${id}-m1`, role: "user", parts: [{ type: "text", text: "Hi" }] },
      {
        id: `${id}-m2`,
        role: "assistant",
        parts: [{ type: "text", text: `Hello from ${title}` }],
      },
    ],
  };
}

/** Count API requests (method + path) from the moment this is called. */
function countRequests(page: Page) {
  const seen: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/") || url.pathname === "/health")
      seen.push(`${request.method()} ${url.pathname}`);
  });
  return {
    count: (key: string) => seen.filter((entry) => entry === key).length,
    reset: () => {
      seen.length = 0;
    },
  };
}

test("one visit loads a conversation and its files once, and switching re-reads neither the organization nor the list", async ({
  page,
  mswControl,
}) => {
  const key = makeLlmProviderApiKey({ provider: "openai" });
  const agent = makeAgent({ llmApiKeyId: key.id });
  const first = conversation(
    "10000000-0000-4000-8000-0000000000a1",
    "Load probe A",
    agent.id,
  );
  const second = conversation(
    "10000000-0000-4000-8000-0000000000b2",
    "Load probe B",
    agent.id,
  );
  await mswControl.registerMany([
    { method: "get", url: "/api/agents/chat-roster", body: [agent] },
    { method: "get", url: `/api/agents/${agent.id}`, body: agent },
    { method: "get", url: "/api/agents/credential-readiness", body: [] },
    { method: "get", url: "/api/llm-provider-api-keys", body: [key] },
    { method: "get", url: "/api/llm-provider-api-keys/available", body: [key] },
    {
      method: "get",
      url: "/api/members/default-model",
      body: { modelId: null, chatApiKeyId: null },
    },
    {
      method: "get",
      url: "/api/chat/conversations",
      body: [
        { ...first, messages: [] },
        { ...second, messages: [] },
      ],
    },
    ...[first, second].flatMap((c) => [
      {
        method: "get" as const,
        url: `/api/chat/conversations/${c.id}`,
        body: c,
      },
      {
        method: "get" as const,
        url: `/api/chat/conversations/${c.id}/files`,
        body: [],
      },
      {
        method: "get" as const,
        url: `/api/chat/conversations/${c.id}/share`,
        body: null,
      },
    ]),
  ]);
  const requests = countRequests(page);

  await page.goto(`/chat/${first.id}`);
  await expect(page.getByText("Hello from Load probe A")).toBeVisible();
  await expect(page.getByTestId(E2eTestId.ChatPromptTextarea)).toBeVisible();
  // Let any trailing refetch (a status effect, a fresh-read observer) land.
  await page.waitForTimeout(1500);
  expect(requests.count(`GET /api/chat/conversations/${first.id}`)).toBe(1);
  expect(requests.count(`GET /api/chat/conversations/${first.id}/files`)).toBe(
    1,
  );

  requests.reset();
  await page.getByRole("button", { name: "Load probe B" }).first().click();
  await expect(page.getByText("Hello from Load probe B")).toBeVisible();
  await page.getByRole("button", { name: "Load probe A" }).first().click();
  await expect(page.getByText("Hello from Load probe A")).toBeVisible();
  await page.waitForTimeout(1500);

  expect(requests.count(`GET /api/chat/conversations/${second.id}`)).toBe(1);
  expect(requests.count(`GET /api/chat/conversations/${second.id}/files`)).toBe(
    1,
  );
  // Revisited within its fresh window: served from the cache.
  expect(requests.count(`GET /api/chat/conversations/${first.id}`)).toBe(0);
  expect(requests.count(`GET /api/chat/conversations/${first.id}/files`)).toBe(
    0,
  );
  expect(requests.count("GET /api/organization")).toBe(0);
  expect(requests.count("GET /api/chat/conversations")).toBe(0);
});
