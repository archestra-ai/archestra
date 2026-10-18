import { E2eTestId } from "@archestra/shared";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  LLM_PROVIDER_API_KEYS_AVAILABLE_ROUTE,
  UI_BASE_URL,
} from "../consts";
import { expect, test } from "../fixtures";
import {
  createLlmProviderApiKey,
  expectChatReady,
  loginViaApi,
  sendChatMessage,
} from "../utils";

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
      // The optimistic composer can appear before provider discovery finishes.
      // Choose the expected first-run state from the account's actual keys,
      // then require its corresponding UI instead of racing the first frame.
      const keysResponse = await page.request.get(
        `${UI_BASE_URL}${LLM_PROVIDER_API_KEYS_AVAILABLE_ROUTE}`,
      );
      await expect(keysResponse).toBeOK();
      const availableKeys = await keysResponse.json();
      expect(Array.isArray(availableKeys)).toBe(true);
      await page.goto(`${UI_BASE_URL}/chat`);
      await page.waitForLoadState("domcontentloaded");

      // 2. Handle both quickstart states:
      //    - empty-state onboarding that requires creating the first key
      //    - already-ready chat with a default/system key selected
      const addApiKeyButton = page.getByTestId(
        E2eTestId.QuickstartAddApiKeyButton,
      );
      const chatPrompt = page.getByTestId(E2eTestId.ChatPromptTextarea);
      if (availableKeys.length === 0) {
        await expect(addApiKeyButton).toBeVisible({ timeout: 20_000 });
        await createLlmProviderApiKey(page, {
          name: "Quickstart Key",
          apiKey: "sk-quickstart-test",
          providerOptionName: /^OpenAI$/,
          // Quickstart dialog redirects to /chat on success; the api-keys list
          // row never renders here.
          waitForRow: false,
        });
        // After the org's first provider key, first-run shows a "set a default
        // model" step before the chat composer opens. Skip it to advance to
        // chat. Defensive because a shared-DB org that already has a default
        // model skips the step and lands straight on chat.
        await page
          .getByTestId(E2eTestId.OnboardingDefaultModelSkip)
          .waitFor({ state: "visible", timeout: 10_000 })
          .then(() =>
            page.getByTestId(E2eTestId.OnboardingDefaultModelSkip).click(),
          )
          .catch(() => {});
      } else {
        await expect(chatPrompt).toBeVisible({ timeout: 15_000 });
      }

      // 3. Chat is immediately ready — model and key are auto-selected
      await expectChatReady(page);

      // 4. Send a message and get mocked response.
      // Message must contain "chat-ui-e2e-test" to match WireMock stub.
      // Listen for the POST /api/chat response (headers only — SSE
      // body still streams afterwards) so a 5xx surfaces as a network
      // error in <30s instead of a 90s "text not visible" UI timeout.
      const chatResponsePromise = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          /\/api\/chat(?:\?|$)/.test(response.url()),
        { timeout: 30_000 },
      );
      await sendChatMessage(page, "chat-ui-e2e-test quickstart: Hello!");
      const chatResponse = await chatResponsePromise;
      if (!chatResponse.ok()) {
        throw new Error(
          `POST /api/chat returned ${chatResponse.status()}: ${await chatResponse.text()}`,
        );
      }

      await expect(
        page.getByText("This is a mocked response for the chat UI e2e test."),
      ).toBeVisible({ timeout: 90_000 });
    } finally {
      await context.close();
    }
  });
});
