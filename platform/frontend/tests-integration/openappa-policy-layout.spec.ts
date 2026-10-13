import { makeAgent } from "../src/mocks/data/agents";
import { makeLlmProviderApiKey } from "../src/mocks/data/llm-keys";
import { expect, test } from "./fixtures";

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 640 },
]) {
  test.describe(`OpenAPPA at ${viewport.width}px`, () => {
    test.use({ viewport });

    test("shows the read-only policy and keeps the GitHub setup dialog padded and its actions reachable", async ({
      page,
      mswControl,
      request,
    }, testInfo) => {
      const config = await (
        await request.get("/internal-test/api/api/config")
      ).json();
      await mswControl.use({
        method: "get",
        url: "/api/config",
        body: {
          ...config,
          features: { ...config.features, openappaEnabled: true },
        },
      });
      await mswControl.use({
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
      });
      await mswControl.use({
        method: "get",
        url: "/api/guardrails-policy",
        body: {
          organizationId: "org",
          revision: 1,
          content:
            '[policy]\nversion = 2\n[[policy.tool]]\nname = "read"\ndelta = {}\n',
          contentHash: "hash",
          updatedBy: null,
          updatedAt: null,
        },
      });
      await mswControl.use({
        method: "get",
        url: "/api/openappa/github-sync",
        body: { enabled: true, hasPolicy: false, source: null },
      });
      await mswControl.use({
        method: "get",
        url: "/api/credentials",
        body: [],
      });
      await mswControl.use({
        method: "get",
        url: "/api/llm-provider-api-keys",
        body: [makeLlmProviderApiKey({ provider: "openai" })],
      });
      await mswControl.use({
        method: "get",
        url: "/api/llm-provider-api-keys/available",
        body: [makeLlmProviderApiKey({ provider: "openai" })],
      });
      await mswControl.use({
        method: "get",
        url: "/api/llm-models/available",
        body: [],
      });
      await mswControl.use({
        method: "get",
        url: "/api/openappa/batteries",
        body: [],
      });
      await mswControl.use({
        method: "get",
        url: "/api/openappa/policy-declarations",
        body: {
          batteries: [],
          unusedAliases: [],
          rootRevision: 1,
          lastError: null,
          managedInGithub: false,
          heldPull: null,
        },
      });
      const permissions = await (
        await request.get("/internal-test/api/api/user/permissions")
      ).json();
      await mswControl.use({
        method: "get",
        url: "/api/user/permissions",
        body: {
          ...permissions,
          organizationSettings: ["read", "update"],
          openappaPolicy: ["read", "update"],
          credential: ["read"],
        },
      });
      await mswControl.use({
        method: "get",
        url: "/api/guardrails-deployment",
        body: { enabled: false, featureEnabled: true, active: false },
      });
      await mswControl.use({
        method: "get",
        url: "/api/openappa/effective-policy",
        body: {
          organizationId: "org",
          content: "[policy]\nversion = 2\n",
          contentHash: "composed",
          rootRevision: 1,
          installFingerprint: "none",
          compiledAt: "2026-09-22T12:00:00Z",
          lastError: null,
          lastErrorAt: null,
        },
      });
      const configurationAgent = makeAgent({
        id: "openappa-configuration-agent",
        scope: "org",
        builtIn: true,
        builtInAgentConfig: { name: "openappa-configuration-agent" },
        authorId: null,
      });
      await mswControl.registerMany([
        {
          method: "get",
          url: "/api/agents/all",
          body: [configurationAgent],
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
          },
        },
        {
          method: "get",
          url: "/api/members/default-model",
          body: { modelId: null, chatApiKeyId: null },
        },
      ]);
      await page.goto("/openappa/policy");
      const policySource = page.getByText("Revision 1", { exact: true });
      await expect(policySource).toBeInViewport();
      await expect(
        page.getByRole("button", { name: "Save & apply" }),
      ).toHaveCount(0);
      const effective = page.getByText(
        "What the runtime enforces, batteries included.",
      );
      await expect(effective).toBeHidden();
      await page.getByRole("tab", { name: "Effective", exact: true }).click();
      await expect(effective).toBeVisible();
      await expect(policySource).toBeHidden();
      await page.getByRole("tab", { name: "Source", exact: true }).click();
      await expect(policySource).toBeVisible();
      await expect(effective).toBeHidden();
      await page.screenshot({
        path: testInfo.outputPath("policy-source.png"),
        fullPage: true,
      });
      // Git sync and enforcement live in Settings → Guardrails.
      await page.goto("/settings/guardrails");
      await expect(
        page.getByRole("switch", { name: "Enforce the policy" }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Create GitHub repository" })
        .click();
      const dialog = page.getByRole("dialog", { name: "Set up GitHub sync" });
      await expect(dialog).toBeVisible();
      // Measure the settled dialog, not a frame of its zoom-in animation.
      await dialog.evaluate((element) =>
        Promise.all(element.getAnimations().map((a) => a.finished)),
      );
      const choice = dialog.getByRole("button", {
        name: /Use an existing repository/,
      });
      const bounds = await dialog.boundingBox();
      const card = await choice.boundingBox();
      if (!bounds || !card)
        throw new Error("Dialog and its choices must be rendered");
      // Dialogs fill a phone's width and cap at 672px (max-w-2xl) elsewhere;
      // either way the modal stays on screen and its content keeps a gutter.
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
      expect(bounds.width).toBeLessThanOrEqual(672);
      expect(card.x - bounds.x).toBeGreaterThanOrEqual(12);
      expect(
        bounds.x + bounds.width - card.x - card.width,
      ).toBeGreaterThanOrEqual(12);
      await expect(
        dialog.getByRole("button", { name: "Cancel", exact: true }),
      ).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath("github-dialog.png") });
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog).toBeHidden();
      await page.goto("/openappa/policy");
      await expect(
        page.getByRole("heading", { name: "Policy Alpha" }),
      ).toBeVisible();
      await expect(policySource).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Configure with chat" }),
      ).toHaveCount(0);
    });
  });
}
