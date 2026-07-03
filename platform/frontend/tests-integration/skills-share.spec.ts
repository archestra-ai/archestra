import { makeUserPermissions } from "../src/mocks/data/auth";
import {
  activeShareLinkSeed,
  makeShareLinkCreateResult,
  shareableSkillsSeed,
  staleShareLinkSeed,
} from "../src/mocks/data/skill-share";
import { expect, test } from "./fixtures";

// The marketplace step only mounts for manual (non-script) clients; among the
// marketplace-capable ids that is exactly "generic" ("Any client"), so every
// test drives the step through it.
const STEP_URL = "/connection?clientId=generic";
const STEP_TITLE = "Install shared skills";

test.describe("Skills marketplace share step", () => {
  test.beforeEach(async ({ mswControl }) => {
    // the base skills seed is empty, which renders the "no skills" state
    await mswControl.use({
      method: "get",
      url: "/api/skills",
      body: shareableSkillsSeed,
    });
  });

  test("admin creates a link snapshotting all org skills and sees the install guide", async ({
    page,
  }) => {
    await page.goto(STEP_URL);
    await expect(page.getByText(STEP_TITLE)).toBeVisible();
    await expect(page.getByText("Snapshot 2 skills")).toBeVisible();

    // The default create handler (src/mocks/handlers.ts) returns 400 for any
    // payload whose skillIds differ from the two seeded org skills, so the
    // snippets appearing pins the request payload.
    await page.getByTestId("skills-marketplace-create").click();

    const snippets = page.getByTestId("skills-marketplace-snippets-generic");
    await expect(snippets).toBeVisible();
    await expect(snippets).toContainText(
      makeShareLinkCreateResult("created0").cloneUrl,
    );
  });

  test("the step is hidden for users without skill admin", async ({
    page,
    mswControl,
  }) => {
    await mswControl.use({
      method: "get",
      url: "/api/user/permissions",
      body: makeUserPermissions({ skill: ["read"] }),
    });

    await page.goto(STEP_URL);
    await expect(
      page.getByRole("heading", { name: "Select your client" }),
    ).toBeVisible();
    await expect(page.getByText(STEP_TITLE)).toBeHidden();
  });

  test("the step is hidden for clients without marketplace support", async ({
    page,
  }) => {
    await page.goto("/connection?clientId=n8n");
    await expect(
      page.getByRole("heading", { name: "Select your client" }),
    ).toBeVisible();
    await expect(page.getByText(STEP_TITLE)).toBeHidden();
  });

  test("an existing active link is not rotated on load", async ({
    page,
    mswControl,
  }) => {
    await mswControl.use({
      method: "get",
      url: "/api/skill-share-links",
      body: { links: [activeShareLinkSeed] },
    });

    await page.goto(STEP_URL);
    // the token-bearing URL is shown exactly once at creation; an existing
    // link must come up hidden, behind an explicit refresh
    await expect(
      page.getByRole("button", { name: "Refresh to reveal URL" }),
    ).toBeVisible();
    await expect(
      page.getByText("The clone URL is only shown once at creation", {
        exact: false,
      }),
    ).toBeVisible();

    // an auto-fired rotation would hit the default rotate handler (whose
    // payload matches this seed) and reveal snippets — give a would-be late
    // response time to arrive before the negative assertion
    await page.waitForTimeout(500);
    await expect(
      page.getByTestId("skills-marketplace-snippets-generic"),
    ).toBeHidden();
  });

  test("refresh rotates via the rotate endpoint, forwarding the link's expiresAt", async ({
    page,
    mswControl,
  }) => {
    await mswControl.use({
      method: "get",
      url: "/api/skill-share-links",
      body: { links: [activeShareLinkSeed] },
    });

    await page.goto(STEP_URL);
    // The default rotate handler returns 400 unless the request targets the
    // seeded link's id AND forwards its exact expiresAt and skill set, so the
    // new URL appearing pins the rotation payload.
    await page.getByTestId("skills-marketplace-rotate").click();

    const snippets = page.getByTestId("skills-marketplace-snippets-generic");
    await expect(snippets).toBeVisible();
    await expect(snippets).toContainText(
      makeShareLinkCreateResult("rotated0").cloneUrl,
    );
  });

  test("revoke happens only after explicit confirmation", async ({
    page,
    mswControl,
  }) => {
    await mswControl.use({
      method: "get",
      url: "/api/skill-share-links",
      body: { links: [activeShareLinkSeed] },
    });

    await page.goto(STEP_URL);
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(
      page.getByText("Revoke and block all existing clones?"),
    ).toBeVisible();

    await page.getByTestId("skills-marketplace-confirm-revoke").click();
    // the mutation's success toast confirms the DELETE round trip completed
    await expect(page.getByText("Share link revoked")).toBeVisible();
  });

  test("a link covering fewer skills than the org now has shows the stale notice", async ({
    page,
    mswControl,
  }) => {
    await mswControl.use({
      method: "get",
      url: "/api/skill-share-links",
      body: { links: [staleShareLinkSeed] },
    });

    await page.goto(STEP_URL);
    await expect(
      page.getByText("The marketplace covers 1 of 2 current skills", {
        exact: false,
      }),
    ).toBeVisible();
  });
});
