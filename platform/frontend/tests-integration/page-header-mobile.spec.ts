import type { Locator } from "@playwright/test";
import { expect, test } from "./fixtures";

// Exercise actual browser layout: jsdom cannot detect actions moving below
// the description or copy being squeezed into the title column.
for (const width of [320, 360, 640, 768, 1024, 1280]) {
  test.describe(`Page header at ${width}px`, () => {
    test.use({ viewport: { width, height: 800 } });

    for (const route of [
      "/skills",
      "/agents",
      "/mcp/registry",
      "/skills/new",
      "/skills/skill-jira-task",
    ]) {
      test(`${route} keeps actions beside the title`, async ({ page }) => {
        await page.goto(route);
        const heading = page.getByRole("heading", { level: 1 });
        await expect(heading).toBeVisible();
        const header = page.locator("[data-page-header]");
        const actions = header.locator("[data-page-actions]");
        await expect(actions).toBeVisible();

        await expectActionsBesideTitle({ heading, actions, width });

        if (width < 640) {
          const description = header.locator("[data-page-description]");
          if (await description.isVisible()) {
            const title = await heading.boundingBox();
            const copy = await description.boundingBox();
            if (!title || !copy) throw new Error("Missing header copy");
            expect(copy.y).toBeGreaterThanOrEqual(title.y + title.height);
            expect(copy.width).toBeGreaterThan(width - 60);
          }
        }
      });
    }

    test("/llm/logs keeps its time range beside the title", async ({
      page,
    }) => {
      await page.goto("/llm/logs");
      const heading = page.getByRole("heading", { level: 1, name: "Logs" });
      await expect(heading).toBeVisible();
      const header = page.locator("[data-page-header]");
      const actions = header.locator("[data-page-actions]");
      // The time range is the header's only action: no permissions here.
      await expect(
        actions.getByRole("button", { name: /Any time/ }),
      ).toBeVisible();
      await expect(
        actions.getByRole("button", { name: /Permissions/ }),
      ).toHaveCount(0);
      await expectActionsBesideTitle({ heading, actions, width });

      const title = await heading.boundingBox();
      const description = await header
        .locator("[data-page-description]")
        .boundingBox();
      if (!title || !description) throw new Error("Missing header copy");
      expect(description.y).toBeGreaterThanOrEqual(title.y + title.height);
      expect(description.x + description.width).toBeLessThanOrEqual(width);
      if (width < 640) {
        expect(description.width).toBeGreaterThan(width - 60);
      }
    });
  });
}

// Actions sit on the title row at every width, so they stay in one place from
// page to page however long the description is: centred on the title on wider
// screens, and starting within its first line where a phone title wraps.
async function expectActionsBesideTitle({
  heading,
  actions,
  width,
}: {
  heading: Locator;
  actions: Locator;
  width: number;
}) {
  await expect(actions).toBeVisible();
  await expect
    .poll(async () => {
      const title = await heading.boundingBox();
      const rect = await actions.boundingBox();
      if (!title || !rect) throw new Error("Missing title or actions");
      const verticallyAligned =
        width < 1024
          ? rect.y < title.y + title.height
          : Math.abs(rect.y + rect.height / 2 - (title.y + title.height / 2)) <
            5;
      return (
        verticallyAligned &&
        rect.x >= title.x + title.width &&
        rect.x + rect.width <= width
      );
    })
    .toBe(true);
}
