import { makeAgent, makeAgentsList } from "../src/mocks/data/agents";
import { expect, test } from "./fixtures";

const personalGateway = makeAgent({
  id: "test-personal-gateway",
  name: "Personal test gateway",
  agentType: "mcp_gateway",
});

test.describe("MCP Gateways list when every gateway is pinned", () => {
  test.beforeEach(async ({ mswControl }) => {
    await mswControl.registerMany([
      {
        method: "get",
        url: "/api/mcp-gateways/default",
        body: personalGateway,
        // Resolves after the list, as it can in a real load: the gateway must
        // still never be drawn as a table row first.
        delayMs: 800,
      },
      {
        method: "get",
        url: "/api/agents",
        query: { pinned: "true" },
        body: makeAgentsList(),
      },
    ]);
  });

  test("shows the personal gateway as a tile with no empty table under it", async ({
    page,
    mswControl,
  }) => {
    await mswControl.use({
      method: "get",
      url: "/api/agents",
      query: { pinned: "false" },
      body: makeAgentsList({ agents: [personalGateway] }),
    });
    await page.addInitScript((name) => {
      const flags = window as unknown as { gatewayDrawnAsRow?: boolean };
      flags.gatewayDrawnAsRow = false;
      new MutationObserver(() => {
        for (const row of document.querySelectorAll("tbody tr")) {
          if (row.textContent?.includes(name)) flags.gatewayDrawnAsRow = true;
        }
      }).observe(document, { childList: true, subtree: true });
    }, personalGateway.name);

    await page.goto("/mcp/gateways");

    await expect(page.getByText("No other gateways yet")).toBeVisible();
    await expect(
      page.getByRole("link", { name: personalGateway.name }),
    ).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(0);
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { gatewayDrawnAsRow?: boolean })
            .gatewayDrawnAsRow,
      ),
    ).toBe(false);
  });

  test("lists the other gateways in the table", async ({
    page,
    mswControl,
  }) => {
    const teamGateway = makeAgent({
      id: "test-team-gateway",
      name: "Team test gateway",
      agentType: "mcp_gateway",
      scope: "org",
    });
    await mswControl.use({
      method: "get",
      url: "/api/agents",
      query: { pinned: "false" },
      body: makeAgentsList({ agents: [personalGateway, teamGateway] }),
    });

    await page.goto("/mcp/gateways");

    await expect(
      page.getByRole("row", { name: new RegExp(teamGateway.name) }),
    ).toBeVisible();
    await expect(page.getByText("No other gateways yet")).toHaveCount(0);
  });
});
