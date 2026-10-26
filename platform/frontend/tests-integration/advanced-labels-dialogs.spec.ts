import type { archestraApiTypes } from "@archestra/shared";
import { paginated } from "../src/mocks/data/interactions";
import { makeLlmProviderApiKey } from "../src/mocks/data/llm-keys";
import { expect, test } from "./fixtures";

const project: archestraApiTypes.GetProjectResponses["200"] = {
  id: "preview-project",
  name: "Preview project",
  description: null,
  icon: null,
  viewerRole: "owner",
  ownerName: "Test Admin",
  createdBy: null,
  labels: [{ key: "stage", value: "preview" }],
  conversationCount: 0,
  visibility: "user",
  shareTeamNames: null,
  shareUserNames: null,
  pinnedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
  shareTeamIds: null,
  shareUserIds: null,
  defaultAgent: null,
};
const app: archestraApiTypes.GetAppResponses["200"] = {
  id: "preview-app",
  organizationId: "test-org",
  authorId: "test-user-admin",
  name: "Preview app",
  slug: "preview-app",
  description: null,
  templateId: null,
  mcpServerId: null,
  spec: null,
  latestVersion: 1,
  enabled: true,
  openInFullscreen: false,
  locked: false,
  createdByServiceAccountId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
  scope: "personal",
  environmentId: null,
  icon: null,
  labels: [{ key: "stage", value: "preview" }],
  createdBy: null,
  teams: [],
  users: [],
  viewerRole: "owner",
  authorName: "Test Admin",
};

for (const width of [1440, 390]) {
  test(`project and app label accordions retain drafts at ${width}px`, async ({
    page,
    mswControl,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await mswControl.registerMany([
      {
        method: "get",
        url: "/api/llm-provider-api-keys",
        body: [makeLlmProviderApiKey()],
      },
      { method: "get", url: "/api/projects/labels/keys", body: [] },
      { method: "get", url: "/api/projects/labels/values", body: [] },
      {
        method: "get",
        url: "/api/projects",
        body: paginated([project], { limit: 20 }),
      },
      { method: "get", url: "/api/projects/preview-project", body: project },
      { method: "get", url: "/api/apps/preview-app", body: app },
      { method: "get", url: "/api/apps/preview-app/tools", body: [] },
    ]);
    await page.goto("/projects");
    await page
      .getByRole("button", { name: "New project", exact: true })
      .click();
    const create = page.getByRole("dialog", {
      name: "New project",
      exact: true,
    });
    await expect(
      create.getByLabel("Label key", { exact: true }),
    ).not.toBeVisible();
    await create.getByRole("button", { name: "Advanced", exact: true }).click();
    await create.getByLabel("Label key", { exact: true }).fill("stage");
    await create.getByRole("button", { name: "Advanced", exact: true }).click();
    await expect(
      create.getByLabel("Label key", { exact: true }),
    ).not.toBeVisible();
    await create.getByRole("button", { name: "Advanced", exact: true }).click();
    await expect(create.getByLabel("Label key", { exact: true })).toHaveValue(
      "stage",
    );
    await create.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(create).not.toBeVisible();
    await page
      .getByRole("button", { name: "New project", exact: true })
      .click();
    await expect(
      create.getByRole("button", { name: "Advanced", exact: true }),
    ).toHaveAttribute("aria-expanded", "false");
    await create.getByRole("button", { name: "Cancel", exact: true }).click();

    for (const [url, title] of [
      ["/projects?edit=preview-project", "Edit project"],
      ["/apps?settings=preview-app", "App settings"],
    ]) {
      await page.goto(url);
      const dialog = page.getByRole("dialog", { name: title, exact: true });
      const advanced = dialog.getByRole("button", {
        name: "Advanced",
        exact: true,
      });
      await expect(advanced).toHaveAttribute("aria-expanded", "false");
      await expect(
        dialog.getByLabel("Label key", { exact: true }),
      ).not.toBeVisible();
      await advanced.click();
      await expect(dialog.getByText("stage:", { exact: true })).toBeVisible();
      await expect(dialog.getByText("preview", { exact: true })).toBeVisible();
      await dialog.getByLabel("Label key", { exact: true }).fill("region");
      await advanced.click();
      await advanced.click();
      await expect(dialog.getByLabel("Label key", { exact: true })).toHaveValue(
        "region",
      );
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog).not.toBeVisible();
    }
  });
}
