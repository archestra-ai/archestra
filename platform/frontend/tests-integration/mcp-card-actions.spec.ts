import { makeCatalogItem } from "../src/mocks/data/catalog";
import { makeInstalledServer } from "../src/mocks/data/servers";
import { expect, test } from "./fixtures";

/**
 * The registry card's agent-usage hover card opens directly on top of the
 * card's action row. While it was pointer-interactive it absorbed the click:
 * moving the cursor down towards Reinstall crossed the agent count, the card
 * opened, and the button underneath did nothing.
 */
/** First-render budget, wide enough for the route's cold compile on CI. */
const COLD_COMPILE = 60_000;

test.describe("MCP registry card actions under the usage hover card", () => {
  const catalog = makeCatalogItem({
    id: "test-remote-usage-hover",
    name: "test-remote-usage-hover",
    serverType: "remote",
    serverUrl: "https://example.test/mcp",
    scope: "org",
    userConfig: null,
    toolCount: 19,
  });
  const flaggedInstall = makeInstalledServer({
    id: "test-server-usage-hover",
    name: "test-remote-usage-hover",
    catalogId: catalog.id,
    serverType: "remote",
    scope: "personal",
    reinstallRequired: true,
    reinstallReason: "restart",
    users: ["test-user-admin"],
    assignedAgents: [
      { id: "agent-1", name: "Agent One" },
      { id: "agent-2", name: "Agent Two" },
      // biome-ignore lint/suspicious/noExplicitAny: only id/name are rendered
    ] as any,
  });

  test.beforeEach(async ({ mswControl }) => {
    await mswControl.use({
      method: "get",
      url: "/api/internal_mcp_catalog",
      body: [catalog],
    });
    await mswControl.use({
      method: "get",
      url: "/api/mcp_server",
      body: [flaggedInstall],
    });
    await mswControl.use({
      method: "post",
      url: "/api/mcp_server/:id/reinstall",
      body: { ...flaggedInstall, reinstallRequired: false },
    });
  });

  test("the open hover card does not swallow the Reinstall click", async ({
    page,
    mcpRegistryPage,
  }) => {
    await mcpRegistryPage.goto();
    // Whichever spec touches /mcp/registry first pays for the route's cold
    // compile under `next dev`, which on a loaded CI runner overruns the 30s
    // default. Only the first render needs the wider budget.
    await expect(mcpRegistryPage.heading).toBeVisible({
      timeout: COLD_COMPILE,
    });
    await expect(mcpRegistryPage.cardForCatalogItem(catalog.name)).toBeVisible({
      timeout: COLD_COMPILE,
    });

    const agentCount = page.getByTestId("mcp-server-agents-count");
    const reinstall = page.getByRole("button", { name: "Reinstall" });
    await expect(agentCount).toBeVisible();
    await expect(reinstall).toBeVisible();

    const box = await reinstall.boundingBox();
    if (!box) throw new Error("Reinstall button has no bounding box");

    // Walk the cursor the way a user does — down across the agent count, then
    // on to Reinstall — instead of `reinstall.click()`. Playwright's click
    // retries until the target is hittable, which waits out the hover card and
    // would pass with or without the fix; raw mouse events do not.
    await agentCount.hover();
    // The hover card must actually be open, or the click below proves nothing.
    const hoverCard = page.locator("[data-slot=hover-card-content]");
    await expect(hoverCard).toBeVisible();

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
      steps: 4,
    });
    await page.mouse.down();
    await page.mouse.up();

    // Before the fix the press landed on the popover and nothing opened.
    await expect(
      page.getByRole("dialog").filter({ hasText: "Reinstall Required" }),
    ).toBeVisible();
  });

  test("the agent count links through to the usage tab", async ({
    page,
    mcpRegistryPage,
  }) => {
    await mcpRegistryPage.goto();
    await expect(mcpRegistryPage.cardForCatalogItem(catalog.name)).toBeVisible({
      timeout: COLD_COMPILE,
    });

    // The hover card lost its footer link when it became non-interactive, so
    // the count itself has to carry the route to the full usage list.
    await expect(page.getByTestId("mcp-server-agents-count")).toBeVisible();
    await expect(
      page.locator(`a[href="/mcp/registry/${catalog.id}?tab=usage"]`),
    ).toBeVisible();
  });
});
