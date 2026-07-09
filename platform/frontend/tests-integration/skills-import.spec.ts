import {
  catalogRootSkillSeed,
  catalogSkillSeed,
  githubPreviewSeed,
  makeImportedSkill,
} from "../src/mocks/data/skills";
import { expect, test } from "./fixtures";

test.describe("Skills import", () => {
  test("catalog result opens the import dialog on the confirm step, skipping the repo scan", async ({
    page,
    skillsNewPage,
    mswControl,
  }) => {
    // Sentinel: if the dialog ran the repo-wide discover scan it would
    // replace the indexed selection with this skill — the dialog must never
    // show it.
    await mswControl.use({
      method: "post",
      url: "/api/skills/github/discover",
      body: {
        repoUrl: catalogSkillSeed.repo,
        ref: "main",
        skills: [
          {
            skillPath: "skills/sentinel",
            name: "Discover sentinel",
            description: "Must not appear",
            compatibility: null,
            allowedTools: null,
            templated: false,
            fileCount: 1,
            exists: false,
          },
        ],
      },
    });

    await skillsNewPage.goto();
    await expect(skillsNewPage.heading).toBeVisible();

    await skillsNewPage.searchInput.fill("target");
    const result = skillsNewPage.importResultFor(
      catalogSkillSeed.name,
      catalogSkillSeed.repo,
    );
    await expect(result).toBeVisible();
    await result.click();

    const dialog = page.getByRole("dialog", {
      name: "Select skills to import",
    });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(catalogSkillSeed.name);
    await expect(dialog).toContainText("1 of 1 selected");

    // A discover round trip against the in-page MSW worker lands within
    // milliseconds; give a would-be late response time to arrive before the
    // negative assertion so it can't pass by racing the network.
    await page.waitForTimeout(500);
    await expect(dialog).toContainText(catalogSkillSeed.name);
    await expect(dialog).not.toContainText("Discover sentinel");
  });

  test("import sends the indexed skill's repo and path, then closes on success", async ({
    page,
    skillsNewPage,
  }) => {
    await skillsNewPage.goto();
    await skillsNewPage.searchInput.fill("target");
    await skillsNewPage
      .importResultFor(catalogSkillSeed.name, catalogSkillSeed.repo)
      .click();

    const dialog = page.getByRole("dialog", {
      name: "Select skills to import",
    });
    await expect(dialog).toContainText("1 of 1 selected");

    // The default import handler (src/mocks/handlers.ts) only returns
    // `created: [...]` for the exact payload {repoUrl: "acme/skills",
    // skillPaths: ["skills/target"]}; anything else comes back skipped, the
    // dialog stays open, and the assertions below fail. Closing therefore
    // pins the request payload.
    await dialog.getByRole("button", { name: /^Import/ }).click();
    await expect(dialog).toBeHidden();

    // onImported navigates to the skills list.
    await expect(
      page.getByRole("heading", { name: "Skills", exact: true }),
    ).toBeVisible();
  });

  test("dialog stays open when the import skips every selected skill", async ({
    page,
    skillsNewPage,
    mswControl,
  }) => {
    await mswControl.use({
      method: "post",
      url: "/api/skills/github/import",
      body: {
        created: [],
        // the backend reports skipped skills by parsed manifest name
        skipped: [catalogSkillSeed.name],
        skippedFiles: [],
      },
    });

    await skillsNewPage.goto();
    await skillsNewPage.searchInput.fill("target");
    await skillsNewPage
      .importResultFor(catalogSkillSeed.name, catalogSkillSeed.repo)
      .click();

    const dialog = page.getByRole("dialog", {
      name: "Select skills to import",
    });
    await expect(dialog).toContainText("1 of 1 selected");

    await dialog.getByRole("button", { name: /^Import/ }).click();

    // The mutation's toast reports the skip; once it shows, the import round
    // trip is complete and the dialog must still be open.
    await expect(page.getByText("skipped 1 already in the org")).toBeVisible();
    await expect(dialog).toBeVisible();
  });

  test("manual GitHub import discovers the repository's skills", async ({
    page,
    skillsNewPage,
  }) => {
    await skillsNewPage.goto();
    await skillsNewPage.customGithubUrlCard.click();

    const discoverDialog = page.getByRole("dialog", {
      name: "Import skills from GitHub",
    });
    await expect(discoverDialog).toBeVisible();

    await discoverDialog
      .getByLabel("Repository URL")
      .fill("github.com/acme/skills");
    await discoverDialog.getByRole("button", { name: "Discover" }).click();

    // The default discover handler returns two importable skills.
    const selectDialog = page.getByRole("dialog", {
      name: "Select skills to import",
    });
    await expect(selectDialog).toBeVisible();
    await expect(selectDialog).toContainText("2 of 2 selected");
    await expect(
      selectDialog.getByRole("button", { name: "Deselect Alpha skill" }),
    ).toBeVisible();
    await expect(
      selectDialog.getByRole("button", { name: "Deselect Beta skill" }),
    ).toBeVisible();
  });

  test("a repo-root catalog skill (empty skillPath) reaches the confirm step and can be previewed", async ({
    page,
    skillsNewPage,
    mswControl,
  }) => {
    await mswControl.use({
      method: "post",
      url: "/api/skills/github/preview",
      body: { ...githubPreviewSeed, name: catalogRootSkillSeed.name },
    });

    await skillsNewPage.goto();
    await skillsNewPage.searchInput.fill("root");
    await skillsNewPage
      .importResultFor(catalogRootSkillSeed.name, catalogRootSkillSeed.repo)
      .click();

    const dialog = page.getByRole("dialog", {
      name: "Select skills to import",
    });
    await expect(dialog).toContainText("1 of 1 selected");

    // the root skill's empty path must still be a previewable selection
    await dialog.getByRole("button", { name: "Preview Root skill" }).click();
    await expect(
      page.getByRole("dialog", { name: catalogRootSkillSeed.name }),
    ).toBeVisible();
  });

  test("the import toast warns when resource files were dropped", async ({
    page,
    skillsNewPage,
    mswControl,
  }) => {
    await mswControl.use({
      method: "post",
      url: "/api/skills/github/import",
      body: {
        created: [makeImportedSkill()],
        skipped: [],
        skippedFiles: [
          {
            skillPath: catalogSkillSeed.skillPath,
            files: ["assets/big.bin", "assets/huge.pdf"],
          },
        ],
      },
    });

    await skillsNewPage.goto();
    await skillsNewPage.searchInput.fill("target");
    await skillsNewPage
      .importResultFor(catalogSkillSeed.name, catalogSkillSeed.repo)
      .click();
    await page
      .getByRole("dialog", { name: "Select skills to import" })
      .getByRole("button", { name: /^Import/ })
      .click();

    await expect(
      page.getByText(
        "2 resource files were not imported (oversized or unfetchable)",
      ),
    ).toBeVisible();
  });
});
