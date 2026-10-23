import { makeAgent, makeAgentCatalog } from "../src/mocks/data/agents";
import { expect, test } from "./fixtures";

test("the default Agents view uses its server list through hydration", async ({
  page,
  mswControl,
}) => {
  await mswControl.use({
    method: "get",
    url: "/api/agent-catalog",
    query: { pinned: "false" },
    body: makeAgentCatalog({
      agents: [makeAgent({ name: "Server-rendered agent" })],
    }),
  });
  await mswControl.use({
    method: "get",
    url: "/api/agent-catalog",
    query: { pinned: "true" },
    body: makeAgentCatalog(),
  });
  const clientListRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/agent-catalog")
      clientListRequests.push(request.url());
  });
  await page.goto("/agents");
  await expect(
    page.getByText("Server-rendered agent", { exact: true }),
  ).toBeVisible();
  // A real interaction establishes that hydration finished. Before the fix,
  // mounting the default visibility filter issued a redundant client GET.
  const select = page.getByRole("checkbox", {
    name: "Select Server-rendered agent",
  });
  await select.click();
  await expect(select).toBeChecked();
  expect(clientListRequests).toEqual([]);
});

test("hovering the sidebar Agents link loads the page's code without requesting the catalog", async ({
  page,
}) => {
  await page.goto("/mcp/registry");
  const link = page.locator('a[href="/agents"]').first();
  await expect(link).toBeVisible();
  const scripts: string[] = [];
  const catalogRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/agent-catalog") catalogRequests.push(url.href);
    if (request.resourceType() === "script") scripts.push(url.pathname);
  });

  await link.hover();

  await expect.poll(() => scripts.length).toBeGreaterThan(0);
  // Long enough for a request the hover would cause to have been sent.
  await page.waitForTimeout(1000);
  expect(catalogRequests).toEqual([]);
});
