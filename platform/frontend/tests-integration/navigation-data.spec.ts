import { makeAgent, makeAgentsList } from "../src/mocks/data/agents";
import { expect, test } from "./fixtures";

test("the default Agents view uses its server list through hydration", async ({
  page,
  mswControl,
}) => {
  await mswControl.use({
    method: "get",
    url: "/api/agents",
    body: makeAgentsList({
      agents: [makeAgent({ name: "Server-rendered agent" })],
    }),
  });
  const clientListRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/agents")
      clientListRequests.push(request.url());
  });
  await page.goto("/agents");
  await expect(
    page.getByText("Server-rendered agent", { exact: true }),
  ).toBeVisible();
  // A real interaction establishes that hydration finished. Before the fix,
  // mounting the default visibility filter issued a redundant client GET.
  await page.getByRole("button", { name: "View as table" }).click();
  await expect(page.getByRole("table")).toBeVisible();
  expect(clientListRequests).toEqual([]);
});
