import { expect, test } from "./fixtures";

// Real browser layout: jsdom cannot see a title squeezed into a narrow
// column, a tab row that overflows, or a toolbar that wraps unevenly.
for (const width of [320, 375]) {
  test.describe(`OpenAPPA on a ${width}px phone`, () => {
    test.use({ viewport: { width, height: 800 } });

    test.beforeEach(async ({ mswControl }) => {
      await mswControl.registerMany([
        {
          method: "get",
          url: "/api/guardrails-policy",
          body: {
            organizationId: "org",
            revision: 3,
            content: "[policy]\nversion = 2\n",
            contentHash: "hash",
            updatedBy: null,
            updatedAt: null,
          },
        },
        {
          method: "get",
          url: "/api/openappa/policy-declarations",
          body: {
            batteries: [],
            unusedAliases: [],
            rootRevision: 3,
            lastError: null,
            composition: {
              served: {
                kind: "current",
                rootRevision: 3,
                composedAt: "2026-10-20T12:00:00Z",
              },
              refusal: null,
            },
            managedInGithub: false,
            heldPull: null,
          },
        },
        {
          method: "get",
          url: "/api/openappa/github-sync",
          body: { enabled: false, hasPolicy: false, source: null },
        },
        {
          method: "get",
          url: "/api/openappa/policy-tests",
          body: {
            source: "local",
            files: [],
            version: "v1",
            sourceCommit: null,
            directory: "tests",
            activeDirectory: "tests",
            error: null,
          },
        },
        {
          method: "get",
          url: "/api/openappa/coverage/entities",
          body: {
            data: [],
            pagination: {
              currentPage: 1,
              limit: 10,
              total: 0,
              totalPages: 0,
              hasNext: false,
              hasPrev: false,
            },
          },
        },
        {
          method: "get",
          url: "/api/openappa/coverage/summary",
          body: {
            totals: {
              tools: 0,
              root: 0,
              battery: 0,
              notEnforced: 0,
              catchAll: 0,
              builtInFallback: 0,
            },
            batteries: { active: [], broken: [], available: [] },
            composition: {
              kind: "current",
              servedRootRevision: 3,
              refusedRootRevision: null,
              rulesMayDiffer: false,
            },
          },
        },
      ]);
    });

    test("the Overview title keeps one line and its actions sit below the description", async ({
      page,
    }) => {
      await page.goto("/openappa");
      const heading = page.getByRole("heading", {
        level: 1,
        name: "Guardrails Beta",
      });
      await expect(heading).toBeVisible();
      const lines = await heading.evaluate(
        (element) =>
          element.getBoundingClientRect().height /
          Number.parseFloat(getComputedStyle(element).lineHeight),
      );
      expect(Math.round(lines)).toBe(1);

      const header = page.locator("[data-page-header]");
      const description = await header
        .locator("[data-page-description]")
        .boundingBox();
      const actions = await header.locator("[data-page-actions]").boundingBox();
      if (!description || !actions) throw new Error("Missing header parts");
      expect(actions.y).toBeGreaterThanOrEqual(
        description.y + description.height,
      );
    });

    test("a selected overflow tab fits the tab row instead of scrolling it", async ({
      page,
    }) => {
      await page.goto("/openappa/validation");
      const trigger = page.getByRole("button", {
        name: "Validations",
        exact: true,
      });
      await expect(trigger).toBeVisible();
      const row = await trigger.locator("..").evaluate((element) => ({
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      }));
      expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);

      // At common phone widths the label fits whole; narrower rows truncate it.
      if (width >= 375) {
        const truncated = await trigger
          .getByText("Validations", { exact: true })
          .evaluate((element) => element.scrollWidth > element.clientWidth);
        expect(truncated).toBe(false);
      }
    });

    test("the Policy source picker takes its own full-width row", async ({
      page,
    }) => {
      await page.goto("/openappa/policy");
      const viewToggle = page.getByRole("tablist", { name: "Policy view" });
      const picker = page.getByRole("combobox", {
        name: "Policy source file",
      });
      const revision = page.getByText("Revision 3", { exact: true });
      await expect(revision).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Policy guide" }),
      ).toBeVisible();

      const toggle = await viewToggle.boundingBox();
      const select = await picker.boundingBox();
      const revisionBox = await revision.boundingBox();
      if (!toggle || !select || !revisionBox)
        throw new Error("Missing toolbar parts");
      // The guide link and revision share the toggle's row...
      expect(revisionBox.y).toBeLessThan(toggle.y + toggle.height);
      // ...and the picker spans the card below them.
      expect(select.y).toBeGreaterThanOrEqual(toggle.y + toggle.height);
      expect(select.width).toBeGreaterThan(width - 100);
      expect(select.x + select.width).toBeLessThanOrEqual(width);
    });
  });
}
