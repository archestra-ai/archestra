import { goToPage } from "../fixtures";
import { expect, test } from "./api-fixtures";

/**
 * Settings → Roles carries one chip multiselect per gated catalog. What the
 * chips encode is what this covers: an unrestricted role shows every entry,
 * removing one writes an explicit list, and the list survives a reload.
 */
test.describe("per-role resource access", () => {
  test("chips narrow a role's catalogs and the selection survives a reload", async ({
    page,
    makeApiRequest,
    request,
  }) => {
    const created = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/roles",
      data: {
        name: `e2e_access_${Date.now()}`,
        permission: { agent: ["read"] },
      },
    });
    const roleId = (await created.json()).id;

    try {
      await goToPage(page, `/settings/roles?edit=${roleId}`);

      const dialog = page.getByRole("dialog");
      const providers = dialog.getByTestId("role-access-modelProviders");
      await providers.scrollIntoViewIfNeeded();

      // A role nobody has restricted shows the whole catalog.
      await expect(
        providers.getByText("OpenAI", { exact: true }),
      ).toBeVisible();
      await expect(
        providers.getByText("Anthropic", { exact: true }),
      ).toBeVisible();

      // Removing a chip writes an explicit list rather than leaving it open.
      await providers
        .locator("span")
        .filter({ hasText: /^Anthropic$/ })
        .first()
        .getByRole("button", { name: /remove selected option/i })
        .click();
      await expect(
        providers.getByText("Anthropic", { exact: true }),
      ).toHaveCount(0);

      await dialog.getByRole("button", { name: /save changes/i }).click();
      await expect(dialog).toBeHidden();

      await goToPage(page, `/settings/roles?edit=${roleId}`);
      const reopened = page
        .getByRole("dialog")
        .getByTestId("role-access-modelProviders");
      await reopened.scrollIntoViewIfNeeded();
      await expect(reopened.getByText("OpenAI", { exact: true })).toBeVisible();
      await expect(
        reopened.getByText("Anthropic", { exact: true }),
      ).toHaveCount(0);

      // Create, edit and view share one form. A restricted role viewed a
      // moment ago must not hand its lists to the next new role.
      await page
        .getByRole("dialog")
        .getByRole("button", { name: /cancel/i })
        .click();
      await page.getByRole("button", { name: /create custom role/i }).click();
      const fresh = page
        .getByRole("dialog")
        .getByTestId("role-access-modelProviders");
      await fresh.scrollIntoViewIfNeeded();
      await expect(fresh.getByText("Anthropic", { exact: true })).toBeVisible();
    } finally {
      await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/roles/${roleId}`,
        ignoreStatusCheck: true,
      });
    }
  });
});
