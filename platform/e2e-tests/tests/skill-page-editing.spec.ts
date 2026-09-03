import type { APIResponse, Page } from "@playwright/test";
import { UI_BASE_URL } from "../consts";
import { expect, test } from "../fixtures";

/**
 * A skill's page is its settings: name, description, instructions, files and
 * access are all edited there and saved in place. There is no separate edit
 * route any more, so the promise worth pinning end to end is that a change
 * typed on the page actually reaches the skill — and that the URLs the old
 * wizard handed out still arrive somewhere.
 */
const manifest = (name: string, description: string, body: string) =>
  ["---", `name: ${name}`, `description: ${description}`, "---", "", body].join(
    "\n",
  );

test.describe("Skill page editing", () => {
  test.setTimeout(90_000);

  test("edits the skill on its own page and saves without leaving it", async ({
    page,
    makeRandomString,
    goToPage,
  }) => {
    const name = makeRandomString(8, "editable").toLowerCase();
    const skillId = await createSkill(
      page,
      manifest(name, "Before the edit.", "Original instructions."),
    );

    try {
      await goToPage(page, `/skills/${skillId}`);
      await page.waitForLoadState("domcontentloaded");

      // The skill opens in fields, not in a read-only view with an Edit button.
      const description = page.getByLabel("Description");
      await expect(description).toHaveValue("Before the edit.");
      await expect(page.getByRole("link", { name: /^Edit$/ })).toBeHidden();

      const save = page.getByRole("button", { name: "Save changes" });
      await expect(save).toBeDisabled();

      await description.fill("After the edit.");
      await expect(save).toBeEnabled();
      await save.click();

      // Saved in place: still on the skill's page, and nothing left to write.
      await expect(save).toBeDisabled();
      await expect(page).toHaveURL(new RegExp(`/skills/${skillId}$`));

      // And the change is the skill's, not just the form's.
      await expect
        .poll(async () => (await readSkill(page, skillId)).description)
        .toBe("After the edit.");
    } finally {
      await page.request.delete(`${UI_BASE_URL}/api/skills/${skillId}`);
    }
  });

  test("lands an old edit link on the skill's page", async ({
    page,
    makeRandomString,
    goToPage,
  }) => {
    const name = makeRandomString(8, "redirected").toLowerCase();
    const skillId = await createSkill(
      page,
      manifest(name, "Reached by an old link.", "Instructions."),
    );

    try {
      // `?step=access` named the wizard's second half; the form is one page
      // now, so the step is dropped and the page is what answers.
      await goToPage(page, `/skills/${skillId}/edit?step=access`);
      await expect(page).toHaveURL(new RegExp(`/skills/${skillId}$`));
      await expect(page.getByLabel("Description")).toHaveValue(
        "Reached by an old link.",
      );
    } finally {
      await page.request.delete(`${UI_BASE_URL}/api/skills/${skillId}`);
    }
  });
});

async function createSkill(page: Page, content: string): Promise<string> {
  const response = await page.request.post(`${UI_BASE_URL}/api/skills`, {
    data: { content },
  });
  await expectApiOk(response, "create skill");
  return ((await response.json()) as { id: string }).id;
}

async function readSkill(page: Page, skillId: string) {
  const response = await page.request.get(
    `${UI_BASE_URL}/api/skills/${skillId}`,
  );
  await expectApiOk(response, "read skill");
  return (await response.json()) as { description: string };
}

async function expectApiOk(response: APIResponse, label: string) {
  expect(
    response.ok(),
    `${label} failed (${response.status()}): ${await response.text()}`,
  ).toBeTruthy();
}
