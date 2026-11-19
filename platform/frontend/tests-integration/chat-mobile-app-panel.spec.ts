import { E2eTestId } from "@archestra/shared/e2e-test-ids";
import type { Page } from "@playwright/test";
import { makeAgent } from "../src/mocks/data/agents";
import { makeLlmProviderApiKey } from "../src/mocks/data/llm-keys";
import { expect, test } from "./fixtures";
import { makeConversation } from "./helpers/chat-conversation";

// Real browser layout: jsdom applies no Tailwind, so it cannot tell whether
// the thread is on screen next to an open panel.
test.use({ viewport: { width: 375, height: 760 } });

const key = makeLlmProviderApiKey({ provider: "openai" });
const agent = makeAgent({ llmApiKeyId: key.id });
const conversation = makeConversation({
  id: "20000000-0000-4000-8000-0000000000d4",
  title: "Board chat",
  agentId: agent.id,
  messageCount: 4,
});

test.beforeEach(async ({ mswControl }) => {
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
      body: [{ ...conversation, messages: [] }],
    },
    {
      method: "get",
      url: `/api/chat/conversations/${conversation.id}`,
      body: conversation,
    },
    {
      method: "get",
      url: `/api/chat/conversations/${conversation.id}/files`,
      body: [],
    },
    {
      method: "get",
      url: `/api/chat/conversations/${conversation.id}/share`,
      body: null,
    },
  ]);
});

test("on a phone an open app shares the screen with the thread, so replies stay visible", async ({
  page,
}) => {
  await openWithPanel(page, "apps");

  const app = page.getByText("No Apps in this chat");
  const reply = page.getByText(/^Turn 3\./);
  await expect(app).toBeInViewport();
  await expect(reply).toBeInViewport();
  await expect(page.getByTestId(E2eTestId.ChatPromptTextarea)).toBeEditable();

  // App above, thread below, composer under both.
  const appBox = await app.boundingBox();
  const replyBox = await reply.boundingBox();
  const composerBox = await page
    .getByTestId(E2eTestId.ChatPromptTextarea)
    .boundingBox();
  if (!appBox || !replyBox || !composerBox) throw new Error("Missing parts");
  expect(appBox.y).toBeLessThan(replyBox.y);
  expect(replyBox.y + replyBox.height).toBeLessThanOrEqual(composerBox.y);
});

test("on a phone the Files panel still takes the screen from the thread", async ({
  page,
}) => {
  await openWithPanel(page, "files");

  await expect(page.getByTestId(E2eTestId.ChatPromptTextarea)).toBeEditable();
  await expect(page.getByText(/^Turn 3\./)).toBeHidden();
});

// The chat page restores a conversation's panel from these per-conversation
// keys (`conversationStorageKeys` in lib/chat/chat-utils.ts).
async function openWithPanel(page: Page, tab: "apps" | "files") {
  await page.addInitScript(
    ({ id, tab }) => {
      localStorage.setItem(`archestra-chat-right-panel-open-${id}`, "true");
      localStorage.setItem(`archestra-chat-right-panel-tab-${id}`, tab);
    },
    { id: conversation.id, tab },
  );
  await page.goto(`/chat/${conversation.id}`);
}
