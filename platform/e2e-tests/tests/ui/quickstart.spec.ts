import { E2eTestId } from "@shared";
import { ADMIN_EMAIL, ADMIN_PASSWORD, UI_BASE_URL } from "../../consts";
import { expect, test } from "../../fixtures";
import { loginViaApi } from "../../utils";
import { createChatApiKey } from "../../utils/chat-settings";
import { expectChatReady, sendChatMessage } from "../../utils/chat-ui";

/**
 * Quickstart test: validates the first-time user experience end-to-end.
 * Login → create first API key → immediately send a message → get response.
 *
 * The quickstart CI job sets ARCHESTRA_OPENAI_BASE_URL to point at WireMock,
 * so the backend routes OpenAI requests to mocked responses. Model sync
 * fetches models from WireMock, and auto-select picks the model + key.
 */
test.describe("Quickstart", { tag: "@quickstart" }, () => {
  test.setTimeout(120_000);

  test("first-time user can add API key and immediately chat", async ({
    browser,
  }) => {
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();

    try {
      // 1. Login and navigate to chat
      await page.goto("about:blank");
      await loginViaApi(page, ADMIN_EMAIL, ADMIN_PASSWORD);
      await page.goto(`${UI_BASE_URL}/chat`);
      await page.waitForLoadState("domcontentloaded");

      // 2. Handle both quickstart states:
      //    - empty-state onboarding that requires creating the first key
      //    - already-ready chat with a default/system key selected
      const addApiKeyButton = page.getByTestId(
        E2eTestId.QuickstartAddApiKeyButton,
      );
      const chatPrompt = page.getByTestId(E2eTestId.ChatPromptTextarea);
      const quickstartState = await expect
        .poll(
          async () => {
            if (await addApiKeyButton.isVisible().catch(() => false)) {
              return "onboarding";
            }

            if (await chatPrompt.isVisible().catch(() => false)) {
              return "chat-ready";
            }

            return null;
          },
          {
            timeout: 20_000,
            intervals: [500, 1000, 2000, 5000],
          },
        )
        .toBeTruthy()
        .then(async () => {
          if (await addApiKeyButton.isVisible().catch(() => false)) {
            return "onboarding" as const;
          }

          return "chat-ready" as const;
        });

      if (quickstartState === "onboarding") {
        await createChatApiKey(page, {
          name: "Quickstart Key",
          apiKey: "sk-quickstart-test",
          providerOptionName: "OpenAI OpenAI",
        });

        await expect(
          page.getByText("API key created successfully"),
        ).toBeVisible({
          timeout: 10_000,
        });
      } else {
        await expect(chatPrompt).toBeVisible({ timeout: 15_000 });
      }

      // 3. Chat is immediately ready — model and key are auto-selected
      await expectChatReady(page);

      // 4. Send a message and get mocked response
      // Message must contain "chat-ui-e2e-test" to match WireMock stub
      await sendChatMessage(page, "chat-ui-e2e-test quickstart: Hello!");

      await expect(
        page.getByText("This is a mocked response for the chat UI e2e test."),
      ).toBeVisible({ timeout: 90_000 });
    } finally {
      await context.close();
    }
  });
});
