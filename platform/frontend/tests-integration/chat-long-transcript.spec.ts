import { E2eTestId } from "@archestra/shared/e2e-test-ids";
import type { Page } from "@playwright/test";
import { makeAgent } from "../src/mocks/data/agents";
import { makeLlmProviderApiKey } from "../src/mocks/data/llm-keys";
import { expect, test } from "./fixtures";
import { makeConversation } from "./helpers/chat-conversation";

const MESSAGE = ".group.is-user, .group.is-assistant";

/** Where the first fully visible message sits in the viewport, and its text. */
function firstVisibleMessage(page: Page) {
  return page.evaluate((selector) => {
    for (const element of document.querySelectorAll(selector)) {
      const { top } = element.getBoundingClientRect();
      if (top > 60) return { text: element.textContent?.slice(0, 9), top };
    }
    return null;
  }, MESSAGE);
}

test("a long conversation opens on its end and mounts earlier messages on scroll-up, keeping the reader's place", async ({
  page,
  mswControl,
}) => {
  const key = makeLlmProviderApiKey({ provider: "openai" });
  const agent = makeAgent({ llmApiKeyId: key.id });
  const conversation = makeConversation({
    id: "20000000-0000-4000-8000-0000000000c3",
    title: "Long transcript",
    agentId: agent.id,
    messageCount: 120,
  });
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

  await page.goto(`/chat/${conversation.id}`);
  await expect(page.getByTestId(E2eTestId.ChatPromptTextarea)).toBeEditable();
  // The end is mounted and in view; the start is not mounted.
  const last = page.getByText(/^Turn 119\./);
  await expect(last).toBeInViewport();
  await expect(page.locator(MESSAGE)).toHaveCount(30);
  await expect(page.getByText(/^Turn 0\./)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Show earlier messages (90 not shown)" }),
  ).toBeVisible();

  // Scroll up like a reader until earlier messages mount.
  const scroller = page.locator("[role=log] > div").first();
  let mounted = 30;
  for (let step = 0; step < 40 && mounted === 30; step++) {
    const before = await firstVisibleMessage(page);
    await scroller.evaluate((element) => element.scrollBy(0, -400));
    await page.waitForTimeout(150);
    mounted = await page.locator(MESSAGE).count();
    if (mounted > 30 && before) {
      // The message the reader was looking at moved by the scroll only.
      const after = await page.evaluate(
        ({ selector, text }) => {
          for (const element of document.querySelectorAll(selector))
            if (element.textContent?.slice(0, 9) === text)
              return element.getBoundingClientRect().top;
          return null;
        },
        { selector: MESSAGE, text: before.text },
      );
      expect(after).not.toBeNull();
      expect(Math.abs((after as number) - (before.top + 400))).toBeLessThan(2);
    }
  }
  expect(mounted).toBe(60);

  // The keyboard path loads the rest without scrolling.
  await page
    .getByRole("button", { name: /Show earlier messages/ })
    .first()
    .click();
  await expect(page.locator(MESSAGE)).toHaveCount(90);

  await page.goto(`/chat/${conversation.id}#message-%`);
  await page.reload();
  await expect(page.getByTestId(E2eTestId.ChatPromptTextarea)).toBeEditable();
  await expect(page.getByText(/^Turn 119\./)).toBeInViewport();
  await expect(page.locator(MESSAGE)).toHaveCount(30);
  await expect(
    page.getByRole("button", { name: "Show earlier messages (90 not shown)" }),
  ).toBeVisible();
  await page.goto(`/chat/${conversation.id}#message-${conversation.id}-m5`);
  await page.reload();
  await expect(page.getByText(/^Turn 5\./)).toBeInViewport();
});
