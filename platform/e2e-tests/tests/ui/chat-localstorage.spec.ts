import { E2eTestId } from "@shared";
import { expect, test } from "../../fixtures";

test.describe("Chat localStorage persistence", () => {
  test.setTimeout(60_000);

  test("persists selected model to localStorage and restores on revisit", async ({
    page,
    goToPage,
  }) => {
    // Navigate to chat page
    await goToPage(page, "/chat");

    // Wait for the model selector to be visible
    const modelSelectorTrigger = page.getByTestId(
      E2eTestId.ChatModelSelectorTrigger,
    );
    await expect(modelSelectorTrigger).toBeVisible({ timeout: 15_000 });

    // Open model selector
    await modelSelectorTrigger.click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5_000 });

    // Pick a model that isn't the first one (to ensure we're actually changing something)
    // Get all model options and pick the second one if available
    const modelOptions = page.getByRole("option");
    const optionCount = await modelOptions.count();
    // Skip first option if it's the "Best available model" option
    const targetIndex = optionCount > 1 ? 1 : 0;
    const selectedOption = modelOptions.nth(targetIndex);
    const selectedModelText = await selectedOption.textContent();
    await selectedOption.click();

    // Wait for dialog to close
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 5_000 });

    // Verify localStorage was set
    const storedModel = await page.evaluate(() =>
      localStorage.getItem("archestra-chat-selected-chat-model"),
    );
    expect(storedModel).toBeTruthy();

    // Navigate away from chat
    await goToPage(page, "/tools");
    await page.waitForLoadState("domcontentloaded");

    // Navigate back to chat
    await goToPage(page, "/chat");
    await page.waitForLoadState("domcontentloaded");

    // Wait for model selector to be visible again
    await expect(modelSelectorTrigger).toBeVisible({ timeout: 15_000 });

    // Verify the model selector shows the previously selected model
    // The stored model ID should match what's displayed
    const restoredModel = await page.evaluate(() =>
      localStorage.getItem("archestra-chat-selected-chat-model"),
    );
    expect(restoredModel).toBe(storedModel);

    // Verify the trigger button still shows the selected model name
    if (selectedModelText) {
      // The model name should be visible in the trigger
      await expect(modelSelectorTrigger).toContainText(storedModel!, {
        timeout: 10_000,
      });
    }
  });

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
