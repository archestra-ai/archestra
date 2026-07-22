import { E2eTestId, getSubscriptionSignInRowTestId } from "@archestra/shared";
import { ADMIN_EMAIL, ADMIN_PASSWORD, UI_BASE_URL } from "../consts";
import { expect, test } from "../fixtures";
import { loginViaApi } from "../utils";

/**
 * The "Use a subscription" dialog surfaces the three per-user subscription
 * connections (ChatGPT, GitHub Copilot, Microsoft 365 Copilot) as a top-level
 * path, instead of burying them inside the provider=OpenAI key form. The OAuth
 * device flow itself needs an external provider, so this test only asserts the
 * dialog opens with all three connections offered.
 */
test.describe("Use a subscription", () => {
  test("opens the subscription dialog with all three connections", async ({
    browser,
  }) => {
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();

    try {
      await page.goto("about:blank");
      await loginViaApi(page, ADMIN_EMAIL, ADMIN_PASSWORD);
      await page.goto(`${UI_BASE_URL}/llm/model-providers`);
      await page.waitForLoadState("domcontentloaded");

      const useSubscriptionButton = page.getByTestId(
        E2eTestId.UseSubscriptionButton,
      );
      await expect(useSubscriptionButton).toBeVisible({ timeout: 15_000 });
      await useSubscriptionButton.click();

      await expect(
        page.getByTestId(E2eTestId.UseSubscriptionDialog),
      ).toBeVisible();

      for (const provider of [
        "openai",
        "github-copilot",
        "microsoft-365-copilot",
      ]) {
        await expect(
          page.getByTestId(getSubscriptionSignInRowTestId(provider)),
        ).toBeVisible();
      }
    } finally {
      await context.close();
    }
  });
});
