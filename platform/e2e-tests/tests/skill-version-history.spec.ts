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

      // Filtered by name rather than browsed to: the list sorts by usage count
      // descending, so a skill created seconds ago has none and sorts last —
      // off the first page entirely on a database with real skills in it.
      await goToPage(page, `/skills?search=${skillName}`);
      await page.waitForLoadState("domcontentloaded");

      await page
        .getByRole("button", { name: `Version history ${skillName}` })
        .click();

      // Named, because the restore confirmation below is a dialog too and an
      // unnamed lookup matches both while it animates out.
      const dialog = page.getByRole("dialog", { name: /Version history/ });
      await expect(
        dialog.getByRole("heading", { name: "Version history" }),
      ).toBeVisible();

      // Opens on the head, which is the version the skill currently is.
      await expect(
        dialog.getByRole("heading", { name: "Version 2" }),
      ).toBeVisible();

      // Read the diff here: version 2 is the only one with a predecessor to
      // compare against. This is the only place the real Monaco diff renders —
      // every unit test stubs it.
      await dialog.getByRole("button", { name: /^Changes/ }).click();
      // Monaco marks each editor `role="code"`; in a unified diff the second is
      // the modified side, which carries both revisions — the removed line as an
      // overlay above the added one. Asserted with `toContainText` rather than a
      // text locator because Monaco splits every line into one span per token,
      // so no single element holds a whole line to match against.
      //
      // Given longer than the default: this is the first Monaco paint of the
      // run, and loading the editor bundle overruns the 10s expect timeout.
      const unifiedDiff = dialog.getByRole("code").last();
      await expect(unifiedDiff).toContainText("check the context", {
        timeout: 30_000,
      });
      await expect(unifiedDiff).toContainText(FIRST_BODY);

      const olderVersion = dialog.getByRole("button", { name: /^v1/ });
      await expect(olderVersion).toBeVisible();
      await olderVersion.click();
      await expect(
        dialog.getByRole("heading", { name: "Version 1" }),
      ).toBeVisible();
      // The earliest version has no baseline, so comparing is not offered at
      // all rather than offered and empty.
      await expect(
        dialog.getByRole("button", { name: /^Changes/ }),
      ).toBeDisabled();

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
