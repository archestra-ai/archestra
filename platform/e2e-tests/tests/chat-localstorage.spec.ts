import { E2eTestId } from "@shared";
import { expect, test } from "../fixtures";

test.describe("Chat agent persistence", () => {
  test.setTimeout(60_000);

  test("persists selected agent to localStorage and restores on revisit", async ({
    page,
    goToPage,
  }) => {
    // Navigate to chat page
    await goToPage(page, "/chat");

    // Wait for the page to load
    const textarea = page.getByTestId(E2eTestId.ChatPromptTextarea);
    await expect(textarea).toBeVisible({ timeout: 15_000 });

    // Verify agent was stored in localStorage after page load
    // (auto-selection should have stored it)
    const storedAgent = await page.evaluate(() =>
      localStorage.getItem("selected-chat-agent"),
    );
    expect(storedAgent).toBeTruthy();

    // Navigate away
    await goToPage(page, "/tools");
    await page.waitForLoadState("domcontentloaded");

    // Navigate back to chat
    await goToPage(page, "/chat");
    await page.waitForLoadState("domcontentloaded");

    // Wait for chat to load
    await expect(textarea).toBeVisible({ timeout: 15_000 });

    // Verify the same agent is restored
    const restoredAgent = await page.evaluate(() =>
      localStorage.getItem("selected-chat-agent"),
    );
    expect(restoredAgent).toBe(storedAgent);
  });
});
