import { makeCatalogItem } from "@/mocks/data/catalog";
import { makeInstalledServer } from "@/mocks/data/servers";
import { expect, test } from "./fixtures";

/**
 * The registry card packs a scope badge, two counts, a deployment state and a
 * stack of connection avatars onto one line, and the table packs a scope badge
 * into a 140px column. Both used to lay their contents out past their own edge,
 * where it painted over the neighbouring card or the next column.
 *
 * These assert the invariant rather than the styling: nothing inside a card may
 * lay out past the card, and no badge past its cell. A class-name assertion
 * would have passed throughout the bug — the classes were reasonable, the
 * arithmetic was not.
 *
 * The shapes below are drawn from the widest real catalog entries: an org card
 * with seven distinct connections, a card owned by someone with a long name, a
 * card scoped to two teams, and a connection needing re-authentication. Names
 * are invented; only the shapes are borrowed.
 */

const LONG_NAME = "Bartholomew Featherstonehaugh";

const CATALOG = [
  makeCatalogItem({
    id: "cat-org-crowded",
    name: "org-crowded",
    description: "Org-scoped server reached through many separate connections.",
    scope: "org",
    serverType: "local",
    toolCount: 136,
  }),
  makeCatalogItem({
    id: "cat-long-author",
    name: "long-author",
    description: "Personal server whose owner has a long display name.",
    scope: "personal",
    authorId: "user-other",
    authorName: LONG_NAME,
    serverType: "local",
    toolCount: 51,
  }),
  makeCatalogItem({
    id: "cat-two-teams",
    name: "two-teams",
    description: "Server shared with two teams.",
    scope: "team",
    teams: [
      { id: "team-eng", name: "Engineering", level: "use" },
      { id: "team-con", name: "Consultants", level: "use" },
    ],
    toolCount: 14,
  }),
  makeCatalogItem({
    id: "cat-reauth",
    name: "needs-reauth",
    description: "Remote server whose OAuth connection has gone stale.",
    scope: "org",
    serverType: "remote",
    oauthConfig: {
      name: "example",
      server_url: "https://example.test",
      client_id: "example-client",
      redirect_uris: ["https://example.test/callback"],
      scopes: [],
      default_scopes: [],
      supports_resource_metadata: false,
    },
    toolCount: 22,
  }),
  makeCatalogItem({
    id: "cat-not-installed",
    name: "not-installed",
    description: "Catalog server that has not been installed.",
    scope: "org",
    serverType: "local",
    toolCount: 3,
  }),
];

// Seven distinct connections on the crowded card: one org-wide plus six
// owners, which is what drives the avatar stack to its widest.
const CROWDED_SERVERS = [
  makeInstalledServer({
    id: "srv-org",
    name: "org-crowded-org",
    catalogId: "cat-org-crowded",
    scope: "org",
    ownerId: "user-admin",
  }),
  ...Array.from({ length: 6 }, (_, i) =>
    makeInstalledServer({
      id: `srv-crowded-${i}`,
      name: `org-crowded-${i}`,
      catalogId: "cat-org-crowded",
      scope: "personal",
      ownerId: `user-${i}`,
      ownerEmail: `person${i}@example.test`,
    }),
  ),
];

