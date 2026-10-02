// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise

import type { Locator, Page } from "@playwright/test";
import type { ResourcePermissions } from "@/lib/resource-permissions.query";
import { expect, test } from "./fixtures";

const actions: ResourcePermissions["effectiveActions"] = [
  "read",
  "use",
  "update",
  "delete",
  "manage-permissions",
];
const policy: ResourcePermissions = {
  resource: "mcpRegistry",
  scope: "*",
  name: "All MCP registry entries",
  revision: 1,
  grants: [
    { subject: { type: "role", id: "admin" }, name: "Admin", actions },
    {
      subject: { type: "team", id: "platform-maintainers" },
      name: "Platform maintainers",
      actions,
    },
  ],
  inheritedGrants: [],
  effectiveActions: actions,
  previewActorSubjects: [{ type: "role", id: "admin" }],
};
const title = "Permissions for all MCP registry entries";

async function expectInsideViewport(page: Page, element: Locator) {
  await expect(element).toBeVisible();
  await expect
    .poll(async () => {
      const box = await element.boundingBox();
      const viewport = page.viewportSize();
      return (
        !!box &&
        !!viewport &&
        box.x >= 0 &&
        box.y >= 0 &&
        box.x + box.width <= viewport.width + 1 &&
        box.y + box.height <= viewport.height + 1
      );
    })
    .toBe(true);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("theme", "dark"));
});

