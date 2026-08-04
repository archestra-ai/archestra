import type { APIResponse, Page } from "@playwright/test";
import { UI_BASE_URL } from "../consts";
import { expect, test } from "../fixtures";

/**
 * A skill needs more than one version before the history says anything: the
 * timeline has a single row, and "Changes" has no predecessor to compare
 * against. So every case here creates a skill and then edits it.
 */
const FIRST_BODY = "Read the request, then answer it.";
const SECOND_BODY = "Read the request, check the context, then answer it.";

const manifest = (name: string, body: string) =>
  [
    "---",
    `name: ${name}`,
    "description: A skill used for version-history e2e coverage.",
    "---",
    "",
    `# ${name}`,
    body,
  ].join("\n");

test.describe("Skill version history", () => {
  test.setTimeout(90_000);

  test("browses versions, diffs them, and restores an earlier one", async ({
    page,
    makeRandomString,
    goToPage,
  }) => {
    const skillName = makeRandomString(8, "version-skill").toLowerCase();
    const skillId = await createSkill(page, skillName, FIRST_BODY);

    try {
      // The second version is what makes the timeline and the diff meaningful.
      await updateSkill(page, skillId, manifest(skillName, SECOND_BODY));

      await goToPage(page, "/skills");
      await page.waitForLoadState("domcontentloaded");

      await page
        .getByRole("button", { name: `Version history ${skillName}` })
        .click();

      const dialog = page.getByRole("dialog");
      await expect(
        dialog.getByRole("heading", { name: "Version history" }),
      ).toBeVisible();

      // Opens on the head, which is the version the skill currently is.
      await expect(
        dialog.getByRole("heading", { name: "Version 2" }),
      ).toBeVisible();

      const olderVersion = dialog.getByRole("button", { name: /^v1/ });
      await expect(olderVersion).toBeVisible();
      await olderVersion.click();
      await expect(
        dialog.getByRole("heading", { name: "Version 1" }),
      ).toBeVisible();

      // The only place the real Monaco diff renders — every unit test stubs it.
      await dialog.getByRole("button", { name: /^Changes/ }).click();
      await expect(dialog.getByText(FIRST_BODY)).toBeVisible();

      await dialog
        .getByRole("button", { name: "Restore this version" })
        .click();
      const confirmation = page.getByRole("dialog", {
        name: /Restore version 1/,
      });
      await confirmation
        .getByRole("button", { name: /^Restore version 1$/ })
        .click();

      // A restore forks forward: version 1's content becomes version 3 rather
      // than the history rewinding to 1.
      await expect(
        dialog.getByRole("heading", { name: "Version 3" }),
      ).toBeVisible();
      await expect(dialog.getByRole("button", { name: /^v3/ })).toBeVisible();

      const restored = await readSkill(page, skillId);
      expect(restored.latestVersion).toBe(3);
      expect(restored.content).toContain(FIRST_BODY);
    } finally {
      await page.request.delete(`${UI_BASE_URL}/api/skills/${skillId}`);
    }
  });
});

async function createSkill(
  page: Page,
  skillName: string,
  body: string,
): Promise<string> {
  const response = await page.request.post(`${UI_BASE_URL}/api/skills`, {
    data: { content: manifest(skillName, body) },
  });
  await expectApiOk(response, "create skill");
  const created = (await response.json()) as { id: string };
  return created.id;
}

async function updateSkill(page: Page, skillId: string, content: string) {
  const response = await page.request.put(
    `${UI_BASE_URL}/api/skills/${skillId}`,
    { data: { content } },
  );
  await expectApiOk(response, "update skill");
}

async function readSkill(page: Page, skillId: string) {
  const response = await page.request.get(
    `${UI_BASE_URL}/api/skills/${skillId}`,
  );
  await expectApiOk(response, "read skill");
  return (await response.json()) as { latestVersion: number; content: string };
}

async function expectApiOk(response: APIResponse, label: string) {
  expect(
    response.ok(),
    `${label} failed (${response.status()}): ${await response.text()}`,
  ).toBeTruthy();
}
