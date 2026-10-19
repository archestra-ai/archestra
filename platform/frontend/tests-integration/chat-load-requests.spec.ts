import { E2eTestId } from "@archestra/shared/e2e-test-ids";
import type { Page } from "@playwright/test";
import { makeAgent } from "../src/mocks/data/agents";
import {
  adminScopedCapabilitiesSeed,
  makeUserPermissions,
} from "../src/mocks/data/auth";
import { makeLlmProviderApiKey } from "../src/mocks/data/llm-keys";
import {
  appearanceSettingsSeed,
  organizationSeed,
} from "../src/mocks/data/organization";
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
  await page.getByRole("link", { name: "Load probe B" }).first().click();
  await expect(page.getByText("Hello from Load probe B")).toBeVisible();
  await page.getByRole("link", { name: "Load probe A" }).first().click();
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

test("a cold new-chat load takes the shell's reads from the bootstrap and repeats no lookup", async ({
  page,
  mswControl,
}) => {
  const key = makeLlmProviderApiKey({ provider: "openai" });
  const agent = makeAgent({ llmApiKeyId: null });
  const model = {
    dbId: "load-model-1",
    id: "gpt-load",
    displayName: "Load model",
    provider: "openai",
    isFree: false,
    isBest: true,
  };
  // The bootstrap roster holds the saved agent below, so no lookup by id
  // is needed; a second roster request would show up in the count.
  await mswControl.registerMany([
    { method: "get", url: "/api/agents/chat-roster", body: [agent] },
    { method: "get", url: `/api/agents/${agent.id}`, body: agent },
    { method: "get", url: "/api/agents/credential-readiness", body: [] },
    { method: "get", url: "/api/llm-provider-api-keys", body: [key] },
    { method: "get", url: "/api/llm-provider-api-keys/available", body: [key] },
    { method: "get", url: "/api/llm-models/available", body: [model] },
    {
      method: "get",
      url: "/api/members/default-model",
      body: { modelId: model.dbId, chatApiKeyId: key.id },
    },
  ]);

  // The config seeds come from the page's own mock worker: their module
  // cannot load in the test runner. This first visit reads them under the
  // same mocks as the measured load below.
  await page.goto("/chat");
  await expect(page.getByTestId(E2eTestId.ChatPromptTextarea)).toBeVisible();
  const [config, publicConfig] = await page.evaluate(() =>
    Promise.all(
      ["/api/config", "/api/config/public"].map((url) =>
        fetch(url).then((response) => response.json()),
      ),
    ),
  );

  await mswControl.registerMany([
    {
      method: "get",
      url: "/api/bootstrap",
      body: {
        // The full chat view shows the agent and model chips.
        permissions: makeUserPermissions({
          chat: ["read", "create", "update", "delete", "full-view"],
        }),
        scopedCapabilities: adminScopedCapabilitiesSeed,
        organization: organizationSeed,
        config,
        publicConfig,
        appearance: appearanceSettingsSeed,
        memberDefaultAgent: {
          defaultAgentId: null,
          personalChatAgentId: agent.id,
        },
        memberDefaultModel: { modelId: model.dbId, chatApiKeyId: key.id },
      },
    },
  ]);
  await page.addInitScript((agentId) => {
    // Without the refresh snapshot the load is a cold one. Cleared as the
    // next document starts: the first page may still save one as it unloads.
    sessionStorage.clear();
    localStorage.setItem("selected-chat-agent", agentId);
  }, agent.id);
  const requests = countRequests(page);

  await page.goto("/chat");
  await expect(page.getByTestId(E2eTestId.ChatPromptTextarea)).toBeEditable();
  await expect(
    page.getByTestId(E2eTestId.ChatModelSelectorTrigger),
  ).toContainText("Load model");
  await page.waitForTimeout(1500);

  expect(requests.count("GET /api/bootstrap")).toBe(1);
  // Answered by the bootstrap.
  for (const path of [
    "/api/config/public",
    "/api/organization/appearance-settings",
    "/api/members/default-agent",
    "/api/members/default-model",
    "/api/user/permissions",
    "/api/config",
  ]) {
    expect(requests.count(`GET ${path}`), path).toBe(0);
  }
  // Signed in: the footer's version comes with the config.
  expect(requests.count("GET /health")).toBe(0);
  // The saved agent is in the starting roster.
  expect(requests.count("GET /api/agents/chat-roster")).toBe(1);
  // The composer's key and model lists are the page's own: the only key is
  // already in the usable-key list, and its models are all the models.
  expect(requests.count("GET /api/llm-provider-api-keys/available")).toBe(1);
  expect(requests.count("GET /api/llm-models/available")).toBe(1);
});
