import { makeAgent } from "../src/mocks/data/agents";
import { makeOrganization } from "../src/mocks/data/organization";
import { expect, test } from "./fixtures";

test("ChatGPT setup stays separate from Codex and never prepares an installer or token", async ({
  page,
  mswControl,
}) => {
  await mswControl.registerMany([
    {
      method: "get",
      url: "/api/organization",
      body: makeOrganization({
        connectionDefaultMcpGatewayId: "chatgpt-gateway",
      }),
    },
    {
      method: "get",
      url: "/api/agents/chatgpt-gateway",
      body: makeAgent({
        id: "chatgpt-gateway",
        slug: "team-tools",
        name: "Team tools",
        agentType: "mcp_gateway",
      }),
    },
  ]);
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/(connection-setups|user-tokens)/.test(request.url()))
      mutations.push(request.url());
  });
  await page.goto("/connection?clientId=chatgpt");
  const plugins = page.getByRole("link", {
    name: "Open ChatGPT Plugins",
    exact: true,
  });
  await expect(plugins).toHaveAttribute("href", "https://chatgpt.com/plugins");
  await expect(page.getByText(/\/mcp\/team-tools$/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Download installer", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Copy", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Copy to clipboard", exact: true })
    .dblclick();
  await expect(
    page.getByRole("button", { name: /Choose what to include/ }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: /Codex$/ }).click();
  await expect(plugins).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Copy", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /ChatGPT$/ }).click();
  await expect(plugins).toBeVisible();
  await page.reload();
  await expect(plugins).toBeVisible();
  expect(mutations).toEqual([]);
});

test("ChatGPT explains missing gateway access without offering a broken connection", async ({
  page,
  mswControl,
}) => {
  await mswControl.use({
    method: "get",
    url: "/api/mcp-gateways/default",
    body: null,
  });
  await page.goto("/connection?clientId=chatgpt");
  await expect(
    page.getByText("No MCP gateway available", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open ChatGPT Plugins", exact: true }),
  ).toHaveCount(0);
});
