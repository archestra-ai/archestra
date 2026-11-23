import { expect, test } from "./fixtures";

// The unified Logs page reads one feed (`GET /api/logs/events`, served in mock
// mode by src/mocks/log-events.ts) and links each row to its own type's
// detail page.

test.describe("Logs", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("a type tile narrows the list, and a second click shows every type", async ({
    page,
  }) => {
    await page.goto("/logs");
    await expect(page.locator('a[href^="/mcp/logs/"]').first()).toBeVisible();
    await expect(page.locator('a[href^="/llm/logs/"]').first()).toBeVisible();

    const mcp = page.getByRole("button", { name: "Show MCP Gateway logs" });
    await mcp.click();
    await expect(page).toHaveURL(/[?&]type=mcp\b/);
    await expect(page.locator('a[href^="/mcp/logs/"]').first()).toBeVisible();
    await expect(page.locator('a[href^="/llm/logs/"]')).toHaveCount(0);

    await page.getByRole("button", { name: "Show every type" }).click();
    await expect(page).not.toHaveURL(/type=/);
    await expect(page.locator('a[href^="/llm/logs/"]').first()).toBeVisible();
  });

  test("the Problems switch keeps only problem events", async ({ page }) => {
    await page.goto("/logs?type=mcp");
    const show = page.getByRole("group", { name: "Show" });
    await show.getByRole("button", { name: /^Problems/ }).click();
    await expect(page).toHaveURL(/status=problems/);
    await show.getByRole("button", { name: "All", exact: true }).click();
    await expect(page).not.toHaveURL(/status=problems/);
  });

  test("a row opens its event, and Back to Logs returns to the same view", async ({
    page,
  }) => {
    await page.goto("/logs?type=mcp");
    const row = page.locator('a[href^="/mcp/logs/"]').first();
    const href = await row.getAttribute("href");
    await row.click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));

    await page.getByRole("link", { name: "Back to Logs" }).click();
    await expect(page).toHaveURL(/\/logs\?type=mcp$/);
  });
});

test.describe("Logs on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("shows every type as a row with its full name", async ({ page }) => {
    await page.goto("/logs");
    for (const name of [
      "LLM Proxy",
      "MCP Gateway",
      "Guardrails",
      "Client connections",
      "Audit",
    ]) {
      await expect(
        page.getByRole("button", { name: `Show ${name} logs` }),
      ).toBeVisible();
    }
    const width = await page.evaluate(
      () => document.documentElement.scrollWidth,
    );
    expect(width).toBeLessThanOrEqual(390);
  });
});
