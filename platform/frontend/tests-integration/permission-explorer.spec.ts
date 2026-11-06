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
    // The role page lists who holds the role; nobody does in this fixture.
    { method: "get", url: "/api/service-accounts", body: [] },
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

test("editing across areas saves the complete role", async ({
  page,
  mswControl,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/settings/roles/${customRole.id}/edit`);
  await expect(
    page.getByRole("checkbox", { name: "View agents", exact: true }),
  ).toBeChecked();
  await capture(page, "role-edit-desktop");

  // Granting in one area and revoking in another both survive the area
  // chips: the list only filters what is shown, never what is held.
  await page.getByRole("button", { name: "Other", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "View knowledge sources", exact: true })
    .check();
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "Delete agents", exact: true })
    .uncheck();
  await page.getByRole("button", { name: "Other", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "View knowledge sources", exact: true }),
  ).toBeChecked();
  await expect(page.getByText("3 permissions selected")).toBeVisible();

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
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  expect((await savedRequest).postDataJSON()).toMatchObject({
    permission: updated.permission,
  });
  // Saving lands on the role's own page.
  await expect(page).toHaveURL(new RegExp(`/settings/roles/${customRole.id}$`));
});

test("read-only roles and personal access expose permissions and keyboard sources", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/settings/roles/admin");
  const agents = page.getByRole("region", { name: "Agents", exact: true });
  await expect(agents.getByText("View agents", { exact: true })).toBeVisible();
  // A built-in role is shown, never edited.
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Edit", exact: true }),
  ).toBeDisabled();
  await capture(page, "role-view-desktop");

  const personal = await openAccountPermissions(page);
  const personalAgents = personal.getByRole("region", {
    name: "Agents",
    exact: true,
  });
  await expect(
    personalAgents.getByText("View agents", { exact: true }),
  ).toBeVisible();
  await capture(page, "account-permissions-desktop");
  // Each row says which roles grant it, directly or through a team: the
  // custom role covers read, create and delete, so those three rows name it.
  await expect(
    personalAgents.getByTitle("From Admin and agent editor (through Platform)"),
  ).toHaveCount(3);
  await expect(
    personalAgents.getByTitle("From Admin", { exact: true }),
  ).toHaveCount(1);
  await expect(personal.getByRole("checkbox")).toHaveCount(0);
  await personal.getByRole("button", { name: "Other", exact: true }).click();
  await expect(
    personal.getByText("Query knowledge sources", { exact: true }),
  ).toBeVisible();
  await expect(personalAgents).toHaveCount(0);
});

for (const viewport of [
  { width: 390, height: 844 },
  { width: 667, height: 375 },
]) {
  test(`all three permission views remain usable at ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto(`/settings/roles/${customRole.id}/edit`);
    const form = page.locator("form");
    await expect(
      form.getByRole("checkbox", { name: "View agents", exact: true }),
    ).toBeChecked();
    const save = page.getByRole("button", {
      name: "Save changes",
      exact: true,
    });
    await save.scrollIntoViewIfNeeded();
    await insideViewport(page, save);
    await expectNoOverflow(form);
    await form
      .getByRole("checkbox", { name: "Delete agents", exact: true })
      .uncheck();
    await expect(
      form.getByRole("checkbox", { name: "Delete agents", exact: true }),
    ).not.toBeChecked();
    await capture(page, `role-edit-${viewport.width}`);
    // Leaving a dirty form asks first.
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page
      .getByRole("button", { name: "Discard changes", exact: true })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/settings/roles/${customRole.id}$`),
    );

    await page.goto("/settings/roles/admin");
    const agents = page.getByRole("region", { name: "Agents", exact: true });
    await expect(
      agents.getByText("View agents", { exact: true }),
    ).toBeVisible();
    // A resource card can be taller than a landscape phone; it must still fit
    // the width.
    await insideViewportWidth(page, agents);
    await expectNoOverflow(agents);
    await capture(page, `role-view-${viewport.width}`);

    const personal = await openAccountPermissions(page);
    // The unfolded list is taller than a phone; it must still fit the width.
    await insideViewportWidth(page, personal);
    await expectNoOverflow(personal);
    const read = personal.getByText("View agents", { exact: true });
    await read.scrollIntoViewIfNeeded();
    await insideViewport(page, read);
    await expectNoOverflow(
      personal.getByRole("region", { name: "Agents", exact: true }),
    );
    await capture(page, `account-permissions-${viewport.width}`);
  });
}

/**
 * Personal permissions unfold inside the Account tab's Access box, under the
 * Roles and Teams rows.
 */
async function openAccountPermissions(page: Page) {
  await page.goto("/account");
  await page.getByRole("button", { name: "Show", exact: true }).click();
  const access = page.getByRole("list", { name: "Access", exact: true });
  await expect(access.getByText("View agents", { exact: true })).toBeVisible();
  return access;
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

async function insideViewportWidth(page: Page, element: Locator) {
  await expect(element).toBeVisible();
  await expect
    .poll(async () => {
      const box = await element.boundingBox();
      const viewport = page.viewportSize();
      return (
        !!box &&
        !!viewport &&
        box.x >= 0 &&
        box.x + box.width <= viewport.width + 1
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