for (const viewport of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 667, height: 375 },
]) {
  test(`read-only permissions stay usable at ${viewport.width}×${viewport.height}`, async ({
    page,
    mswControl,
  }) => {
    await page.setViewportSize(viewport);
    await mswControl.use({
      method: "get",
      url: "/api/resource-permissions/mcpRegistry/:scope",
      body: { ...policy, effectiveActions: ["read"] },
    });
    await mswControl.use({
      method: "get",
      url: "/api/user/permissions",
      body: { mcpRegistry: ["read"], globalPermissions: ["read"] },
    });
    await page.goto("/mcp/registry?permissions=all");
    const dialog = page.getByRole("dialog", { name: title, exact: true });
    await expect(
      dialog.getByText("Platform maintainers", { exact: true }),
    ).toBeVisible();
    await expectInsideViewport(page, dialog);
    await expectInsideViewport(
      page,
      dialog.getByRole("button", { name: "Done", exact: true }),
    );
    await expect(
      dialog.getByRole("combobox", { name: "Permission for Admin" }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Add access" }),
    ).toHaveCount(0);
    const description = dialog.locator('[data-slot="dialog-description"]');
    const descriptionBox = await description.boundingBox();
    const dialogBox = await dialog.boundingBox();
    expect(descriptionBox?.width).toBeGreaterThan((dialogBox?.width ?? 0) - 64);
    expect(
      await description.evaluate(
        (element) => getComputedStyle(element).textAlign,
      ),
    ).toBe("left");
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
  });
}

test("phone controls stay reachable through the permission handoff confirmation", async ({
  page,
  mswControl,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await mswControl.use({
    method: "get",
    url: "/api/resource-permissions/mcpRegistry/:scope",
    body: policy,
  });
  await page.goto("/mcp/registry?permissions=all");
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  const permission = dialog.getByRole("combobox", {
    name: "Permission for Platform maintainers",
  });
  await expect(permission).toBeVisible();
  const nameBox = await dialog
    .getByText("Platform maintainers", { exact: true })
    .boundingBox();
  const controlBox = await permission.boundingBox();
  expect(controlBox?.y).toBeGreaterThanOrEqual(
    (nameBox?.y ?? 0) + (nameBox?.height ?? 0),
  );
  await expect
    .poll(async () => (await permission.boundingBox())?.height ?? 0)
    .toBeGreaterThanOrEqual(43.99);
  await dialog.getByRole("combobox", { name: "Permission for Admin" }).click();
  await page
    .getByRole("option", { name: "Can view View without making changes" })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "You won’t be able to change permissions.",
  );
  const save = dialog.getByRole("button", { name: "Save permissions" });
  await expectInsideViewport(page, save);
  await save.click();
  const confirm = page.getByRole("dialog", {
    name: "Give up the ability to change permissions?",
    exact: true,
  });
  await expectInsideViewport(page, confirm);
  await expectInsideViewport(
    page,
    confirm.getByRole("button", { name: "Save changes anyway" }),
  );
  await confirm.getByRole("button", { name: "Keep editing" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "You won’t be able to change permissions.",
  );
});

test("long permission lists scroll without losing the phone footer", async ({
  page,
  mswControl,
}) => {
  await page.setViewportSize({ width: 390, height: 568 });
  await mswControl.use({
    method: "get",
    url: "/api/resource-permissions/mcpRegistry/:scope",
    body: {
      ...policy,
      grants: [
        ...policy.grants,
        ...Array.from({ length: 15 }, (_, index) => ({
          subject: { type: "team", id: `team-${index}` },
          name: `A long team name for resource access ${index}`,
          actions,
        })),
      ],
    },
  });
  await page.goto("/mcp/registry?permissions=all");
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  const last = dialog.getByRole("combobox", {
    name: "Permission for A long team name for resource access 14",
  });
  await last.scrollIntoViewIfNeeded();
  await expectInsideViewport(page, last);
  await expectInsideViewport(
    page,
    dialog.getByRole("heading", { name: title }),
  );
  await expectInsideViewport(
    page,
    dialog.getByRole("button", { name: "Done", exact: true }),
  );
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
});

test("a phone draft cannot remove the last permission manager", async ({
  page,
  mswControl,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mswControl.use({
    method: "get",
    url: "/api/resource-permissions/mcpRegistry/:scope",
    body: { ...policy, grants: [policy.grants[0]] },
  });
  await page.goto("/mcp/registry?permissions=all");
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  await dialog
    .getByRole("button", { name: "Remove direct access for Admin" })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Someone must be able to change permissions.",
  );
  const save = dialog.getByRole("button", { name: "Save permissions" });
  await expect(save).toBeDisabled();
  await expectInsideViewport(page, save);
  await dialog.getByRole("button", { name: "Discard changes" }).click();
  await expect(
    dialog.getByRole("combobox", { name: "Permission for Admin" }),
  ).toBeEnabled();
});

test("Add access stays in the desktop header and moves into the phone body", async ({
  page,
  mswControl,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mswControl.registerMany([
    {
      method: "get",
      url: "/api/resource-permissions/mcpRegistry/:scope",
      body: policy,
    },
    {
      method: "get",
      url: "/api/resource-permissions/mcpRegistry/:scope/subjects",
      body: [],
    },
  ]);
  await page.goto("/mcp/registry?permissions=all");
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  const add = dialog.getByRole("button", { name: "Add access", exact: true });
  const body = dialog.locator('[data-slot="dialog-body"]');
  await expect(add).toBeVisible();
  await expect(add).toHaveCount(1);
  await expect(
    body.getByRole("button", { name: "Add access", exact: true }),
  ).toHaveCount(0);
  const header = dialog.locator('[data-slot="dialog-header"]');
  const addBox = await add.boundingBox();
  const headerBox = await header.boundingBox();
  expect((addBox?.y ?? 0) + (addBox?.height ?? 0)).toBeLessThanOrEqual(
    (headerBox?.y ?? 0) + (headerBox?.height ?? 0),
  );
  await page.screenshot({ path: test.info().outputPath("desktop-header.png") });

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileAdd = body.getByRole("button", {
    name: "Add access",
    exact: true,
  });
  await expect(mobileAdd).toBeVisible();
  await expect(add).toHaveCount(1);
  await expectInsideViewport(page, mobileAdd);
  await expect
    .poll(async () => (await mobileAdd.boundingBox())?.height ?? 0)
    .toBeGreaterThanOrEqual(43.99);
  await page.screenshot({ path: test.info().outputPath("mobile-body.png") });
  await mobileAdd.click();
  const picker = page.getByRole("dialog", { name: "Add access", exact: true });
  await expect(picker).toBeVisible();
  await picker.getByRole("button", { name: "Back", exact: true }).click();
  await expect(mobileAdd).toBeFocused();

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(add).toBeVisible();
  await expect(
    body.getByRole("button", { name: "Add access", exact: true }),
  ).toHaveCount(0);
  await add.click();
  await expect(picker).toBeVisible();
  await picker.getByRole("button", { name: "Back", exact: true }).click();
  await expect(add).toBeFocused();
});
