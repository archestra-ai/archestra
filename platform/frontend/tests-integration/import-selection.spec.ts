import type { Locator, Page } from "@playwright/test";
import { makeImportedSkill, skillsListSeed } from "../src/mocks/data/skills";
import { expect, test } from "./fixtures";

const repo = "example/skills";
const created = [
  makeImportedSkill({
    id: "11111111-1111-4111-8111-111111111111",
    name: "Imported first",
  }),
  makeImportedSkill({
    id: "22222222-2222-4222-8222-222222222222",
    name: "Imported second",
  }),
];
const discovery = {
  repoUrl: `https://github.com/${repo}`,
  ref: "main",
  skills: Array.from({ length: 315 }, (_, i) => ({
    skillPath: `skills/item-${i}`,
    name: `Skill ${i}`,
    description: `Instruction set ${i}`,
    compatibility: null,
    allowedTools: null,
    templated: false,
    fileCount: 1,
    exists: i === 313,
  })),
};

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 740 },
]) {
  test(`315 skills stay bounded and preserve selection across search at ${viewport.width}px`, async ({
    page,
    skillsNewPage,
    mswControl,
  }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({
      colorScheme: viewport.width === 390 ? "dark" : "light",
    });
    await mswControl.use({
      method: "post",
      url: "/api/skills/github/discover",
      body: discovery,
    });
    await skillsNewPage.goto();
    await skillsNewPage.gitRepositoryCard.click();
    await enterRepository(page, "skills");
    const dialog = page.getByRole("dialog", {
      name: "Select skills to import",
    });
    await expect(dialog).toContainText("314 of 314 selected");
    await assertBoundedList({ page, dialog, noun: "Skills" });
    await dialog
      .getByRole("region", { name: "Skills to import" })
      .evaluate((element) => {
        element.scrollTop = 0;
      });
    await dialog.screenshot({
      path: `test-results/import-skills-large-${viewport.width}.png`,
    });
    await dialog.getByRole("button", { name: "Clear selection" }).click();
    const search = dialog.getByPlaceholder(
      "Search by name, description, or path",
    );
    await search.fill("Skill 314");
    await dialog
      .getByRole("checkbox", { name: "Select Skill 314", exact: true })
      .click();
    await search.fill("Skill 0");
    await dialog
      .getByRole("checkbox", { name: "Select Skill 0", exact: true })
      .click();
    await search.fill("");
    await dialog.getByRole("button", { name: "Selected (2)" }).click();
    await expect(
      dialog.getByRole("checkbox", { name: "Deselect Skill 314", exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("checkbox", { name: "Deselect Skill 0", exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("checkbox", { name: "Select Skill 1", exact: true }),
    ).toHaveCount(0);
    await dialog.getByRole("button", { name: "Import settings" }).click();
    await expect(
      dialog.getByRole("combobox", { name: "Keep in sync" }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Import settings" }).click();
    await dialog.screenshot({
      path: `test-results/import-skills-${viewport.width}.png`,
    });
    await dialog.getByRole("button", { name: "Clear selection" }).click();
    await dialog.getByRole("button", { name: "Selected (0)" }).click();
    await dialog
      .getByRole("checkbox", { name: "Select Skill 2", exact: true })
      .click({ modifiers: ["Shift"] });
    await expect(
      dialog.getByRole("button", { name: "Import (1)", exact: true }),
    ).toBeEnabled();
    await dialog.getByRole("button", { name: "Back", exact: true }).click();
    await expect(
      page
        .getByRole("dialog", { name: "Import skills" })
        .getByPlaceholder("github.com/owner/repo"),
    ).toHaveValue(repo);
    await page
      .getByRole("button", { name: "Find skills", exact: true })
      .click();
    await expect(dialog).toContainText("314 of 314 selected");
    await expect(
      dialog.getByPlaceholder("Search by name, description, or path"),
    ).toHaveValue("");
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toBeHidden();
    await skillsNewPage.gitRepositoryCard.click();
    await expect(
      page
        .getByRole("dialog", { name: "Import skills" })
        .getByRole("button", { name: /^GitHub/ }),
    ).toBeVisible();
    await page
      .getByRole("dialog", { name: "Import skills" })
      .getByRole("button", { name: "Cancel" })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
}

test("partial imports filter exact returned IDs, clear the filter, and survive browser navigation", async ({
  page,
  skillsNewPage,
  mswControl,
}) => {
  const importedIds = created.map((skill) => skill.id).join(",");
  const importedRows = created.map((skill) => ({
    ...skillsListSeed.data[0],
    ...skill,
  }));
  await mswControl.registerMany([
    {
      method: "post",
      url: "/api/skills/github/discover",
      body: { ...discovery, skills: discovery.skills.slice(0, 3) },
    },
    {
      method: "post",
      url: "/api/skills/github/import",
      body: { created, skipped: ["Skill 2"], skippedFiles: [] },
    },
    {
      method: "get",
      url: "/api/skills",
      body: {
        ...skillsListSeed,
        data: [
          ...importedRows,
          { ...skillsListSeed.data[0], name: "Older same repository" },
        ],
        pagination: { ...skillsListSeed.pagination, total: 3 },
      },
    },
    {
      method: "get",
      url: "/api/skills",
      query: { skillIds: importedIds },
      body: {
        ...skillsListSeed,
        data: importedRows,
        pagination: { ...skillsListSeed.pagination, total: 2 },
      },
    },
  ]);
  await skillsNewPage.goto();
  await skillsNewPage.gitRepositoryCard.click();
  await enterRepository(page, "skills");
  await page
    .getByRole("dialog", { name: "Select skills to import" })
    .getByRole("button", { name: /^Import \(/ })
    .click();
  await expect(page.getByText("Just imported", { exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("imported")).toBe(importedIds);
  await expect(page.getByText("Imported first", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Imported second", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Older same repository", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("main")
    .screenshot({ path: "test-results/imported-filter.png" });
  await page.reload();
  await expect(page.getByText("Just imported", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Show all skills" }).click();
  await expect(
    page.getByText("Older same repository", { exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.has("imported")).toBe(false);
  await page.goBack();
  await expect(page.getByText("Just imported", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Older same repository", { exact: true }),
  ).toHaveCount(0);
  await page.goForward();
  await expect(
    page.getByText("Older same repository", { exact: true }),
  ).toBeVisible();
  const nextCreated = makeImportedSkill({
    id: "33333333-3333-4333-8333-333333333333",
    name: "Next import",
  });
  await mswControl.registerMany([
    {
      method: "post",
      url: "/api/skills/github/discover",
      body: {
        ...discovery,
        skills: discovery.skills
          .slice(0, 3)
          .map((skill, index) => ({ ...skill, exists: index < 2 })),
      },
    },
    {
      method: "post",
      url: "/api/skills/github/import",
      body: { created: [nextCreated], skipped: [], skippedFiles: [] },
    },
    {
      method: "get",
      url: "/api/skills",
      query: { skillIds: nextCreated.id },
      body: {
        ...skillsListSeed,
        data: [{ ...skillsListSeed.data[0], ...nextCreated }],
        pagination: { ...skillsListSeed.pagination, total: 1 },
      },
    },
  ]);
  await skillsNewPage.goto();
  await skillsNewPage.gitRepositoryCard.click();
  await enterRepository(page, "skills");
  const nextDialog = page.getByRole("dialog", {
    name: "Select skills to import",
  });
  await expect(nextDialog).toContainText("1 of 1 selected · 2 imported");
  await nextDialog
    .getByRole("button", { name: "Import (1)", exact: true })
    .click();
  await expect(page.getByText("Next import", { exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("imported")).toBe(nextCreated.id);
  await expect(page.getByText("Imported first", { exact: true })).toHaveCount(
    0,
  );
});

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 740 },
]) {
  test(`315 plugins keep the batch limit and selection across filters at ${viewport.width}px`, async ({
    page,
    mswControl,
  }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({
      colorScheme: viewport.width === 390 ? "dark" : "light",
    });
    const marketplace = {
      repoUrl: `https://github.com/${repo}`,
      ref: "main",
      commitSha: "0".repeat(40),
      marketplacePath: ".claude-plugin/marketplace.json",
      reason: null,
      entries: Array.from({ length: 315 }, (_, i) => ({
        marketplacePath: ".claude-plugin/marketplace.json",
        name: `Plugin ${i}`,
        description: `Extension ${i}`,
        version: "1.0.0",
        clientType: "claude-code",
        sourceRepoUrl: null,
        sourceRef: null,
        sourceSubdir: `plugins/item-${i}`,
        sourceCommitSha: null,
        fileCount: 2,
        supported: i !== 313,
        reason: i === 313 ? "Unsupported format" : null,
      })),
    };
    await mswControl.registerMany([
      {
        method: "post",
        url: "/api/plugins/github/marketplace/discover",
        body: marketplace,
      },
      {
        method: "post",
        url: "/api/plugins/github/marketplace/import",
        body: {
          created: [],
          skipped: [],
          failed: [{ name: "Plugin 0", error: "Could not import" }],
        },
      },
      {
        method: "get",
        url: "/api/resource-permissions/plugin/creation-subjects",
        body: [],
      },
    ]);
    await page.goto("/plugins/new?source=marketplace");
    await enterRepository(page, "plugins");
    const dialog = page.getByRole("dialog", {
      name: "Select plugins to import",
    });
    await expect(dialog).toContainText("10 of 314 selected");
    await expect
      .poll(() =>
        dialog
          .getByText("Plugin 0", { exact: true })
          .evaluate((element) => element.scrollWidth > element.clientWidth),
      )
      .toBe(false);
    await assertBoundedList({ page, dialog, noun: "Plugins" });
    await dialog
      .getByRole("region", { name: "Plugins to import" })
      .evaluate((element) => {
        element.scrollTop = 0;
      });
    await dialog.screenshot({
      path: `test-results/import-plugins-large-${viewport.width}.png`,
    });
    await expect(
      dialog.getByRole("checkbox", {
        name: "Selection limit reached for Plugin 10",
        exact: true,
      }),
    ).toBeDisabled();
    await dialog.getByRole("button", { name: "Clear selection" }).click();
    const search = dialog.getByPlaceholder("Search by name or description");
    await search.fill("Plugin 314");
    await dialog
      .getByRole("checkbox", { name: "Select Plugin 314", exact: true })
      .click();
    await search.fill("Plugin 0");
    await dialog
      .getByRole("checkbox", { name: "Select Plugin 0", exact: true })
      .click();
    await search.fill("");
    await dialog.getByRole("button", { name: "Selected (2)" }).click();
    await expect(
      dialog.getByRole("checkbox", {
        name: "Deselect Plugin 314",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("checkbox", { name: "Deselect Plugin 0", exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("checkbox", { name: "Select Plugin 1", exact: true }),
    ).toHaveCount(0);
    const sent = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname ===
        "/api/plugins/github/marketplace/import",
    );
    await dialog
      .getByRole("button", { name: "Import (2)", exact: true })
      .click();
    expect(
      (await sent)
        .postDataJSON()
        .selected.map((entry: { name: string }) => entry.name)
        .sort(),
    ).toEqual(["Plugin 0", "Plugin 314"]);
    await expect(
      page.getByText("1 plugin import failed", { exact: true }),
    ).toBeVisible();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Back", exact: true }).click();
    await page
      .getByRole("button", { name: "Find plugins", exact: true })
      .click();
    await expect(dialog).toContainText("10 of 314 selected");
    await expect(search).toHaveValue("");
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole("button", { name: /^Git repository/ }).click();
    await expect(
      page
        .getByRole("dialog", { name: "Import plugins" })
        .getByRole("button", { name: /^GitHub/ }),
    ).toBeVisible();
    await page
      .getByRole("dialog", { name: "Import plugins" })
      .getByRole("button", { name: "Cancel" })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
}

async function enterRepository(page: Page, noun: "skills" | "plugins") {
  const dialog = page.getByRole("dialog", { name: `Import ${noun}` });
  await dialog.getByRole("button", { name: /^GitHub/ }).click();
  await dialog.getByRole("button", { name: "Continue" }).click();
  await dialog.getByPlaceholder("github.com/owner/repo").fill(repo);
  await dialog
    .getByRole("button", { name: `Find ${noun}`, exact: true })
    .click();
}

async function assertBoundedList({
  page,
  dialog,
  noun,
}: {
  page: Page;
  dialog: Locator;
  noun: string;
}) {
  const region = dialog.getByRole("region", { name: `${noun} to import` });
  await expect(region).toBeVisible();
  await dialog.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .filter(
          (animation) => animation.effect?.getTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  const headerBottom = await dialog
    .getByRole("heading", { name: `Select ${noun.toLowerCase()} to import` })
    .evaluate(
      (element) => element.parentElement?.getBoundingClientRect().bottom,
    );
  const repositoryTop = await dialog
    .getByText(repo, { exact: true })
    .evaluate((element) => element.parentElement?.getBoundingClientRect().top);
  expect(repositoryTop).toBe(headerBottom);
  const bounds = await dialog.boundingBox();
  const viewport = page.viewportSize();
  if (!bounds || !viewport) throw new Error("Dialog has no viewport bounds");
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
  expect(bounds.width).toBeLessThanOrEqual(viewport.width);
  const importButton = dialog.getByRole("button", { name: /^Import \(/ });
  const before = await importButton.boundingBox();
  const scroll = await region.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return {
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      scrollTop: element.scrollTop,
    };
  });
  expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight * 10);
  expect(scroll.scrollTop).toBeGreaterThan(0);
  await expect(importButton).toBeInViewport();
  expect((await importButton.boundingBox())?.y).toBe(before?.y);
}
