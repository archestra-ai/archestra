import { makeAgent } from "../src/mocks/data/agents";
import { makeLlmProviderApiKey } from "../src/mocks/data/llm-keys";
import { makeOrganization } from "../src/mocks/data/organization";
import { expect, test } from "./fixtures";
import { makeConversation } from "./helpers/chat-conversation";

test("upload and browser switches save and cancel, with the upload warning above its description on desktop and mobile", async ({
  page,
  mswControl,
}, testInfo) => {
  const organization = makeOrganization();
  await mswControl.use({
    method: "get",
    url: "/api/organization",
    body: organization,
  });
  await page.goto("/settings/agents");
  const uploads = page.getByRole("switch", {
    name: "Chat File Uploads",
    exact: true,
  });
  const browser = page.getByRole("switch", {
    name: "Built-in Browser (Playwright MCP)",
    exact: true,
  });
  await expect(uploads).toBeChecked();
  await expect(browser).toBeChecked();
  await expect(browser).toBeEnabled();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await uploads.scrollIntoViewIfNeeded();
    const title = await page
      .getByRole("heading", { name: "Chat File Uploads", exact: true })
      .boundingBox();
    const notice = await page
      .getByRole("alert")
      .filter({ hasText: "Uploads may contain sensitive information." })
      .boundingBox();
    const description = await page
      .getByText(/Allow users to upload files in/)
      .boundingBox();
    const toggle = await uploads.boundingBox();
    if (!title || !notice || !description || !toggle)
      throw new Error("Upload controls missing");
    expect(title.y + title.height).toBeLessThanOrEqual(notice.y);
    expect(notice.y + notice.height).toBeLessThanOrEqual(description.y);
    expect(
      Math.abs(
        description.y + description.height / 2 - toggle.y - toggle.height / 2,
      ),
    ).toBeLessThan(2);
    expect(toggle.x + toggle.width).toBeLessThanOrEqual(width);
    await browser.scrollIntoViewIfNeeded();
    const browserDescription = await page
      .getByText(/Allow agents to use the built-in browser\./)
      .boundingBox();
    const browserToggle = await browser.boundingBox();
    if (!browserDescription || !browserToggle)
      throw new Error("Browser controls missing");
    expect(browserToggle.x).toBeGreaterThanOrEqual(
      browserDescription.x + browserDescription.width,
    );
    expect(
      Math.abs(
        browserDescription.y +
          browserDescription.height / 2 -
          browserToggle.y -
          browserToggle.height / 2,
      ),
    ).toBeLessThan(2);
    expect(browserToggle.x + browserToggle.width).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: testInfo.outputPath(`settings-${width}.png`),
    });
  }
  await uploads.click();
  await browser.click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(uploads).toBeChecked();
  await expect(browser).toBeChecked();
  await uploads.click();
  await browser.click();
  await mswControl.use({
    method: "patch",
    url: "/api/organization/security-settings",
    body: {
      ...organization,
      allowChatFileUploads: false,
      playwrightMcpEnabled: false,
    },
  });
  const request = page.waitForRequest(
    (r) =>
      r.method() === "PATCH" &&
      r.url().endsWith("/api/organization/security-settings"),
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect((await request).postDataJSON()).toEqual({
    allowChatFileUploads: false,
    playwrightMcpEnabled: false,
  });
  await expect(uploads).not.toBeChecked();
  await expect(browser).not.toBeChecked();
});

test("a settings editor without an administrator role can change uploads but cannot disable the browser", async ({
  page,
  mswControl,
}) => {
  await mswControl.use({
    method: "get",
    url: "/api/user/permission-sources",
    body: [
      {
        role: "settings-editor",
        team: null,
        permissions: { organizationSettings: ["read", "update"] },
      },
    ],
  });
  await page.goto("/settings/agents");
  await expect(
    page.getByRole("switch", { name: "Chat File Uploads", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("switch", {
      name: "Built-in Browser (Playwright MCP)",
      exact: true,
    }),
  ).toBeDisabled();
});

test("a detached browser preview is blocked by current organization policy", async ({
  page,
  mswControl,
}) => {
  await mswControl.use({
    method: "get",
    url: "/api/organization",
    body: makeOrganization({ playwrightMcpEnabled: false }),
  });
  await page.goto("/chat/browser-preview/30000000-0000-4000-8000-0000000000b1");
  await expect(
    page.getByText("The built-in browser is unavailable."),
  ).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(0);
});

test("chat refreshes browser policy and closes an already open panel", async ({
  page,
  mswControl,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const key = makeLlmProviderApiKey({ provider: "openai" });
  const agent = makeAgent({ llmApiKeyId: key.id });
  const conversation = makeConversation({
    id: "20000000-0000-4000-8000-0000000000b4",
    title: "Browser policy test",
    agentId: agent.id,
    messageCount: 2,
  });
  await mswControl.registerMany([
    { method: "get", url: "/api/organization", body: makeOrganization() },
    { method: "get", url: "/api/llm-provider-api-keys", body: [key] },
    { method: "get", url: "/api/llm-provider-api-keys/available", body: [key] },
    { method: "get", url: "/api/agents/chat-roster", body: [agent] },
    { method: "get", url: `/api/agents/${agent.id}`, body: agent },
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
  const browser = page.getByRole("tab", { name: "Browser", exact: true });
  await expect(browser).toBeVisible();
  await browser.click();
  await expect(
    page.getByRole("textbox", { name: "URL to navigate", exact: true }),
  ).toBeVisible();
  await mswControl.use({
    method: "get",
    url: "/api/organization",
    body: makeOrganization({ playwrightMcpEnabled: false }),
  });
  await expect(browser).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "URL to navigate", exact: true }),
  ).toHaveCount(0);
});
