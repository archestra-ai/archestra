// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { archestraApiTypes } from "@archestra/shared";
import { adminPermissions } from "@archestra/shared/access-control";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const customRole: archestraApiTypes.GetRoleResponses["200"] = {
  id: "preview-agent-editor",
  organizationId: "test-org",
  role: "agent_editor",
  name: "Agent editor",
  description: "Create and maintain agents",
  permission: { agent: ["read", "create", "delete"] },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: null,
  predefined: false,
};
const adminRole = {
  ...customRole,
  id: "admin",
  role: "admin",
  name: "Admin",
  description: "Full access to all resources and platform settings",
  permission: adminPermissions,
  predefined: true,
};

test.beforeEach(async ({ mswControl, page, request }) => {
  await page.addInitScript(() => localStorage.setItem("theme", "light"));
  const config = await (
    await request.get("/internal-test/api/api/config")
  ).json();
  await mswControl.registerMany([
    { method: "get", url: "/api/user/impersonable", body: [] },
    { method: "get", url: "/api/site-notification", body: null },
    {
      method: "get",
      url: "/api/config",
      body: {
        ...config,
        enterpriseFeatures: { ...config.enterpriseFeatures, core: true },
      },
    },
    { method: "get", url: "/api/user/permissions", body: adminPermissions },
    {
      method: "get",
      url: "/api/roles",
      body: {
        data: [adminRole, customRole],
        pagination: {
          currentPage: 1,
          limit: 10,
          total: 2,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
      },
    },
    { method: "get", url: "/api/roles/admin", body: adminRole },
    { method: "get", url: `/api/roles/${customRole.id}`, body: customRole },
    {
      method: "get",
      url: "/api/user/permission-sources",
      body: [
        { role: "admin", team: null, permissions: adminPermissions },
        {
          role: "agent_editor",
          team: { id: "test-team", name: "Platform" },
          permissions: customRole.permission,
        },
      ],
    },
  ]);
  const directory = process.env.ARCHESTRA_PERMISSION_REVIEW_ARTIFACT_DIR;
  if (directory) {
    const registry = await (
      await request.get("/internal-test/msw-handlers")
    ).json();
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "preview-fixtures.json"),
      JSON.stringify(registry.overrides),
    );
  }
});

