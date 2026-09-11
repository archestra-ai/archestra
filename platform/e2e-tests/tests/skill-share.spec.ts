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

const STATIC_MARKETPLACE_PATH = "/skills/marketplace.git";

test.describe("Skills marketplace step on /connection", () => {
  test.setTimeout(90_000);

  test("admin creates a marketplace link covering all org skills", async ({
    page,
    makeRandomString,
    goToPage,
  }) => {
    const skillName = makeRandomString(8, "share-skill").toLowerCase();
    const skillId = await createSkillViaApi(page, skillName);
    let createdLinkId: string | null = null;

    try {
      await goToPage(page, "/connection");
      await page.waitForLoadState("domcontentloaded");

      // Pick "Any Client" so the generic (client-agnostic) snippets render, and
      // the "Install shared skills" step expands so the share-link disclosure
      // mounts.
      //
      // The client tile is server-rendered, so a click that lands before React
      // hydration attaches its onClick handler is silently lost — Playwright
      // reports the click as successful (the SSR button is visible/enabled), but
      // no client is selected, the skills step never opens, and the create
      // button never renders. A longer timeout can't recover it: once the click
      // is dropped the state stays unset for the life of the page. Selecting a
      // client is idempotent (it sets, never toggles), so retry the click until
      // the step has opened and the create button is visible.
      const anyClient = page
        .getByRole("button", { name: /Any Client/i })
        .first();
      const shareLinkToggle = page.getByTestId(
        "skills-marketplace-share-link-toggle",
      );
      await expect(async () => {
        await anyClient.click();
        await expect(shareLinkToggle).toBeVisible({ timeout: 3_000 });
      }).toPass({ timeout: 20_000 });

      // The static marketplace is the primary path and needs no minting: its
      // URL is on the page as soon as the step opens.
      await expect(page.getByTestId("skills-marketplace-static")).toContainText(
        STATIC_MARKETPLACE_PATH,
      );

      // Share links are the admin-only snapshot alternative, folded away.
      await shareLinkToggle.click();
      const createButton = page.getByTestId("skills-marketplace-create");
      await expect(createButton).toBeVisible();

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

      // "Any client" renders the generic snippets, which reference the
      // freshly-issued clone URL.
      const generic = page.getByTestId("skills-marketplace-snippets-generic");
      await expect(generic).toBeVisible();
      await expect(generic).toContainText(createBody.cloneUrl);
    } finally {
      if (createdLinkId) {
        await page.request
          .delete(`${UI_BASE_URL}/api/skill-share-links/${createdLinkId}`)
          .catch(() => undefined);
      }
      await deleteSkillViaApi(page, skillId);
    }
  });
  test("the static marketplace serves the caller's own token, and challenges without one", async ({
    page,
    makeRandomString,
  }) => {
    const skillName = makeRandomString(8, "static-skill").toLowerCase();
    const skillId = await createSkillViaApi(page, skillName);

    try {
      const refsUrl = `${UI_BASE_URL}${STATIC_MARKETPLACE_PATH}/info/refs?service=git-upload-pack`;

      // No credential: git must be told to ask for one.
      const anonymous = await page.request.get(refsUrl, {
        headers: { authorization: "" },
      });
      expect(anonymous.status()).toBe(401);
      expect(anonymous.headers()["www-authenticate"]).toContain("Basic");

      // The caller's own personal token, exactly as git sends it after the
      // password prompt.
      const token = await fetchPersonalToken(page);
      const authorized = await page.request.get(refsUrl, {
        headers: {
          authorization: `Basic ${Buffer.from(`archestra:${token}`).toString("base64")}`,
        },
      });
      expect(authorized.status()).toBe(200);
      expect(authorized.headers()["content-type"]).toBe(
        "application/x-git-upload-pack-advertisement",
      );
      expect(await authorized.text()).toContain("refs/heads/main");
    } finally {
      await deleteSkillViaApi(page, skillId);
    }
  });
});

async function fetchPersonalToken(page: Page): Promise<string> {
  // ensures the token exists before reading its value
  await expectApiOk(
    await page.request.get(`${UI_BASE_URL}/api/user-tokens/me`),
    "ensure personal token",
  );
  const response = await page.request.get(
    `${UI_BASE_URL}/api/user-tokens/me/value`,
  );
  await expectApiOk(response, "read personal token");
  const body = (await response.json()) as { value: string };
  return body.value;
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
