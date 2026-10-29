import { makeAgent } from "../src/mocks/data/agents";
import { makeUserPermissions } from "../src/mocks/data/auth";
import { makeLlmProviderApiKey } from "../src/mocks/data/llm-keys";
import { makeOrganization } from "../src/mocks/data/organization";
import { expect, test } from "./fixtures";

for (const scenario of [
  { name: "new chat", path: "/chat", canSetDefault: true, hasDefault: false },
  {
    name: "conversation URL",
    path: "/chat/previous-conversation",
    canSetDefault: true,
    hasDefault: false,
  },
  {
    name: "without settings permission",
    path: "/chat/previous-conversation",
    canSetDefault: false,
    hasDefault: false,
  },
  {
    name: "existing organization default",
    path: "/chat/previous-conversation",
    canSetDefault: true,
    hasDefault: true,
  },
]) {
  test(`first provider key setup: ${scenario.name}`, async ({
    page,
    mswControl,
  }) => {
    const { path, canSetDefault, hasDefault } = scenario;
    const key = makeLlmProviderApiKey({ provider: "anthropic" });
    const organization = makeOrganization({
      defaultModelId: hasDefault ? "existing-model" : null,
      defaultLlmApiKeyId: hasDefault ? key.id : null,
    });
    await mswControl.registerMany([
      { method: "get", url: "/api/organization", body: organization },
      {
        method: "get",
        url: "/api/user/permissions",
        body: makeUserPermissions({
          organizationSettings: canSetDefault ? ["read", "update"] : ["read"],
        }),
      },
      { method: "get", url: "/api/members/default-model", body: null },
      { method: "get", url: "/api/projects/labels/keys", body: [] },
      {
        method: "get",
        url: "/api/chat/conversations/previous-conversation/files",
        body: [],
      },
      {
        method: "get",
        url: "/api/chat/conversations/previous-conversation",
        status: 404,
        body: { error: { message: "Conversation not found" } },
      },
      { method: "get", url: "/api/llm-provider-api-keys", body: [] },
      { method: "get", url: "/api/llm-provider-api-keys/available", body: [] },
      { method: "get", url: "/api/agents/chat-roster", body: [makeAgent()] },
      { method: "post", url: "/api/llm-provider-api-keys", body: key },
    ]);

    await page.goto(path);
    await page
      .getByRole("button", { name: "Add API Key", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: /API Key/i })
      .fill("sk-test-onboarding");
    await mswControl.registerMany([
      { method: "get", url: "/api/llm-provider-api-keys", body: [key] },
      {
        method: "get",
        url: "/api/llm-provider-api-keys/available",
        body: [key],
      },
    ]);
    await page.getByRole("button", { name: "Test & Create" }).click();
    if (canSetDefault && !hasDefault) {
      await expect(page).toHaveURL(new RegExp(`${path}$`));

      await expect(
        page.getByRole("button", { name: "Choose model", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("textbox", { name: "What would you like to get done?" }),
      ).toBeHidden();
      await page.getByRole("button", { name: "Skip for now" }).click();
    }
    await expect(
      page.getByRole("button", { name: "Choose model", exact: true }),
    ).toBeHidden();
    await expect(page).toHaveURL(/\/chat$/);
    await expect(
      page.getByRole("textbox", { name: "What would you like to get done?" }),
    ).toBeVisible();

    // Skipping is one-shot: a later visit must not prompt for a default again.
    await page.getByRole("link", { name: "Projects", exact: true }).click();
    await expect(page).toHaveURL(/\/projects$/);
    await page.getByRole("link", { name: /^New chat/ }).click();
    await expect(page).toHaveURL(/\/chat$/);
    await expect(
      page.getByRole("textbox", { name: "What would you like to get done?" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Choose model", exact: true }),
    ).toBeHidden();
  });
}
