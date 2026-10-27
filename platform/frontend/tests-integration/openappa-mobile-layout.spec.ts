import { makeAgent } from "../src/mocks/data/agents";
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
          method: "post",
          url: "/api/openappa/policy-tests/inspect",
          body: { files: [] },
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
        { method: "get", url: "/api/agents/chat-roster", body: [APPA_KEEPER] },
        {
          method: "get",
          url: `/api/agents/${APPA_KEEPER.id}`,
          body: APPA_KEEPER,
        },
        {
          method: "get",
          url: "/api/members/default-model",
          body: { modelId: null, chatApiKeyId: null },
        },
      ]);
    });

    test("the Overview header keeps its title on one line with Settings beside it", async ({
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

      const settings = page.getByRole("link", { name: "Settings" });
      const title = await heading.boundingBox();
      const button = await settings.boundingBox();
      if (!title || !button) throw new Error("Missing header parts");
      expect(button.y).toBeLessThan(title.y + title.height);
      expect(button.x).toBeGreaterThanOrEqual(title.x + title.width);
      expect(button.x + button.width).toBeLessThanOrEqual(width);
      // Phones leave the enforcement state to Settings.
      await expect(page.getByText(/^Enforcement (on|off)$/)).toBeHidden();
    });

    test("the Overview folds the chat prompts into an Ask menu and keeps its spacing even", async ({
      page,
    }) => {
      await page.goto("/openappa");
      const chat = page.getByRole("link", { name: "Chat with APPA Keeper" });
      await expect(chat).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Explain my policy" }),
      ).toBeHidden();
      await page.getByRole("button", { name: "Ask" }).click();
      const items = page.getByRole("menuitem");
      await expect(items).toHaveText([
        "Explain OpenAPPA guardrails",
        "Explain my policy",
        "Review risky calls",
        "Help me make a change",
        "Validate my policy",
      ]);
      await expect(items.first()).toHaveAttribute("href", /\/chat/);
      await page.keyboard.press("Escape");

      // The strip sits as far from the section below it as from the header.
      const header = await page.locator("[data-page-header]").boundingBox();
      const strip = await chat
        .locator("xpath=ancestor::*[@data-slot='card'][1]")
        .boundingBox();
      const section = page.getByRole("heading", {
        level: 2,
        name: "How your policy decides",
      });
      const sectionBox = await section.boundingBox();
      const viewPolicy = await page
        .getByRole("link", { name: "View policy" })
        .boundingBox();
      if (!header || !strip || !sectionBox || !viewPolicy)
        throw new Error("Missing overview parts");
      expect(sectionBox.y - (strip.y + strip.height)).toBeCloseTo(
        strip.y - (header.y + header.height),
        0,
      );
      // "View policy" rides the section heading's row.
      expect(viewPolicy.y).toBeLessThan(sectionBox.y + sectionBox.height);
      expect(viewPolicy.x).toBeGreaterThan(sectionBox.x + sectionBox.width);
    });

    test("a selected overflow tab fits the tab row instead of scrolling it", async ({
      page,
    }) => {
      // Wait for the debounced inspection so teardown checks its MSW coverage.
      const inspection = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().endsWith("/api/openappa/policy-tests/inspect"),
      );
      await page.goto("/openappa/validation");
      await inspection;
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

const APPA_KEEPER = makeAgent({
  id: "openappa-configuration-agent",
  scope: "org",
  builtIn: true,
  builtInAgentConfig: { name: "openappa-configuration-agent" },
  authorId: null,
});
