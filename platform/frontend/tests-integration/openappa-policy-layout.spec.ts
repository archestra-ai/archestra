import { makeLlmProviderApiKey } from "../src/mocks/data/llm-keys";
import { expect, test } from "./fixtures";

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 640 },
]) {
  test.describe(`OpenAPPA at ${viewport.width}px`, () => {
    test.use({ viewport });

    test("shows the read-only policy and keeps the GitHub form padded and its actions reachable", async ({
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
          organization: ["read", "update"],
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
      await mswControl.registerMany([
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
      const policySource = page.getByRole("heading", { name: "Policy source" });
      await expect(policySource).toBeInViewport();
      await expect(page.getByText("Read only", { exact: true })).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Save & apply" }),
      ).toHaveCount(0);
      const effective = page.getByRole("heading", { name: "Effective policy" });
      await expect(effective).toBeHidden();
      await page.getByRole("tab", { name: "Effective policy" }).click();
      await expect(effective).toBeVisible();
      await expect(policySource).toBeHidden();
      await page.getByRole("tab", { name: "Policy", exact: true }).click();
      await expect(policySource).toBeVisible();
      await expect(effective).toBeHidden();
      await page.screenshot({
        path: testInfo.outputPath("policy-source.png"),
        fullPage: true,
      });
      await page.goto("/openappa");
      await page.getByRole("button", { name: "Connect GitHub" }).click();
      const dialog = page.getByRole("dialog", {
        name: "Connect APPA to GitHub",
      });
      await expect(dialog).toBeVisible();
      await dialog
        .getByLabel("Repository", { exact: true })
        .fill("example/policies");
      const bounds = await dialog.boundingBox();
      const input = await dialog
        .getByLabel("Repository", { exact: true })
        .boundingBox();
      if (!bounds || !input)
        throw new Error("Dialog and repository must be rendered");
      // Catch the reported edge-to-edge form and oversized modal in actual layout.
      expect(bounds.x).toBeGreaterThanOrEqual(12);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width - 12);
      expect(bounds.width).toBeLessThanOrEqual(600);
      expect(input.x - bounds.x).toBeGreaterThanOrEqual(12);
      expect(
        bounds.x + bounds.width - input.x - input.width,
      ).toBeGreaterThanOrEqual(12);
      await dialog.getByLabel("Sync frequency").scrollIntoViewIfNeeded();
      await expect(
        dialog.getByRole("button", { name: "Save source and sync" }),
      ).toBeInViewport();
      await expect(
        dialog.getByRole("button", { name: "Cancel", exact: true }),
      ).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath("github-dialog.png") });
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      // The repository field holds an unsaved value, so Cancel asks first.
      await page.getByRole("button", { name: "Discard changes" }).click();
      await expect(dialog).toBeHidden();
      await page.goto("/openappa/policy");
      await expect(
        page.getByRole("link", { name: "Configure with chat" }),
      ).toHaveAttribute(
        "href",
        "/chat?openappa=1&openappaPrompt=explainPolicy&from=openappa",
      );
      // Open a blank policy draft to check its composer without auto-sending.
      await page.goto("/chat?openappa=1&from=openappa");
      const policyPrompt = page.getByPlaceholder(
        "Ask about or change your policy…",
      );
      await policyPrompt.scrollIntoViewIfNeeded();
      await expect(policyPrompt).toBeInViewport();
      await policyPrompt.fill("Review the current policy");
      await expect(policyPrompt).toHaveValue("Review the current policy");
      await page.screenshot({
        path: testInfo.outputPath("policy-chat.png"),
        fullPage: true,
      });
      await page.goBack();
      await expect(page).toHaveURL(/\/openappa\/policy$/);
      await expect(policySource).toBeInViewport();
    });
  });
}