test("editing across categories saves the complete role", async ({
  page,
  mswControl,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/settings/roles?edit=${customRole.id}`);
  const dialog = page.getByRole("dialog", { name: "Edit role", exact: true });
  await expect(
    dialog.getByRole("checkbox", { name: "Agents Read", exact: true }),
  ).toBeChecked();
  await capture(page, "role-edit-desktop");

  await dialog.getByRole("button", { name: "Other", exact: true }).click();
  await dialog
    .getByRole("checkbox", { name: "Knowledge Sources Read", exact: true })
    .check();
  await dialog.getByRole("button", { name: "Agents", exact: true }).click();
  await dialog
    .getByRole("checkbox", { name: "Agents Delete", exact: true })
    .uncheck();
  await dialog.getByRole("button", { name: "Other", exact: true }).click();
  await expect(
    dialog.getByRole("checkbox", {
      name: "Knowledge Sources Read",
      exact: true,
    }),
  ).toBeChecked();
  await expect(
    dialog.getByPlaceholder("Find a resource or action…"),
  ).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /^Selected/ })).toHaveCount(
    0,
  );

  const updated = {
    ...customRole,
    permission: {
      agent: ["read", "create"],
      knowledgeSource: ["read"],
    },
  };
  await mswControl.use({
    method: "put",
    url: `/api/roles/${customRole.id}`,
    body: updated,
  });
  const savedRequest = page.waitForRequest(
    (request) =>
      request.method() === "PUT" &&
      request.url().endsWith(`/api/roles/${customRole.id}`),
  );
  await dialog
    .getByRole("button", { name: "Save Changes", exact: true })
    .click();
  expect((await savedRequest).postDataJSON()).toMatchObject({
    permission: updated.permission,
  });
  await expect(dialog).toBeHidden();
});

test("read-only roles and personal access expose permissions and keyboard sources", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/settings/roles?view=admin");
  const dialog = page.getByRole("dialog", { name: "Admin", exact: true });
  await expect(
    dialog.getByRole("button", { name: "Agents Read granted", exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  await capture(page, "role-view-desktop");

  const personal = await openAccountPermissions(page);
  const permission = personal.getByRole("button", {
    name: "Agents Read granted",
    exact: true,
  });
  await expect(permission).toBeVisible();
  await capture(page, "account-permissions-desktop");
  await permission.focus();
  await expect(page.getByRole("tooltip")).toContainText(
    "Admin · Direct assignment",
  );
  await expect(page.getByRole("tooltip")).toContainText(
    "Agent Editor · Team: Platform",
  );
  await expect(
    personal.getByPlaceholder("Find a resource or action…"),
  ).toHaveCount(0);
  await personal.getByRole("button", { name: "Other", exact: true }).click();
  await expect(
    personal.getByRole("button", {
      name: "Knowledge Sources Query granted",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    personal.getByRole("button", { name: "Agents Read granted", exact: true }),
  ).toHaveCount(0);
});

for (const viewport of [
  { width: 390, height: 844 },
  { width: 667, height: 375 },
]) {
  test(`all three permission views remain usable at ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto(`/settings/roles?edit=${customRole.id}`);
    const edit = page.getByRole("dialog", { name: "Edit role", exact: true });
    await expect(
      edit.getByRole("checkbox", { name: "Agents Read", exact: true }),
    ).toBeChecked();
    await insideViewport(page, edit);
    await insideViewport(
      page,
      edit.getByRole("button", { name: "Save Changes", exact: true }),
    );
    await expectNoOverflow(edit);
    await edit
      .getByRole("checkbox", { name: "Agents Delete", exact: true })
      .uncheck();
    await expect(
      edit.getByRole("checkbox", { name: "Agents Delete", exact: true }),
    ).not.toBeChecked();
    await capture(page, `role-edit-${viewport.width}`);
    await edit.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(edit).toBeHidden();

    await page.goto("/settings/roles?view=admin");
    const view = page.getByRole("dialog", { name: "Admin", exact: true });
    await expect(
      view.getByRole("button", { name: "Agents Read granted", exact: true }),
    ).toBeVisible();
    await insideViewport(page, view);
    await insideViewport(
      page,
      view.getByRole("button", { name: "Close", exact: true }).first(),
    );
    await expectNoOverflow(view);
    await capture(page, `role-view-${viewport.width}`);

    const personal = await openAccountPermissions(page);
    await expect(
      personal.getByPlaceholder("Find a resource or action…"),
    ).toHaveCount(0);
    await insideViewport(page, personal);
    await expectNoOverflow(personal);
    const read = personal.getByRole("button", {
      name: "Agents Read granted",
      exact: true,
    });
    await read.scrollIntoViewIfNeeded();
    await insideViewport(page, read);
    await expectNoOverflow(
      personal.getByRole("region", { name: "Agents resources" }),
    );
    await capture(page, `account-permissions-${viewport.width}`);
  });
}

/** Personal permissions live behind View in the Account tab's Access section. */
async function openAccountPermissions(page: Page) {
  await page.goto("/account");
  await page.getByRole("button", { name: "View", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Your permissions",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function insideViewport(page: Page, element: Locator) {
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

async function expectNoOverflow(element: Locator) {
  await expect
    .poll(() =>
      element.evaluate((node) => node.scrollWidth <= node.clientWidth),
    )
    .toBe(true);
}

async function capture(page: Page, name: string) {
  const directory = process.env.ARCHESTRA_PERMISSION_REVIEW_ARTIFACT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({
    path: join(directory, `${name}.png`),
    animations: "disabled",
  });
}
