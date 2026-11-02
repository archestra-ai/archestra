import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { makeAgent } from "../src/mocks/data/agents";
import { makeOrganization } from "../src/mocks/data/organization";
import { makeSkillDetail } from "../src/mocks/data/skills";
import { expect, test } from "./fixtures";

const endpoint = "https://gateway.example.test/v1/mcp/team-tools";

// Exercise the deployment-configured public endpoint, as production does.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    let runtimeEnv: Record<string, string>;
    Object.defineProperty(window, "__ENV", {
      configurable: true,
      get: () => runtimeEnv,
      set: (value: Record<string, string>) => {
        runtimeEnv = {
          ...value,
          NEXT_PUBLIC_ARCHESTRA_API_BASE_URL: "https://gateway.example.test",
        };
      },
    });
  });
});

test("downloads MCP and skill resources in one archive without installer or token requests", async ({
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
    {
      method: "get",
      url: "/api/skills/skill-jira-task",
      body: makeSkillDetail("skill-jira-task"),
      delayMs: 300,
    },
  ]);
  await page.setViewportSize({ width: 375, height: 812 });
  const credentialRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/(connection-setups|user-tokens)/.test(request.url()))
      credentialRequests.push(request.url());
  });
  await page.goto("/connection?clientId=chatgpt");
  const button = page.getByRole("button", {
    name: "Download ChatGPT plugin",
    exact: true,
  });
  const checklist = page.getByRole("region", { name: "Connect", exact: true });
  await expect(checklist).toBeVisible();
  expect(
    await checklist.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  const downloaded = page.waitForEvent("download");
  await button.dblclick();
  const first = await downloaded;
  const path = await first.path();
  if (!path) throw new Error("No plugin archive downloaded");
  const zip = await JSZip.loadAsync(await readFile(path));
  const mcpFile = zip.file("mcp.json");
  if (!mcpFile) throw new Error("MCP configuration missing");
  const mcp = JSON.parse(await mcpFile.async("string"));
  expect(mcp.mcpServers.gateway.url).toBe(endpoint);
  expect(mcp.mcpServers.gateway.extensions["com.openai"].auth).toEqual({
    type: "oauth",
    client: { mode: "dcr" },
  });
  expect(zip.file("skills/jira-task/SKILL.md")).not.toBeNull();
  expect(zip.file("skills/jira-task/reference/fields.md")).not.toBeNull();
  await expect(
    page.getByRole("link", { name: "Open ChatGPT", exact: true }),
  ).toHaveAttribute("href", "codex://plugins");
  await expect(
    page.getByRole("link", { name: "Configure on web instead" }),
  ).toHaveAttribute("href", "https://chatgpt.com/plugins");
  expect(
    await checklist.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Download plugin again" }).click();
  const repeat = page.waitForEvent("download");
  await button.click();
  expect((await repeat).suggestedFilename()).toBe(first.suggestedFilename());
  await page.getByRole("button", { name: /Choose what to include/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("switch", { name: "Skills" }).uncheck();
  await page.keyboard.press("Escape");
  const toolsOnly = page.waitForEvent("download");
  await button.click();
  const toolsPath = await (await toolsOnly).path();
  if (!toolsPath) throw new Error("Tools archive missing");
  const toolsZip = await JSZip.loadAsync(await readFile(toolsPath));
  expect(
    Object.keys(toolsZip.files).some((name) => name.startsWith("skills/")),
  ).toBe(false);
  expect(credentialRequests).toEqual([]);
  await page.reload();
  await expect(button).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open ChatGPT", exact: true }),
  ).toHaveCount(0);
});

test("missing gateway removes download actions", async ({
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
    page.getByRole("button", { name: "Download ChatGPT plugin", exact: true }),
  ).toHaveCount(0);
});

test("failed skill access stops the archive and permits a clean retry", async ({
  page,
  mswControl,
}) => {
  await mswControl.use({
    method: "get",
    url: "/api/skills/skill-jira-task",
    status: 403,
    body: { error: "Forbidden", message: "Skill access was removed" },
    once: true,
  });
  await page.goto("/connection?clientId=chatgpt");
  const downloads: string[] = [];
  page.on("download", (download) =>
    downloads.push(download.suggestedFilename()),
  );
  const button = page.getByRole("button", {
    name: "Download ChatGPT plugin",
    exact: true,
  });
  await button.click();
  await expect(
    page.getByText("Skill access was removed", { exact: true }),
  ).toBeVisible();
  expect(downloads).toEqual([]);
  await expect(button).toBeEnabled();
  const retry = page.waitForEvent("download");
  await button.click();
  await retry;
});
