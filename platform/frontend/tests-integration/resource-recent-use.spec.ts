import {
  makeAgent,
  makeAgentCatalog,
  makeAgentsList,
} from "../src/mocks/data/agents";
import { expect, test } from "./fixtures";

for (const path of ["/agents", "/mcp/gateways"]) {
  test(`${path} keeps recent-use ordering across pages and navigation, with explicit sort overrides`, async ({
    page,
    mswControl,
  }) => {
    const catalog = path === "/agents";
    const endpoint = catalog ? "/api/agent-catalog" : "/api/agents";
    const recent = makeAgent({
      id: "recent",
      name: "Recently used",
      agentType: catalog ? "agent" : "mcp_gateway",
      lastUsedAt: "2026-10-20T00:00:00.000Z",
    });
    const unused = makeAgent({
      id: "unused",
      name: "Unused resource",
      agentType: recent.agentType,
      lastUsedAt: null,
    });
    const response = (agents: (typeof recent)[], total = 11, offset = 0) => {
      const result = catalog
        ? makeAgentCatalog({ agents, total })
        : makeAgentsList({ agents, pagination: { total } });
      return { ...result, pagination: { ...result.pagination, offset } };
    };
    await mswControl.registerMany([
      { method: "get", url: endpoint, body: response([], 0) },
      {
        method: "get",
        url: endpoint,
        query: {
          pinned: "false",
          sortBy: "lastUsedAt",
          sortDirection: "desc",
          offset: "0",
        },
        body: response([recent]),
      },
      {
        method: "get",
        url: endpoint,
        query: {
          pinned: "false",
          sortBy: "lastUsedAt",
          sortDirection: "desc",
          offset: "10",
        },
        body: response([unused], 11, 10),
      },
      {
        method: "get",
        url: endpoint,
        query: {
          pinned: "false",
          sortBy: "name",
          sortDirection: "asc",
          offset: "0",
        },
        body: response([unused], 1),
      },
    ]);
    await page.goto(path);
    await expect(
      page.getByRole("row", { name: /Recently used/ }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Go to next page", exact: true })
      .click();
    await expect(
      page.getByRole("row", { name: /Unused resource/ }),
    ).toBeVisible();
    await expect(page).toHaveURL(/page=2/);
    await page.goto(`${path}?sortBy=name&sortDirection=asc`);
    await expect(
      page.getByRole("row", { name: /Unused resource/ }),
    ).toBeVisible();
    await page.goto(path);
    await expect(
      page.getByRole("row", { name: /Recently used/ }),
    ).toBeVisible();
  });
}
