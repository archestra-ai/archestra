import { expect, test } from "./fixtures";

const CHAT_MODEL_SELECTOR_TRIGGER = "chat-model-selector-trigger";

test("switches between a personal subscription and provider key while creating an agent", async ({
  page,
  mswControl,
}) => {
  const personalSubscription = {
    id: "personal-subscription",
    name: "ChatGPT subscription",
    provider: "openai",
    scope: "personal",
    userId: "test-user-admin",
    subscriptionKind: "chatgpt",
    requiresReauthentication: false,
    bestModelId: "personal-model",
  };
  const providerKey = {
    id: "provider-key",
    name: "Anthropic provider",
    provider: "anthropic",
    scope: "org",
    userId: null,
    subscriptionKind: null,
    requiresReauthentication: false,
    bestModelId: "provider-model",
  };
  const personalModel = {
    dbId: "personal-model",
    id: "gpt-5",
    displayName: "GPT-5",
    provider: "openai",
    isFree: false,
    isBest: true,
  };
  const providerModel = {
    dbId: "provider-model",
    id: "claude-sonnet-4-5",
    displayName: "Claude Sonnet 4.5",
    provider: "anthropic",
    isFree: false,
    isBest: true,
  };

  await mswControl.registerMany([
    {
      method: "get",
      url: "/api/llm-provider-api-keys/available",
      body: [personalSubscription, providerKey],
    },
    {
      method: "get",
      url: "/api/llm-models/available",
      body: [personalModel, providerModel],
    },
    {
      method: "get",
      url: "/api/llm-models/available",
      query: { apiKeyId: personalSubscription.id },
      body: [personalModel],
      delayMs: 50,
    },
    {
      method: "get",
      url: "/api/llm-models/available",
      query: { apiKeyId: providerKey.id },
      body: [providerModel],
      delayMs: 50,
    },
  ]);

  const maximumDepthErrors: string[] = [];
  page.on("pageerror", (error) => {
    if (error.message.includes("Maximum update depth exceeded")) {
      maximumDepthErrors.push(error.message);
    }
  });
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      message.text().includes("Maximum update depth exceeded")
    ) {
      maximumDepthErrors.push(message.text());
    }
  });

  await page.goto("/agents/new");
  await page.getByRole("button", { name: /Start from scratch/ }).click();

  for (let index = 0; index < 10; index++) {
    await page
      .getByRole("button", {
        name: /Organization default|Anthropic provider/,
      })
      .click();
    await page.getByRole("option", { name: /ChatGPT subscription/ }).click();
    await expect(page.getByTestId(CHAT_MODEL_SELECTOR_TRIGGER)).toContainText(
      "GPT-5",
    );

    await page.getByRole("button", { name: /ChatGPT subscription/ }).click();
    await page.getByRole("option", { name: /Anthropic provider/ }).click();
    await expect(page.getByTestId(CHAT_MODEL_SELECTOR_TRIGGER)).toContainText(
      "Claude Sonnet 4.5",
    );
  }

  expect(maximumDepthErrors).toEqual([]);
});
