import { makeCatalogItem } from "../src/mocks/data/catalog";
import { expect, test } from "./fixtures";

/**
 * Deleting a server from its own detail route leaves the route mounted while
 * the client-side navigation back to the registry resolves. The delete
 * invalidates the catalog list, so the refetch lands inside that window and
 * the page's `item` is gone while the page is still on screen — which used to
 * render its "Server not found" empty state, flashing a 404 for a delete that
 * had just succeeded.
 *
 * The overrides below make that ordering deterministic: the list refetch
 * answers `[]` from the in-browser worker (microseconds) while the navigation
 * still has to fetch a route payload from `next dev`, so a regression here
 * fails rather than races.
 */

/** First-render budget, wide enough for the route's cold compile on CI. */
const COLD_COMPILE = 60_000;

const catalog = makeCatalogItem({
  id: "test-catalog-delete-flash",
  name: "delete-flash",
  description: "Deleted from its detail page.",
  serverType: "remote",
  serverUrl: "https://example.test/mcp",
  scope: "org",
});

test.describe("MCP server detail — delete", () => {
  test.beforeEach(async ({ mswControl }) => {
    await mswControl.use({
      method: "get",
      url: "/api/internal_mcp_catalog",
      body: [catalog],
    });
    await mswControl.use({ method: "get", url: "/api/mcp_server", body: [] });
  });

  test("returns to the registry without flashing a not-found page", async ({
    page,
    mswControl,
  }) => {
    await page.goto(`/mcp/registry/${catalog.id}`);
    await expect(page.getByRole("heading", { name: catalog.name })).toBeVisible(
      { timeout: COLD_COMPILE },
    );

    await mswControl.use({
      method: "delete",
      url: "/api/internal_mcp_catalog/:id",
      body: { success: true },
    });
    // The list the detail page reads its item from. Empty from here on, which
    // is what the post-delete invalidation refetches.
    await mswControl.use({
      method: "get",
      url: "/api/internal_mcp_catalog",
      body: [],
    });

    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    const confirm = page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete" });
    await expect(confirm).toBeVisible();

    // Polling with expect() would only sample the transition; a regression
    // lasts a few hundred milliseconds and could slip between two checks.
    // Watch every mutation instead, so any render of the empty state is
    // recorded even if it is painted and replaced between assertions.
    await page.evaluate(() => {
      window.__notFoundSeen = false;
      const check = () => {
        if (document.body.innerText.includes("Server not found")) {
          window.__notFoundSeen = true;
        }
      };
      new MutationObserver(check).observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
      });
      check();
    });

    await confirm.click();

    await expect(page).toHaveURL(/\/mcp\/registry$/);
    await expect(
      page.getByRole("heading", { name: "MCP Registry" }),
    ).toBeVisible();
    expect(await page.evaluate(() => window.__notFoundSeen)).toBe(false);
  });
});

declare global {
  interface Window {
    __notFoundSeen?: boolean;
  }
}