const SERVERS = [
  ...CROWDED_SERVERS,
  makeInstalledServer({
    id: "srv-long-author",
    name: "long-author",
    catalogId: "cat-long-author",
    ownerId: "user-other",
    ownerEmail: "someone@example.test",
  }),
  makeInstalledServer({
    id: "srv-two-teams",
    name: "two-teams",
    catalogId: "cat-two-teams",
    scope: "team",
    teamId: "team-eng",
    teamDetails: {
      teamId: "team-eng",
      name: "Engineering",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }),
  makeInstalledServer({
    id: "srv-reauth",
    name: "needs-reauth",
    catalogId: "cat-reauth",
    serverType: "remote",
    ownerId: "test-user-admin",
    ownerEmail: "admin@example.test",
    oauthRefreshError: "refresh_failed",
  }),
];

async function seed(mswControl: {
  use: (o: { method: "get"; url: string; body: unknown }) => Promise<void>;
}) {
  await mswControl.use({
    method: "get",
    url: "/api/internal_mcp_catalog",
    body: CATALOG,
  });
  await mswControl.use({
    method: "get",
    url: "/api/mcp_server",
    body: SERVERS,
  });
}

test.describe("MCP Registry layout", () => {
  // The narrowest the grid will ever make a card, which is where the row has
  // the least room and the old layout broke worst.
  test.use({ viewport: { width: 1024, height: 900 } });

  test("no card lays its contents out past its own edge", async ({
    mcpRegistryPage,
    mswControl,
    page,
  }) => {
    await seed(mswControl);
    await mcpRegistryPage.goto();
    await expect(mcpRegistryPage.serverCards.first()).toBeVisible();

    const spills = await page.evaluate(() => {
      const out: Array<{ card: string; by: number; text: string }> = [];
      for (const card of document.querySelectorAll<HTMLElement>(
        '[data-testid^="mcp-server-card-"]',
      )) {
        const edge = card.getBoundingClientRect().right;
        for (const node of card.querySelectorAll<HTMLElement>("*")) {
          // Zero-size nodes carry no visible content to spill.
          const r = node.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          const by = Math.round(r.right - edge);
          if (by > 0) {
            out.push({
              card: card.getAttribute("data-testid") ?? "?",
              by,
              text: (node.textContent ?? "").replace(/\s+/g, " ").slice(0, 40),
            });
          }
        }
      }
      return out;
    });

    expect(spills).toEqual([]);
  });

  test("keeps cards at a usable width below the supported viewport", async ({
    mcpRegistryPage,
    mswControl,
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await seed(mswControl);
    await mcpRegistryPage.goto();

    const card = mcpRegistryPage.cardForCatalogItem("org-crowded");
    await expect(card).toBeVisible();

    const box = await card.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(320);
    expect(
      await page
        .locator("main")
        .evaluate((main) => main.scrollWidth > main.clientWidth),
    ).toBe(true);
  });

  test("a card names the team scope instead of listing every team", async ({
    mcpRegistryPage,
    mswControl,
  }) => {
    await seed(mswControl);
    await mcpRegistryPage.goto();

    const card = mcpRegistryPage.cardForCatalogItem("two-teams");
    await expect(card).toBeVisible();

    // The roster belongs on the detail page; the card has one line to spend.
    await expect(card.getByText("2 teams")).toBeVisible();
    await expect(card.getByText("Engineering", { exact: true })).toHaveCount(0);
    await expect(card.getByText("Consultants", { exact: true })).toHaveCount(0);
  });

  test("no scope badge lays out past its table cell", async ({
    mcpRegistryPage,
    mswControl,
    page,
  }) => {
    await seed(mswControl);
    await mcpRegistryPage.goto();
    await expect(mcpRegistryPage.serverCards.first()).toBeVisible();

    await page.getByRole("button", { name: "View as table" }).click();
    await expect(page.locator("table").first()).toBeVisible();

    const spills = await page.evaluate(() => {
      const out: Array<{ by: number; text: string; cell: number }> = [];
      for (const cell of document.querySelectorAll<HTMLElement>("td")) {
        const edge = cell.getBoundingClientRect();
        for (const badge of cell.querySelectorAll<HTMLElement>(
          '[data-slot="badge"]',
        )) {
          const r = badge.getBoundingClientRect();
          const by = Math.round(r.right - edge.right);
          if (by > 0) {
            out.push({
              by,
              cell: Math.round(edge.width),
              text: (badge.textContent ?? "").trim().slice(0, 40),
            });
          }
        }
      }
      return out;
    });

    expect(spills).toEqual([]);
  });

  test("mounts only the active registry layout", async ({
    mcpRegistryPage,
    mswControl,
    page,
  }) => {
    await seed(mswControl);
    await mcpRegistryPage.goto();
    await expect(mcpRegistryPage.serverCards.first()).toBeVisible();

    await page.getByRole("button", { name: "View as table" }).click();
    await expect(page.locator("table")).toBeVisible();
    await expect(mcpRegistryPage.serverCards).toHaveCount(0);

    await page.getByRole("button", { name: "View as cards" }).click();
    await expect(mcpRegistryPage.serverCards.first()).toBeVisible();
    await expect(page.locator("table")).toHaveCount(0);
  });

  test("filters local registry search without a debounce pause", async ({
    mcpRegistryPage,
    mswControl,
    page,
  }) => {
    await seed(mswControl);
    await mcpRegistryPage.goto();

    await page
      .getByRole("textbox", { name: "Search MCP servers by name" })
      .fill("not-installed");

    await expect(mcpRegistryPage.cardForCatalogItem("org-crowded")).toHaveCount(
      0,
      { timeout: 200 },
    );
    await expect(
      mcpRegistryPage.cardForCatalogItem("not-installed"),
    ).toBeVisible();
  });

  test("keeps foreign personal servers out of All and reaches them through Other users", async ({
    mcpRegistryPage,
    mswControl,
    page,
  }) => {
    await seed(mswControl);
    await mcpRegistryPage.goto();

    await expect(mcpRegistryPage.cardForCatalogItem("long-author")).toHaveCount(
      0,
    );

    await page.getByRole("combobox", { name: "Filter by type" }).click();
    await page.getByRole("option", { name: "Personal" }).click();
    await page.getByRole("combobox", { name: "Filter by owner" }).click();
    await page.getByRole("option", { name: "Other users" }).click();

    await expect(
      mcpRegistryPage.cardForCatalogItem("long-author"),
    ).toBeVisible();
    await expect(page.getByText(LONG_NAME)).toBeVisible();
  });

  test("keeps visibly flagged cards in the flat registry", async ({
    mcpRegistryPage,
    mswControl,
  }) => {
    await seed(mswControl);
    await mcpRegistryPage.goto();

    await expect(
      mcpRegistryPage.cardForCatalogItem("needs-reauth"),
    ).toBeVisible();
  });

  test("updates table bulk actions without moving the reserved toolbar rail", async ({
    mcpRegistryPage,
    mswControl,
    page,
  }) => {
    await seed(mswControl);
    await mcpRegistryPage.goto();
    await page.getByRole("button", { name: "View as table" }).click();

    const table = page.locator("table").first();
    await expect(table).toBeVisible();
    const before = await table.boundingBox();
    expect(before).not.toBeNull();
    const bulkBar = page.locator('[data-slot="bulk-actions-bar"]');
    await expect(bulkBar).toBeVisible();

    await page.getByRole("checkbox", { name: "Select org-crowded" }).click();

    await expect(
      bulkBar
        .locator('[aria-hidden="true"]')
        .filter({ hasText: "1 server selected" }),
    ).toBeVisible();
    const after = await table.boundingBox();
    expect(after?.y).toBe(before?.y);
  });

  test("offers only Uninstall as a table bulk action", async ({
    mcpRegistryPage,
    mswControl,
    page,
  }) => {
    await seed(mswControl);
    await mcpRegistryPage.goto();
    await page.getByRole("button", { name: "View as table" }).click();
    await expect(
      page.getByRole("checkbox", { name: "Select not-installed" }),
    ).toBeDisabled();
    await page.getByRole("checkbox", { name: "Select org-crowded" }).click();

    const bulkBar = page.locator('[data-slot="bulk-actions-bar"]');
    await expect(
      bulkBar.getByRole("button", { name: "Uninstall" }),
    ).toBeVisible();
    await expect(bulkBar.getByRole("button", { name: /^Install/ })).toHaveCount(
      0,
    );
  });
});
