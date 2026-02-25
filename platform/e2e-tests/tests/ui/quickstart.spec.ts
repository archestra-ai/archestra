import { E2eTestId } from "@shared";
import { ADMIN_EMAIL, ADMIN_PASSWORD, UI_BASE_URL } from "../../consts";
import { expect, test } from "../../fixtures";
import { loginViaApi } from "../../utils";

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

      // 2. Create an API key from the empty-state prompt
      await expect(page.getByText("Add an LLM Provider Key")).toBeVisible({
        timeout: 10_000,
      });
      await page.getByRole("button", { name: "Add API Key" }).click();

      // Default provider is Anthropic — switch to OpenAI (has WireMock stubs)
      await page.getByRole("combobox", { name: "Provider" }).click();
      await page.getByRole("option", { name: "OpenAI OpenAI" }).click();
      await page.getByLabel(/Name/i).fill("Quickstart Key");
      await page
        .getByRole("textbox", { name: /API Key/i })
        .fill("sk-quickstart-test");
      await page.getByRole("button", { name: "Test & Create" }).click();

      await expect(page.getByText("API key created successfully")).toBeVisible({
        timeout: 10_000,
      });

      // 3. Chat is immediately ready — model and key are auto-selected
      const textarea = page.getByTestId(E2eTestId.ChatPromptTextarea);
      await expect(textarea).toBeVisible({ timeout: 15_000 });

      // 4. Send a message and get mocked response
      // Message must contain "chat-ui-e2e-test" to match WireMock stub
      await textarea.fill("chat-ui-e2e-test quickstart: Hello!");
      await page.keyboard.press("Enter");

      await expect(
        page.getByText("This is a mocked response for the chat UI e2e test."),
      ).toBeVisible({ timeout: 90_000 });
    } finally {
      await context.close();
    }
  });
});
