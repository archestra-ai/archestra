import type { APIRequestContext } from "@playwright/test";
import { makeUserPermissions } from "@/mocks/data/auth";
import { expect, test } from "./fixtures";
import type { MswControl } from "./helpers/msw-control";

/**
 * Studio navigation is one row per page, grouped under a section heading.
 * Before that, a section's landing page stood in for its siblings — one
 * "LLM Proxy" row covered Virtual Keys and OAuth Clients, one "Costs & Limits"
 * row covered both — so a page behind a tab had no name anywhere in the
 * sidebar and no way in from it.
 *
 * What these pin is the part that is easy to break silently: every page is
 * reachable and named, each row lights only for its own page (a prefix match
 * on `/llm/proxy` would light three rows at once), a group disappears with
 * its heading when the reader may open none of it, and Plugins stays out of
 * the list until the deployment turns plugins on.
 */

/** Rows of the studio nav, in order, as a reader sees them. */
const STUDIO_NAV = [
  "Agents",
  "Skills",
  "Messaging Channels",
  "MCP Registry",
  "MCP Gateways",
  "Guardrails",
  "LLM Proxy",
  "Virtual Keys",
  "OAuth Clients",
  "Model Providers",
  "Models",
  "Costs",
  "Limits",
  "Connectors",
  "Files",
  "Knowledge Bases",
  "Logs",
  "Settings",
];

/**
 * The primary nav group — the community links below it live in a group of
 * their own, and the two collapsed-rail-only rows are hidden while expanded.
 */
function studioNavRows(page: import("@playwright/test").Page) {
  return page.locator(
    '[data-slot="sidebar-content"] > [data-slot="sidebar-group"]:first-child a[data-sidebar="menu-button"]:visible',
  );
}

function sectionHeadings(page: import("@playwright/test").Page) {
  return page.getByRole("heading", { level: 2 });
}

/** Chip suffixes ("Skills\nNew") come from the row's badge, not its name. */
async function rowNames(page: import("@playwright/test").Page) {
  const texts = await studioNavRows(page).allInnerTexts();
  return texts.map((text) => text.split("\n")[0]);
}

async function setPermissions(
  { mswControl }: { mswControl: MswControl },
  overrides: Parameters<typeof makeUserPermissions>[0],
) {
  await mswControl.use({
    method: "get",
    url: "/api/user/permissions",
    body: makeUserPermissions(overrides),
  });
}

async function enablePlugins({
  mswControl,
  request,
}: {
  mswControl: MswControl;
  request: APIRequestContext;
}) {
  const config = await (
    await request.get("/internal-test/api/api/config")
  ).json();
  await mswControl.use({
    method: "get",
    url: "/api/config",
    body: { ...config, features: { ...config.features, plugins: true } },
  });
}

test.describe("studio sidebar navigation", () => {
  test("names every studio page under its section heading", async ({
    page,
  }) => {
    await page.goto("/agents");

    await expect(studioNavRows(page).first()).toBeVisible();
    expect(await rowNames(page)).toEqual(STUDIO_NAV);
    // Logs and Settings close the list without a heading: they belong to no
    // one section.
    expect(await sectionHeadings(page).allInnerTexts()).toEqual([
      "AGENTS",
      "MCP",
      "LLM",
      "KNOWLEDGE",
    ]);
  });

  test("lights only the row for the page that is open", async ({ page }) => {
    const active = page.locator(
      '[data-slot="sidebar-content"] a[data-active="true"]',
    );

    await page.goto("/llm/proxy/virtual-keys");
    await expect(active).toHaveText(/^Virtual Keys/);

    // The section's own landing page: still exactly one row, and not the one
    // a prefix match would have added.
    await page.goto("/llm/proxy");
    await expect(active).toHaveText(/^LLM Proxy/);
  });

  test("drops a row the reader may not open, and its heading with the last of them", async ({
    page,
    mswControl,
  }) => {
    await setPermissions(
      { mswControl },
      { llmVirtualKey: [], knowledgeSource: [] },
    );
    await page.goto("/agents");

    await expect(studioNavRows(page).first()).toBeVisible();
    const names = await rowNames(page);
    expect(names).not.toContain("Virtual Keys");
    // Its siblings are gated separately and stay.
    expect(names).toContain("OAuth Clients");
    // Every Knowledge row is gone, so the section is gone too.
    expect(names).not.toContain("Connectors");
    expect(await sectionHeadings(page).allInnerTexts()).not.toContain(
      "KNOWLEDGE",
    );
  });

  test("offers Plugins where the deployment enables plugins", async ({
    page,
    mswControl,
    request,
  }) => {
    // The default deployment has them off, which is what the full-list
    // assertion above is standing on.
    await enablePlugins({ mswControl, request });
    await page.goto("/agents");

    await expect(page.getByRole("link", { name: /^Plugins/ })).toBeVisible();
    expect(await rowNames(page)).toEqual([
      "Agents",
      "Skills",
      "Plugins",
      ...STUDIO_NAV.slice(2),
    ]);
  });
});
