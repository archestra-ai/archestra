import { expect, test } from "../../fixtures";
import {
  findCatalogItem,
  findInstalledServer,
  waitForServerInstallation,
} from "../api/mcp-gateway-utils";

const MCP_UI_SERVER_1 = "ui-test-server-1";
const MCP_UI_SERVER_2 = "ui-test-server-2";

test.describe("MCP UI End-to-End Test", () => {
  test.beforeAll(async ({ request, installMcpServer, makeApiRequest }) => {
    // --- Install MCP UI Server 1 ---
    const catalogItem1 = await findCatalogItem(request, MCP_UI_SERVER_1);
    if (!catalogItem1) throw new Error(`Catalog item '${MCP_UI_SERVER_1}' not found.`);
    let server1 = await findInstalledServer(request, catalogItem1.id);
    if (!server1) {
      const res = await installMcpServer(request, { name: MCP_UI_SERVER_1, catalogId: catalogItem1.id });
      server1 = await res.json();
      await waitForServerInstallation(request, server1.id);
    }

    // --- Install MCP UI Server 2 ---
    const catalogItem2 = await findCatalogItem(request, MCP_UI_SERVER_2);
    if (!catalogItem2) throw new Error(`Catalog item '${MCP_UI_SERVER_2}' not found.`);
    let server2 = await findInstalledServer(request, catalogItem2.id);
    if (!server2) {
      const res = await installMcpServer(request, { name: MCP_UI_SERVER_2, catalogId: catalogItem2.id });
      server2 = await res.json();
      await waitForServerInstallation(request, server2.id);
    }

    // --- Assign tools to default profile ---
    const defaultProfileRes = await makeApiRequest({ request, method: "get", urlSuffix: "/api/agents/default" });
    const defaultProfile = await defaultProfileRes.json();
    const toolsRes = await makeApiRequest({ request, method: "get", urlSuffix: "/api/tools" });
    const tools = (await toolsRes.json()).data;
    
    const tool1 = tools.find(t => t.name.includes(MCP_UI_SERVER_1));
    const tool2 = tools.find(t => t.name.includes(MCP_UI_SERVER_2));

    if (!tool1 || !tool2) throw new Error("Could not find the newly installed tools.");

    await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/agents/tools/bulk-assign",
        data: {
            assignments: [
                { agentId: defaultProfile.id, toolId: tool1.id, executionSourceMcpServerId: server1.id },
                { agentId: defaultProfile.id, toolId: tool2.id, executionSourceMcpServerId: server2.id },
            ],
        },
    });
  });

  test("should render UI from MCP UI Server 1", async ({ page, goToPage }) => {
    await goToPage(page, "/chat");
    await page.getByPlaceholder("Send a message...").fill("show_ui");
    await page.getByRole("button", { name: "Send" }).click();
    
    const toolFrame = page.frameLocator('iframe');
    await expect(toolFrame.locator("h1")).toHaveText("Hello from MCP UI 1");
  });

  test("should render UI from MCP UI Server 2", async ({ page, goToPage }) => {
    await goToPage(page, "/chat");
    await page.getByPlaceholder("Send a message...").fill("show_ui_2");
    await page.getByRole("button", { name: "Send" }).click();

    const toolFrame = page.frameLocator('iframe');
    await expect(toolFrame.locator("h2")).toHaveText("Hello from MCP UI 2");
  });
});
