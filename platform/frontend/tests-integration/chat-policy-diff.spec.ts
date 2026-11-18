import { makeAgent } from "../src/mocks/data/agents";
import { makeLlmProviderApiKey } from "../src/mocks/data/llm-keys";
import { expect, test } from "./fixtures";
import { makeConversation } from "./helpers/chat-conversation";

test.use({ viewport: { width: 1360, height: 900 } });

test("reviews a large policy without expanding the chat, and keeps the review usable on a phone", async ({
  page,
  mswControl,
}, testInfo) => {
  const key = makeLlmProviderApiKey({ provider: "openai" });
  const agent = makeAgent({ llmApiKeyId: key.id });
  const conversation = makeConversation({
    id: "20000000-0000-4000-8000-0000000000f1",
    title: "Policy review",
    agentId: agent.id,
    messageCount: 0,
  });
  const before = Array.from(
    { length: 31_000 },
    (_, i) => `# Policy line ${i + 1}`,
  );
  const after = [...before];
  for (let i = 13_259; i < 22_259; i++) {
    after[i] = `tool_${i} = "updated"`;
  }
  after[29_999] = 'final_review = "updated"';
  const output = {
    structuredContent: {
      stage: "preview",
      delivery: "revision",
      path: "organization.appa.toml",
      before: before.join("\n"),
      after: after.join("\n"),
      diff: [
        "@@ -13257,9006 +13257,9006 @@",
        ...before.slice(13_256, 13_259).map((line) => ` ${line}`),
        ...before.slice(13_259, 22_259).map((line) => `-${line}`),
        ...after.slice(13_259, 22_259).map((line) => `+${line}`),
        ...after.slice(22_259, 22_262).map((line) => ` ${line}`),
        "@@ -29997,7 +29997,7 @@",
        ...before.slice(29_996, 29_999).map((line) => ` ${line}`),
        `-${before[29_999]}`,
        `+${after[29_999]}`,
        ...after.slice(30_000, 30_003).map((line) => ` ${line}`),
      ].join("\n"),
    },
  };
  const messages = [
    {
      id: "policy-request",
      role: "user",
      parts: [{ type: "text", text: "Preview the policy changes." }],
    },
    {
      id: "policy-preview",
      role: "assistant",
      parts: [
        {
          type: "tool-archestra__preview_guardrails_policy_change",
          toolCallId: "policy-preview-call",
          state: "output-available",
          input: {},
          output,
        },
      ],
    },
  ];
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
      body: [conversation],
    },
    {
      method: "get",
      url: `/api/chat/conversations/${conversation.id}`,
      body: { ...conversation, messages },
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
  const preview = page.getByRole("region", { name: "Diff preview" });
  await expect(preview).toBeVisible();
  await expect(page.getByText("9,001 added", { exact: true })).toBeVisible();
  await expect(page.getByText("9,001 removed", { exact: true })).toBeVisible();
  // The screenshot's five-digit line number must stay on a single line.
  const lineNumber = preview.getByText("13257", { exact: true });
  const lineNumberBox = await lineNumber.boundingBox();
  expect(lineNumberBox?.height).toBeLessThanOrEqual(20);
  const card = page.getByRole("region", { name: "Policy diff", exact: true });
  const originalHeight = (await card.boundingBox())?.height;
  expect(originalHeight).toBeLessThan(450);
  await page.screenshot({
    path: testInfo.outputPath("policy-diff-preview.png"),
  });

  const review = page.getByRole("button", { name: "Review full diff" });
  await review.click();
  const dialog = page.getByRole("dialog", { name: "Policy changes" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Next change" })).toBeEnabled(
    {
      timeout: 60_000,
    },
  );
  // Wait for Monaco's real diff worker and first-change reveal.
  await expect(
    dialog.getByText("tool_13259", { exact: false }).first(),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Next change" }).click();
  await expect(
    dialog.getByText('final_review = "updated"', { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Previous change" }).click();
  await expect(
    dialog.getByText("tool_13259", { exact: false }).first(),
  ).toBeVisible();
  const layout = dialog.getByRole("radiogroup", { name: "Layout" });
  const unified = layout.getByRole("radio", { name: "Unified", exact: true });
  const split = layout.getByRole("radio", { name: "Side by side" });
  const wrap = dialog.getByRole("switch", { name: "Wrap lines" });
  const unchanged = dialog.getByRole("switch", { name: "Show unchanged" });
  await expect(unified).toBeChecked();
  await expect(split).not.toBeChecked();
  await expect(wrap).not.toBeChecked();
  await expect(unchanged).not.toBeChecked();
  // Layout is a single choice with radio keyboard behavior; the switches
  // stay independent of both the selected layout and one another.
  await unified.focus();
  await page.keyboard.down("ArrowRight");
  await expect(split).toBeChecked();
  await page.keyboard.up("ArrowRight");
  await expect(unified).not.toBeChecked();
  await expect(unchanged).not.toBeChecked();
  await wrap.check();
  await expect(unchanged).not.toBeChecked();
  await unchanged.check();
  await expect(wrap).toBeChecked();
  await expect(split).toBeChecked();
  await expect(
    dialog.getByText("tool_13259", { exact: false }).first(),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("policy-diff-review.png"),
  });

  await dialog.getByRole("button", { name: "Find", exact: true }).click();
  const find = dialog.getByRole("textbox", { name: "Find", exact: true });
  await find.fill("final_review");
  await find.press("Enter");
  await expect(
    dialog.getByText('final_review = "updated"', { exact: true }),
  ).toBeVisible();
  await find.press("Escape");
  await expect(find).toBeHidden();
  await expect(layout).toBeVisible();

  await page.setViewportSize({ width: 390, height: 720 });
  await layout.getByText("Unified", { exact: true }).click();
  await expect(unified).toBeChecked();
  await expect(split).not.toBeChecked();
  await expect(wrap).toBeChecked();
  await expect(unchanged).toBeChecked();
  await expect(wrap).toBeInViewport();
  await expect(unchanged).toBeInViewport();
  await expect(
    dialog.getByRole("button", { name: "Next change" }),
  ).toBeInViewport();
  await expect(
    dialog.getByRole("button", { name: "Close", exact: true }),
  ).toBeInViewport();
  const bounds = await dialog.boundingBox();
  expect(bounds?.x).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(390);
  expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(720);
  await page.screenshot({
    path: testInfo.outputPath("policy-diff-mobile.png"),
  });

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(review).toBeFocused();
  expect((await card.boundingBox())?.height).toBeLessThan(450);
  // Closing and reopening gets a live, readable editor with fresh text models.
  await review.click();
  await expect(
    dialog.getByRole("button", { name: "Next change" }),
  ).toBeEnabled();
  await expect(
    dialog.getByText("tool_13259", { exact: false }).first(),
  ).toBeVisible();
});
