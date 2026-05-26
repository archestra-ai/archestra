import type { APIResponse, Page } from "@playwright/test";
import { UI_BASE_URL } from "../consts";
import { expect, test } from "../fixtures";

const SKILL_MANIFEST = (name: string) =>
  [
    "---",
    `name: ${name}`,
    "description: A skill shared via Archestra for e2e coverage.",
    "---",
    "",
    `# ${name}`,
    "Walk through the share flow without invoking the CLI binaries.",
  ].join("\n");

const PUBLIC_CLONE_URL_REGEX =
  /^https?:\/\/[^/]+\/skills\/m\/[A-Za-z0-9_-]+\/repo\.git$/;

test.describe("Skill share dialog", () => {
  test.setTimeout(90_000);

  test("admin can create a share link from the skill row action", async ({
    page,
    makeRandomString,
    goToPage,
  }) => {
    const featuresEnabled = await skillsFeatureEnabled(page);
    test.skip(
      !featuresEnabled,
      "ARCHESTRA_AGENTS_SKILLS_ENABLED is off in this environment",
    );

    const skillName = makeRandomString(8, "share-skill").toLowerCase();
    const skillId = await createSkillViaApi(page, skillName);

    try {
      await goToPage(page, "/agents/skills");
      await page.waitForLoadState("domcontentloaded");

      const row = page.locator("tr").filter({ hasText: skillName }).first();
      await expect(row).toBeVisible({ timeout: 20_000 });

      await row.getByRole("button", { name: /^Share$/i }).click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText(/Share "/i)).toBeVisible();

      // Step 1 → Step 2: pick client, click Continue.
      await dialog.getByTestId("share-client-claude-code").click();
      await dialog.getByRole("button", { name: /Continue/i }).click();

      // Step 2 → Step 3: create the share link.
      await expect(dialog.getByText(/Label \(optional\)/i)).toBeVisible();
      const createResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes("/api/skill-share-links") &&
          response.request().method() === "POST",
        { timeout: 20_000 },
      );
      await dialog.getByRole("button", { name: /Create share link/i }).click();
      const createResponse = await createResponsePromise;
      expect(createResponse.ok()).toBeTruthy();

      // Step 3: install snippets visible, clone URL has the expected shape.
      const snippets = dialog.getByTestId("share-snippets-claude-code");
      await expect(snippets).toBeVisible();
      const claudeAddSnippet = snippets
        .locator("code")
        .filter({ hasText: /claude plugin marketplace add/ });
      await expect(claudeAddSnippet).toBeVisible();
      const claudeAddText = (await claudeAddSnippet.textContent()) ?? "";
      const cloneUrl = claudeAddText
        .replace(/^claude plugin marketplace add\s+/, "")
        .trim();
      expect(cloneUrl).toMatch(PUBLIC_CLONE_URL_REGEX);

      // The /plugin install snippet must reference the same skill slug.
      const pluginInstallSnippet = snippets
        .locator("code")
        .filter({ hasText: /\/plugin install/ });
      const pluginInstallText =
        (await pluginInstallSnippet.textContent()) ?? "";
      expect(pluginInstallText).toContain(`/plugin install ${skillName}@`);

      // Close the dialog cleanly.
      await dialog.getByRole("button", { name: /^Done$/i }).click();
      await expect(dialog).not.toBeVisible({ timeout: 10_000 });
    } finally {
      await deleteSkillViaApi(page, skillId);
    }
  });
});

async function skillsFeatureEnabled(page: Page): Promise<boolean> {
  const response = await page.request.get(`${UI_BASE_URL}/api/config`);
  if (!response.ok()) return false;
  const body = (await response.json()) as {
    features?: { agentSkillsEnabled?: boolean };
  };
  return body.features?.agentSkillsEnabled === true;
}

async function createSkillViaApi(
  page: Page,
  skillName: string,
): Promise<string> {
  const response = await page.request.post(`${UI_BASE_URL}/api/skills`, {
    data: { content: SKILL_MANIFEST(skillName) },
  });
  await expectApiOk(response, "create skill");
  const body = (await response.json()) as { id: string };
  return body.id;
}

async function deleteSkillViaApi(page: Page, skillId: string): Promise<void> {
  // best-effort cleanup; do not fail the test if the row was already removed
  await page.request
    .delete(`${UI_BASE_URL}/api/skills/${skillId}`)
    .catch(() => undefined);
}

async function expectApiOk(
  response: APIResponse,
  label: string,
): Promise<void> {
  if (!response.ok()) {
    throw new Error(
      `${label} failed: ${response.status()} ${await response.text()}`,
    );
  }
}
