import type { APIResponse, Page } from "@playwright/test";
import { UI_BASE_URL } from "../consts";
import { expect, test } from "../fixtures";

/**
 * The Skills page multiselect: pick several rows, then move their visibility or
 * delete them in one go.
 *
 * Every case creates its own skills and filters the list down to them by name.
 * The list sorts by usage count descending, so skills created seconds ago have
 * none and sort last — off the first page entirely on a database with real
 * skills in it.
 */
const manifest = (name: string) =>
  [
    "---",
    `name: ${name}`,
    "description: A skill used for bulk-action e2e coverage.",
    "---",
    "",
    `# ${name}`,
    "Do the thing.",
  ].join("\n");

test.describe("Skills bulk actions", () => {
  test.setTimeout(90_000);

  test("moves a selection of skills to org-wide visibility", async ({
    page,
    makeRandomString,
    goToPage,
  }) => {
    const prefix = makeRandomString(6, "bulkvis").toLowerCase();
    const names = [`${prefix}-a`, `${prefix}-b`, `${prefix}-c`];
    const ids = await Promise.all(names.map((name) => createSkill(page, name)));

    try {
      await goToPage(page, `/skills?search=${prefix}`);
      await page.waitForLoadState("domcontentloaded");
      await expect(page.getByText(names[0])).toBeVisible();

      await page.getByRole("checkbox", { name: `Select ${names[0]}` }).click();
      await page.getByRole("checkbox", { name: `Select ${names[1]}` }).click();
      await expect(page.getByText("2 skills selected")).toBeVisible();

      // Ticking a row must not also open that row's editor, which the row
      // click opens.
      await expect(page.getByRole("dialog")).toHaveCount(0);

      await page.getByRole("button", { name: "Edit visibility" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText("Applies to 2 skills.")).toBeVisible();

      // The visibility control opens collapsed on the selection's current
      // scope, which all three share.
      await dialog.getByRole("button", { name: /Personal/ }).click();
      await dialog.getByRole("button", { name: /Organization/ }).click();
      await dialog.getByRole("button", { name: "Apply" }).click();
      await expect(dialog).toBeHidden();

      // The two selected skills moved; the third is untouched.
      await expect
        .poll(async () => (await readSkill(page, ids[0])).scope)
        .toBe("org");
      expect((await readSkill(page, ids[1])).scope).toBe("org");
      expect((await readSkill(page, ids[2])).scope).toBe("personal");

      // Applying clears the selection, so the action bar goes away.
      await expect(page.getByText("2 skills selected")).toBeHidden();
    } finally {
      await Promise.all(
        ids.map((id) => page.request.delete(`${UI_BASE_URL}/api/skills/${id}`)),
      );
    }
  });

  test("deletes every selected skill at once", async ({
    page,
    makeRandomString,
    goToPage,
  }) => {
    const prefix = makeRandomString(6, "bulkdel").toLowerCase();
    const names = [`${prefix}-a`, `${prefix}-b`];
    const ids = await Promise.all(names.map((name) => createSkill(page, name)));

    try {
      await goToPage(page, `/skills?search=${prefix}`);
      await page.waitForLoadState("domcontentloaded");
      await expect(page.getByText(names[0])).toBeVisible();

      await page
        .getByRole("checkbox", { name: "Select all skills on this page" })
        .click();
      await expect(page.getByText("2 skills selected")).toBeVisible();

      await page.getByRole("button", { name: "Delete", exact: true }).click();
      const confirm = page.getByRole("dialog");
      await expect(confirm).toBeVisible();
      await confirm.getByRole("button", { name: "Delete skills" }).click();
      await expect(confirm).toBeHidden();

      // Both are gone from the list and from the API.
      await expect(page.getByText(names[0])).toBeHidden();
      await expect(page.getByText(names[1])).toBeHidden();
      for (const id of ids) {
        const response = await page.request.get(
          `${UI_BASE_URL}/api/skills/${id}`,
        );
        expect(response.status()).toBe(404);
      }
    } finally {
      // Already deleted on the happy path; this only matters when the test
      // failed partway through.
      await Promise.all(
        ids.map((id) => page.request.delete(`${UI_BASE_URL}/api/skills/${id}`)),
      );
    }
  });
});

async function createSkill(page: Page, skillName: string): Promise<string> {
  const response = await page.request.post(`${UI_BASE_URL}/api/skills`, {
    data: { content: manifest(skillName) },
  });
  await expectApiOk(response, "create skill");
  const created = (await response.json()) as { id: string };
  return created.id;
}

async function readSkill(page: Page, skillId: string) {
  const response = await page.request.get(
    `${UI_BASE_URL}/api/skills/${skillId}`,
  );
  await expectApiOk(response, "read skill");
  return (await response.json()) as { scope: string };
}

async function expectApiOk(response: APIResponse, label: string) {
  expect(
    response.ok(),
    `${label} failed (${response.status()}): ${await response.text()}`,
  ).toBeTruthy();
}
