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
            repositoryFiles: [],
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
          body: {
            selfService: {
              enabled: false,
              setting: false,
              directory: "mcp",
              autoMerge: { enabled: false, setting: false },
            },
            enabled: false,
            hasPolicy: false,
            source: null,
          },
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

      // The page's own Settings link; the Yells card links to one block of it.
      const settings = page.getByRole("link", {
        name: "Settings",
        exact: true,
      });
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

    test("the Policy file button takes its own full-width row", async ({
      page,
    }) => {
      await page.goto("/openappa/policy");
      const viewToggle = page.getByRole("tablist", { name: "Policy view" });
      const picker = page.getByRole("button", {
        name: "Open a policy file",
      });
      const guide = page.getByRole("link", { name: "Policy guide" });
      await expect(guide).toBeVisible();

      const toggle = await viewToggle.boundingBox();
      const select = await picker.boundingBox();
      const guideBox = await guide.boundingBox();
      if (!toggle || !select || !guideBox)
        throw new Error("Missing toolbar parts");
      // The guide link shares the toggle's row...
      expect(guideBox.y).toBeLessThan(toggle.y + toggle.height);
      // ...and the file button spans the card below them.
      expect(select.y).toBeGreaterThanOrEqual(toggle.y + toggle.height);
      expect(select.width).toBeGreaterThan(width - 100);
      expect(select.x + select.width).toBeLessThanOrEqual(width);
    });

    test("the file tree opens over the editor, inside its frame, and a picked file closes it", async ({
      page,
      mswControl,
    }) => {
      await mswControl.registerMany([
        {
          method: "get",
          url: "/api/openappa/policy-tests",
          body: {
            source: "local",
            files: [
              {
                path: "mail/send-external.appa",
                content: "# Mail stays inside\n",
              },
            ],
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
          body: { files: [{ path: "mail/send-external.appa", error: null }] },
        },
      ]);
      await page.goto("/openappa/policy?validations=1");
      // The column beside the editor has no room on a phone.
      const tree = page.getByRole("navigation", { name: "Policy files" });
      await expect(tree).toBeHidden();

      await page.getByRole("button", { name: "Files" }).click();
      const file = tree.getByRole("button", { name: /send-external\.appa/ });
      await expect(file).toBeVisible();
      // The files lie over the editor, inside its frame, not over the page.
      const editor = await page
        .getByRole("tabpanel", { name: "Source" })
        .boundingBox();
      const box = await tree.boundingBox();
      if (!box || !editor) throw new Error("Missing files panel");
      expect(box.x).toBeGreaterThanOrEqual(editor.x);
      expect(box.y).toBeGreaterThanOrEqual(editor.y);
      expect(box.x + box.width).toBeLessThan(editor.x + editor.width);
      expect(box.y + box.height).toBeLessThanOrEqual(
        editor.y + editor.height + 1,
      );

      await file.click();
      await expect(tree).toBeHidden();
      await expect(page).toHaveURL(
        /entry=validation%3Amail%2Fsend-external\.appa/,
      );
      await expect(
        page.getByRole("textbox", {
          name: "Policy validation mail/send-external.appa",
        }),
      ).toBeAttached();
    });

    test("the run output takes the problems panel, instead of splitting it", async ({
      page,
      mswControl,
    }) => {
      const path = "mail/send-external.appa";
      await mswControl.registerMany([
        {
          method: "get",
          url: "/api/openappa/policy-tests",
          body: {
            source: "local",
            files: [{ path, content: "# Mail stays inside\n" }],
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
          body: { files: [{ path, error: null }] },
        },
        {
          method: "get",
          url: "/api/openappa/policy-tests/runs",
          body: [
            {
              id: "run-1",
              createdBy: "Pat Morgan",
              createdAt: "2026-01-02T10:00:00.000Z",
              trigger: "manual",
              source: "local",
              sourceVersion: "v1",
              sourceCommit: null,
              definitionHash: "definition",
              policyRevision: 3,
              policyHash: "policy",
              effectivePolicyHash: "effective",
              engineVersion: "1.0.0",
              draft: false,
              validation: { valid: true, errors: [], warnings: [] },
              files: [
                {
                  path,
                  contentHash: "a",
                  assertionCount: 1,
                  status: "failed",
                  durationMs: 40,
                  steps: [
                    {
                      line: 3,
                      tool: "mcp/gmail/send_email",
                      expected: "deny",
                      actual: "allow",
                      status: "failed",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ]);
      await page.goto("/openappa/policy?validations=1");
      const panel = page.getByRole("region", { name: "Validation problems" });
      const problem = panel.getByRole("button", {
        name: /expected deny, got allow/,
      });
      await expect(problem).toBeVisible();

      await panel.getByRole("button", { name: "Show output" }).click();
      const output = panel.getByText(/line 3: mcp\/gmail\/send_email/);
      await expect(output).toBeVisible();
      await expect(problem).toBeHidden();
      const log = await panel.locator("pre").boundingBox();
      const frame = await panel.boundingBox();
      if (!log || !frame) throw new Error("Missing output");
      expect(log.width).toBeGreaterThan(frame.width - 4);

      await panel.getByRole("button", { name: "Hide output" }).click();
      await expect(problem).toBeVisible();
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
