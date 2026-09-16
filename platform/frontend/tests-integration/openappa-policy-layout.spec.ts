import { expect, test } from "./fixtures";

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 640 },
]) {
  test.describe(`OpenAPPA at ${viewport.width}px`, () => {
    test.use({ viewport });

    test("shows the policy editor and keeps the GitHub form padded and its actions reachable", async ({
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
      await page.goto("/guardrails-v2");
      await expect(page).toHaveURL(/\/openappa$/);
      const editor = page.getByRole("heading", { name: "Policy editor" });
      await expect(editor).toBeInViewport();
      await expect(
        page.getByRole("button", { name: "Save & apply" }),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath("policy-editor.png"),
        fullPage: true,
      });
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
      await expect(dialog).toBeHidden();
      await editor.scrollIntoViewIfNeeded();
      await expect(editor).toBeInViewport();
    });
  });
}
