import { expect, test } from "./fixtures";

for (const width of [1440, 390]) {
  test(`limit guidance stays visible through cancelled create/edit flows at ${width}px`, async ({
    page,
    mswControl,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await mswControl.registerMany([
      { method: "get", url: "/api/default-user-limits", body: [] },
      {
        method: "get",
        url: "/api/limits",
        body: [
          {
            id: "preview-limit",
            entityType: "organization",
            entityId: "org-1",
            limitType: "token_cost",
            limitValue: 100,
            model: null,
            cleanupInterval: "calendar_month",
            lastCleanup: null,
            createdAt: "2026-01-01",
            updatedAt: "2026-01-01",
            labels: [],
            modelUsage: [],
          },
        ],
      },
    ]);
    await page.goto("/llm/limits");
    // Default user limits are managed on this page, above the limits table.
    const defaultLimit = page.getByRole("heading", {
      name: "Default user limit",
      exact: true,
    });
    await expect(defaultLimit).toBeVisible();

    for (let attempt = 0; attempt < 2; attempt++) {
      await page
        .getByRole("button", { name: "Add Limit", exact: true })
        .click();
      const dialog = page.getByRole("dialog", { name: "Create limit" });
      await expect(dialog.getByRole("alert")).toContainText(
        "Requests are blocked when any applicable limit is reached.",
      );
      await expect(
        dialog.getByLabel("Label key", { exact: true }),
      ).not.toBeVisible();
      await dialog
        .getByRole("button", { name: "Advanced", exact: true })
        .click();
      await dialog.getByLabel("Label key", { exact: true }).fill("stage");
      await dialog.getByLabel("Label value", { exact: true }).fill("preview");
      await dialog
        .getByRole("button", { name: "Advanced", exact: true })
        .click();
      await expect(
        dialog.getByLabel("Label key", { exact: true }),
      ).not.toBeVisible();
      await dialog
        .getByRole("button", { name: "Advanced", exact: true })
        .click();
      await expect(dialog.getByLabel("Label key", { exact: true })).toHaveValue(
        "stage",
      );
      const amount = dialog.getByLabel("Limit value", { exact: true });
      await expect(amount).not.toHaveAttribute("aria-describedby");
      await amount.fill("1.5");
      await expect(amount).toHaveAccessibleDescription(/Enter a whole number/);
      await expect(
        dialog.getByRole("button", { name: "Create limit", exact: true }),
      ).toBeDisabled();
      await amount.fill("250");
      await expect(amount).not.toHaveAttribute("aria-describedby");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await expect(defaultLimit).toBeVisible();
    }

    await page.goto("/llm/limits?edit=preview-limit");
    const edit = page.getByRole("dialog", { name: "Edit limit" });
    await expect(edit.getByRole("alert")).toContainText(
      "virtual key with remaining allowance is still blocked",
    );
    await expect(edit.getByLabel("Limit value", { exact: true })).toHaveValue(
      "100",
    );
    await expect(edit.getByLabel("Limit value", { exact: true })).toBeFocused();
    await expect(
      edit.getByRole("combobox", { name: "Limit scope", exact: true }),
    ).toBeDisabled();
    await expect(
      edit.getByRole("combobox", { name: "Limit kind", exact: true }),
    ).toBeDisabled();
    await edit
      .getByRole("button", { name: "Limit kind help", exact: true })
      .focus();
    await expect(
      page.getByRole("tooltip", {
        name: /Create a new limit to change between/,
      }),
    ).toContainText(
      "Create a new limit to change between spend, tokens and requests.",
    );
    await edit.getByLabel("Limit value", { exact: true }).focus();
    await expect(
      edit.getByLabel("Label key", { exact: true }),
    ).not.toBeVisible();
    await edit.getByRole("button", { name: "Advanced", exact: true }).click();
    await expect(edit.getByLabel("Label key", { exact: true })).toBeVisible();
    await edit.getByRole("button", { name: "Advanced", exact: true }).click();
    await edit.getByLabel("Limit value", { exact: true }).fill("500");
    await edit.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(edit).not.toBeVisible();
    await expect(defaultLimit).toBeVisible();
    await page.goto("/llm/limits?edit=preview-limit");
    await expect(
      page.getByRole("dialog").getByLabel("Limit value", { exact: true }),
    ).toHaveValue("100");
  });
}
