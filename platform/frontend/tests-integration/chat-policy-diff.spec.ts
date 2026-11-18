import { makeAgent } from "../src/mocks/data/agents";
import { makeLlmProviderApiKey } from "../src/mocks/data/llm-keys";
import { expect, test } from "./fixtures";
import { makeConversation } from "./helpers/chat-conversation";

test.use({ viewport: { width: 1360, height: 900 } });

test("reviews a large policy without expanding the chat, and keeps the review usable on a phone", async ({
  page,
  mswControl,
}, testInfo) => {
  // Opening and reopening each run a large diff computation.
  testInfo.setTimeout(120_000);
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
        {
          type: "text",
          text: `The policy changes are ready for review.\n\n\`\`\`diff\n${output.structuredContent.diff}\n\`\`\`\n\nPlease review before applying.`,
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
  await expect(
    page.getByText("The policy changes are ready for review.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Please review before applying.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Code block", exact: true }),
  ).toHaveCount(0);
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
  // Allow the 30-second diff computation budget plus first-change rendering.
  await expect(
    dialog.getByText("tool_13259", { exact: false }).first(),
  ).toBeVisible({ timeout: 60_000 });
  // Monaco's scroll tracks and change overview are nonsemantic elements.
  const verticalTracks = dialog
    .locator(".scrollbar.vertical, .diffOverview")
    .filter({ visible: true });
  const proposedEditor = dialog.locator(".modified-in-monaco-diff-editor");
  await proposedEditor.hover();
  await expect(verticalTracks).toHaveCount(1);
  await dialog.getByRole("button", { name: "Next change" }).click();
  await expect(
    dialog.getByText('final_review = "updated"', { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Previous change" }).click();
  await expect(
    dialog.getByText("tool_13259", { exact: false }).first(),
  ).toBeVisible();
  const split = dialog.getByRole("switch", { name: "Side by side view" });
  await expect(split).not.toBeChecked();
  // Layout remains keyboard accessible; unchanged regions use inline controls.
  await split.focus();
  await split.press("Space");
  await expect(split).toBeChecked();
  await proposedEditor.hover();
  await expect(verticalTracks).toHaveCount(1);
  await dialog
    .getByRole("button", { name: "Show Unchanged Region", exact: true })
    .first()
    .click();
  await dialog
    .getByRole("textbox", { name: /Proposed policy/ })
    .press("Control+Home");
  await expect(
    dialog.getByText("# Policy line 1", { exact: true }).first(),
  ).toBeVisible();
  // Monaco exposes collapse as a glyph-margin decoration without an ARIA role.
  await dialog
    .locator(".fold-unchanged")
    .filter({ visible: true })
    .first()
    .click();
  await expect(
    dialog.getByText("13256 hidden lines", { exact: true }).first(),
  ).toBeVisible();
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
  await expect(split).toBeVisible();

  await page.setViewportSize({ width: 390, height: 720 });
  await split.uncheck();
  await expect(split).not.toBeChecked();
  await proposedEditor.hover();
  await expect(verticalTracks).toHaveCount(1);
  await expect(split).toBeInViewport();
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
  ).toBeVisible({ timeout: 60_000 });
});
