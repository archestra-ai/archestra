import { E2eTestId } from "@shared";
import { ADMIN_EMAIL, ADMIN_PASSWORD, WIREMOCK_INTERNAL_URL } from "../../consts";
import { expect, test } from "../../fixtures";
import { loginViaApi } from "../../utils";

/**
 * Quickstart test: validates the first-time user experience end-to-end.
 * Login → create first API key (pointing at WireMock) → immediately chat → get mocked response.
 *
 * This test MUST run first in the quickstart CI job (before tests that seed data)
 * to validate the true fresh-install experience.
 */
test.describe("Quickstart", { tag: "@quickstart" }, () => {
  test.setTimeout(120_000);

  test("first-time user can add API key and immediately chat", async ({
    browser,
  }) => {
    // Fresh browser context — no pre-existing auth state
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();

    try {
      // 1. Login
      await page.goto("about:blank");
      await loginViaApi(page, ADMIN_EMAIL, ADMIN_PASSWORD);
      await page.goto("/chat");
      await page.waitForLoadState("domcontentloaded");

      // 2. Should see the "Add an LLM Provider Key" prompt
      await expect(page.getByText("Add an LLM Provider Key")).toBeVisible({
        timeout: 10_000,
      });

      // 3. Open dialog and create an OpenAI key pointing at WireMock
      await page.getByRole("button", { name: "Add API Key" }).click();
      await expect(
        page.getByRole("heading", { name: /Add API Key/i }),
      ).toBeVisible();

      // Select OpenAI
      await page.getByRole("combobox", { name: "Provider" }).click();
      await page.getByRole("option", { name: "OpenAI OpenAI" }).click();

      await page.getByLabel(/Name/i).fill("Quickstart Key");
      await page
        .getByRole("textbox", { name: /API Key/i })
        .fill("sk-quickstart-test");

      // Point at WireMock so the backend routes requests there
      await page
        .getByLabel(/Base URL/i)
        .fill(`${WIREMOCK_INTERNAL_URL}/v1`);

      await page.getByRole("button", { name: "Test & Create" }).click();

      // Wait for success
      await expect(
        page.getByText("API key created successfully"),
      ).toBeVisible({ timeout: 10_000 });

      // 4. Chat should now be immediately available
      const textarea = page.getByTestId(E2eTestId.ChatPromptTextarea);
      await expect(textarea).toBeVisible({ timeout: 15_000 });

      // 5. Select the OpenAI model (gpt-4o is in WireMock stubs)
      const modelSelectorTrigger = page.getByTestId(
        E2eTestId.ChatModelSelectorTrigger,
      );
      await expect(modelSelectorTrigger).toBeVisible({ timeout: 10_000 });
      await modelSelectorTrigger.click();
      await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5_000 });

      const searchInput = page.getByPlaceholder("Search models...");
      if (
        await searchInput.isVisible({ timeout: 1_000 }).catch(() => false)
      ) {
        await searchInput.fill("gpt-4o");
        await page.waitForTimeout(500);
      }

      const modelOption = page
        .getByRole("option")
        .filter({ hasText: "gpt-4o" });
      await expect(modelOption.first()).toBeVisible({ timeout: 5_000 });
      await modelOption.first().click();
      await expect(page.getByRole("dialog")).not.toBeVisible({
        timeout: 5_000,
      });

      // 6. Send a message (must contain "chat-ui-e2e-test" to match WireMock stub)
      await textarea.fill(
        "chat-ui-e2e-test quickstart: Hello, please respond.",
      );
      await page.keyboard.press("Enter");

      // 7. Verify mocked response from WireMock
      await expect(
        page.getByText(
          "This is a mocked response for the chat UI e2e test.",
        ),
      ).toBeVisible({ timeout: 90_000 });
    } finally {
      await context.close();
    }
  });
});
