import type { APIResponse, Page } from "@playwright/test";
import { E2eTestId, UI_BASE_URL } from "../consts";
import { expect, test } from "../fixtures";

/**
 * The Skills page multiselect: pick several rows, then delete them in one go.
 * Who can reach a skill is its grants, edited per skill, so there is no bulk
 * visibility action any more.
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
      await expect(selectionCount(page)).toHaveText("2 skills selected");

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

/**
 * The visible "N skills selected" label. Located by test id because an
 * off-screen `aria-live` region carries the same sentence for screen readers,
 * so a text lookup matches two nodes.
 */
function selectionCount(page: Page) {
  return page.getByTestId(E2eTestId.SkillsBulkSelectionCount);
}

async function createSkill(page: Page, skillName: string): Promise<string> {
  const response = await page.request.post(`${UI_BASE_URL}/api/skills`, {
    data: { content: manifest(skillName) },
  });
  await expectApiOk(response, "create skill");
  const created = (await response.json()) as { id: string };
  return created.id;
}

async function expectApiOk(response: APIResponse, label: string) {
  expect(
    response.ok(),
    `${label} failed (${response.status()}): ${await response.text()}`,
  ).toBeTruthy();
}
