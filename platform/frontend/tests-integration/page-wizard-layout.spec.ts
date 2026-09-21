import { E2eTestId } from "@archestra/shared/e2e-test-ids";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// Check rendered geometry: the header previously hid every step below `sm`,
// and simply unhiding the desktop labels clips the last step on a phone.
async function expectStepsToFit(page: Page, count: number) {
  const steps = page
    .locator("[data-page-header]")
    .getByRole("button", { name: /^Step \d+ of \d+:/ });
  await expect(steps).toHaveCount(count);
  for (const step of await steps.all()) {
    await expect(step).toBeVisible();
    const bounds = await step.boundingBox();
    expect(bounds).not.toBeNull();
    if (!bounds) throw new Error("Wizard step has no rendered bounds");
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(
      page.viewportSize()?.width ?? 0,
    );
  }
}

for (const width of [320, 375, 1440]) {
  test.describe(`Page wizard at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("agent steps stay visible and allow returning to the draft", async ({
      page,
    }) => {
      await page.goto("/agents/new");
      await page.getByRole("button", { name: /Start from scratch/ }).click();
      await expectStepsToFit(page, 4);

      await page.getByRole("textbox", { name: "Name" }).fill("Mobile draft");
      await page.getByTestId(E2eTestId.AgentSetupNextButton).click();
      await expect(
        page.getByRole("button", {
          name: "Step 2 of 4: Tools, Skills & Knowledge, current",
        }),
      ).toHaveAttribute("aria-current", "step");
      await expectStepsToFit(page, 4);
      if (width < 640) {
        await expect(
          page.getByText("Step 2 of 4: Tools, Skills & Knowledge", {
            exact: true,
          }),
        ).toBeVisible();
      }

      await page
        .getByRole("button", { name: "Step 1 of 4: Configuration, complete" })
        .click();
      await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue(
        "Mobile draft",
      );
    });
  });
}

test.describe("MCP page wizard on a phone", () => {
  test.use({ viewport: { width: 320, height: 900 } });

  test("keeps all setup steps visible after choosing a source", async ({
    page,
  }) => {
    await page.goto("/mcp/registry/new");
    await page.getByRole("button", { name: /Start from scratch/ }).click();
    await expectStepsToFit(page, 3);
    await expect(
      page.getByText("Step 1 of 3: Configuration", { exact: true }),
    ).toBeVisible();
  });
});
