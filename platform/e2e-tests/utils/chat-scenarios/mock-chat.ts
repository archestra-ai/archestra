import type { Page, Route } from "@playwright/test";
import type { archestraApiTypes } from "@shared";
import { buildMockChatStreamBody, getMockChatStreamUrl } from "./stream-server";
import type { MockChatScenario } from "./types";

type ChatConversation = archestraApiTypes.GetChatConversationResponses["200"];

const BASE_AGENT = {
  id: "00000000-0000-4000-8000-000000000099",
  name: "Mock Scenario Agent",
  systemPrompt: "Mock scenario agent system prompt",
  agentType: "profile" as const,
  llmApiKeyId: null,
};

export async function installMockChatScenario(
  page: Page,
  scenario: MockChatScenario,
) {
  const conversationResponse = buildConversationResponse(scenario);
  const conversationSummary = buildConversationSummary(scenario);

  await page.route("**/api/chat/conversations", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([conversationSummary]),
    });
  });

  await page.route(
    `**/api/chat/conversations/${scenario.route.conversationId}`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(conversationResponse),
      });
    },
  );

  await page.route(
    `**/api/chat/conversations/${scenario.route.conversationId}/generate-title`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          title: conversationSummary.title,
        }),
      });
    },
  );

  await page.route(
    `**/api/chat/conversations/${scenario.route.conversationId}/enabled-tools`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          hasCustomSelection: false,
          enabledToolIds: [],
        }),
      });
    },
  );

  await page.route(`**/api/agents/${BASE_AGENT.id}/tools`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  await page.route(
    `**/api/chat/agents/${BASE_AGENT.id}/mcp-tools`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    },
  );

  await page.route(
    `**/api/agents/${BASE_AGENT.id}/delegations`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    },
  );

  if (scenario.mode !== "seeded") {
    await page.route("**/api/chat", async (route) => {
      await assertChatRequest(route, scenario);
      await route.continue({
        url: getMockChatStreamUrl(),
        headers: {
          ...route.request().headers(),
          "content-type": "application/json",
        },
        postData: buildMockChatStreamBody({
          requestBody: route.request().postData() ?? "{}",
          scenario,
        }),
      });
    });
  }
}

function buildConversationResponse(
  scenario: MockChatScenario,
): ChatConversation & { unsafeContextBoundary?: unknown } {
  const now = "2026-04-23T10:00:00.000Z";
  return {
    id: scenario.route.conversationId,
    userId: "00000000-0000-4000-8000-000000000100",
    organizationId: "00000000-0000-4000-8000-000000000101",
    agentId: BASE_AGENT.id,
    chatApiKeyId: null,
    title: `Mock chat scenario: ${scenario.id}`,
    selectedModel: "gpt-5.4-mini",
    selectedProvider: "openai",
    hasCustomToolSelection: false,
    todoList: null,
    artifact: null,
    pinnedAt: null,
    createdAt: now,
    updatedAt: now,
    agent: BASE_AGENT,
    share: null,
    messages: scenario.seededConversation?.messages ?? [],
    chatErrors: scenario.seededConversation?.chatErrors ?? [],
    ...(scenario.seededConversation?.unsafeContextBoundary
      ? {
          unsafeContextBoundary:
            scenario.seededConversation.unsafeContextBoundary,
        }
      : {}),
  };
}

function buildConversationSummary(scenario: MockChatScenario) {
  const now = "2026-04-23T10:00:00.000Z";
  return {
    id: scenario.route.conversationId,
    title: `Mock chat scenario: ${scenario.id}`,
    createdAt: now,
    updatedAt: now,
    agentId: BASE_AGENT.id,
    pinnedAt: null,
    selectedModel: "gpt-5.4-mini",
    selectedProvider: "openai",
    share: null,
  };
}

async function assertChatRequest(route: Route, scenario: MockChatScenario) {
  const expectedText = scenario.request?.assertLastUserMessageIncludes;
  if (!expectedText) {
    return;
  }

  const requestBodyText = route.request().postData() ?? "{}";
  const requestBody = JSON.parse(requestBodyText) as {
    messages?: Array<{
      parts?: Array<{
        type?: string;
        text?: string;
      }>;
    }>;
  };

  const lastMessage = requestBody.messages?.[requestBody.messages.length - 1];
  const lastTextPart = lastMessage?.parts?.find((part) => part.type === "text");
  if (!lastTextPart?.text?.includes(expectedText)) {
    throw new Error(
      `Scenario ${scenario.id} expected last user text to include "${expectedText}" but received "${lastTextPart?.text ?? ""}"`,
    );
  }
}
