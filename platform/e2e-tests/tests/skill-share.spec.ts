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

test.describe("Skills marketplace step on /connection", () => {
  test.setTimeout(90_000);

  test("admin creates a marketplace link covering all org skills", async ({
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
    let createdLinkId: string | null = null;

    try {
      await goToPage(page, "/connection");
      await page.waitForLoadState("domcontentloaded");

      // Pick "Any client" so both Claude Code and Codex snippets render.
      await page
        .getByRole("button", { name: /Any Client/i })
        .first()
        .click();

      // Expand the new "Share skills as a marketplace" step.
      await page
        .getByRole("button", {
          name: /Share skills as a marketplace/i,
        })
        .first()
        .click();

      const createButton = page.getByTestId("skills-marketplace-create");
      await expect(createButton).toBeVisible({ timeout: 20_000 });

      const createResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes("/api/skill-share-links") &&
          response.request().method() === "POST",
        { timeout: 20_000 },
      );
      await createButton.click();
      const createResponse = await createResponsePromise;
      expect(createResponse.ok()).toBeTruthy();
      const createBody = (await createResponse.json()) as {
        link: { id: string };
        cloneUrl: string;
        marketplaceName: string;
      };
      createdLinkId = createBody.link.id;
      expect(createBody.cloneUrl).toMatch(PUBLIC_CLONE_URL_REGEX);

      // The "Any client" picker shows both Claude Code and Codex snippets,
      // each referencing the freshly-issued clone URL.
      const claude = page.getByTestId(
        "skills-marketplace-snippets-claude-code",
      );
      const codex = page.getByTestId("skills-marketplace-snippets-codex");
      await expect(claude).toBeVisible();
      await expect(codex).toBeVisible();

      const claudeAdd = claude
        .locator("code")
        .filter({ hasText: /claude plugin marketplace add/ });
      await expect(claudeAdd).toBeVisible();
      const claudeAddText = (await claudeAdd.textContent()) ?? "";
      const cloneUrl = claudeAddText
        .replace(/^claude plugin marketplace add\s+/, "")
        .trim();
      expect(cloneUrl).toMatch(PUBLIC_CLONE_URL_REGEX);

      const codexAdd = codex
        .locator("code")
        .filter({ hasText: /codex plugin marketplace add/ });
      const codexAddText = (await codexAdd.textContent()) ?? "";
      expect(codexAddText).toContain(cloneUrl);
    } finally {
      if (createdLinkId) {
        await page.request
          .delete(`${UI_BASE_URL}/api/skill-share-links/${createdLinkId}`)
          .catch(() => undefined);
      }
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
