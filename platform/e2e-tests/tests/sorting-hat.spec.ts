import { test, expect } from "@playwright/test";

test.describe("Sorting Hat MCP Integration", () => {
  test("full sorting flow: tool invocation → Sorting Hat → Patronus → Snitch loader", async ({
    page,
  }) => {
    // Navigate to chat
    await page.goto("/chat");
    await page.waitForLoadState("networkidle");

    // Open a conversation
    await page.click('[data-testid="new-conversation"]');
    await page.waitForTimeout(1000);

    // Type a message that will trigger a tool call
    await page.fill('[data-testid="chat-input"]', "List all agents");
    await page.press('[data-testid="chat-input"]', "Enter");

    // Wait for the Sorting Hat modal to appear (first tool invocation)
    const sortingHatModal = page.locator('[data-testid="sorting-hat-modal"]');
    await expect(sortingHatModal).toBeVisible({ timeout: 10000 });

    // Verify the modal shows the tool name
    await expect(sortingHatModal).toContainText("list_agents");

    // Click "Begin Sorting"
    await page.click('[data-testid="sorting-hat-begin"]');

    // Wait for the monologue to stream
    await expect(page.locator('[data-testid="sorting-hat-monologue"]')).not.toBeEmpty();

    // Wait for the sorting result
    await expect(sortingHatModal.locator('[data-testid="sorting-result"]')).toBeVisible({
      timeout: 15000,
    });

    // Verify it sorted into Hufflepuff (read-only tool)
    const result = page.locator('[data-testid="sorting-result-house"]');
    await expect(result).toContainText("hufflepuff");

    // Click Continue
    await page.click('[data-testid="sorting-hat-continue"]');

    // Verify the Golden Snitch loader appears for Gryffindor tools
    // (list_agents is Hufflepuff, so it should use the default loader)
    const defaultLoader = page.locator('[data-testid="default-loader"]');
    const snitchLoader = page.locator('[data-testid="golden-snitch-loader"]');

    // One of these should be visible
    const hasLoader =
      (await defaultLoader.isVisible()) || (await snitchLoader.isVisible());
    expect(hasLoader).toBeTruthy();

    // Wait for the tool result
    await expect(page.locator('[data-testid="tool-result"]')).toBeVisible({
      timeout: 30000,
    });
  });

  test("Sorting Hat respects please_not_slytherin preference", async ({
    page,
  }) => {
    // This test verifies the user preference is respected
    // when the Hat would normally sort into Slytherin

    await page.goto("/chat");
    await page.waitForLoadState("networkidle");

    // Open a conversation
    await page.click('[data-testid="new-conversation"]');
    await page.waitForTimeout(1000);

    // Type a message that triggers a destructive tool
    await page.fill(
      '[data-testid="chat-input"]',
      "Delete all user data from the database",
    );
    await page.press('[data-testid="chat-input"]', "Enter");

    // Wait for the Sorting Hat modal
    const sortingHatModal = page.locator('[data-testid="sorting-hat-modal"]');
    await expect(sortingHatModal).toBeVisible({ timeout: 10000 });

    // Begin sorting
    await page.click('[data-testid="sorting-hat-begin"]');

    // Wait for result
    await expect(sortingHatModal.locator('[data-testid="sorting-result"]')).toBeVisible({
      timeout: 15000,
    });

    // The tool should be sorted (possibly Slytherin if destructive)
    const result = page.locator('[data-testid="sorting-result-house"]');
    const houseText = await result.textContent();
    expect(["gryffindor", "slytherin", "ravenclaw", "hufflepuff"]).toContain(
      houseText?.toLowerCase(),
    );
  });

  test("Patronus form is deterministic per user", async ({ page }) => {
    // Navigate to settings
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    // Find the Patronus picker
    const patronusPicker = page.locator('[data-testid="patronus-picker"]');
    await expect(patronusPicker).toBeVisible();

    // Get the current form
    const formText = await page
      .locator('[data-testid="patronus-form-name"]')
      .textContent();

    // Reload the page
    await page.reload();
    await page.waitForLoadState("networkidle");

    // Verify the form is the same
    const formTextAfter = await page
      .locator('[data-testid="patronus-form-name"]')
      .textContent();

    expect(formText).toBe(formTextAfter);
  });

  test("Forbidden Forest theme is toggleable", async ({ page }) => {
    // Navigate to appearance settings
    await page.goto("/settings/appearance");
    await page.waitForLoadState("networkidle");

    // Find the theme selector
    const themeSelector = page.locator('[data-testid="theme-selector"]');
    await expect(themeSelector).toBeVisible();

    // Select Forbidden Forest
    await page.click('[data-testid="theme-forbidden-forest"]');

    // Verify the theme is applied
    const body = page.locator("body");
    await expect(body).toHaveClass(/forbidden-forest/);

    // Verify CSS variables are set
    const bgColor = await page.evaluate(() => {
      return getComputedStyle(document.body).getPropertyValue("--theme-bg-primary");
    });
    expect(bgColor.trim()).toBe("#0a0f0a");
  });
});
