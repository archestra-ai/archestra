import { expect, test } from "../../fixtures";
import {
  findCatalogItem,
  findInstalledServer,
  waitForServerInstallation,
} from "../api/mcp-gateway-utils";

const MCP_UI_SERVER_ACTIONS = "ui-test-server-actions";

test.describe("MCP UI Extended Tests", () => {
  test.beforeAll(async ({ request, installMcpServer, makeApiRequest }) => {
    const catalogItem = await findCatalogItem(request, MCP_UI_SERVER_ACTIONS);
    if (!catalogItem) throw new Error(`Catalog item '${MCP_UI_SERVER_ACTIONS}' not found.`);
    let server = await findInstalledServer(request, catalogItem.id);
    if (!server) {
      const res = await installMcpServer(request, { name: MCP_UI_SERVER_ACTIONS, catalogId: catalogItem.id });
      server = await res.json();
      await waitForServerInstallation(request, server.id);
    }

    const defaultProfileRes = await makeApiRequest({ request, method: "get", urlSuffix: "/api/agents/default" });
    const defaultProfile = await defaultProfileRes.json();
    const toolsRes = await makeApiRequest({ request, method: "get", urlSuffix: "/api/tools" });
    const tools = (await toolsRes.json()).data;
    
    const tool = tools.find(t => t.name.includes(MCP_UI_SERVER_ACTIONS));

    if (!tool) throw new Error("Could not find the newly installed tool.");

    await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/agents/tools/bulk-assign",
        data: {
            assignments: [
                { agentId: defaultProfile.id, toolId: tool.id, executionSourceMcpServerId: server.id },
            ],
        },
    });
  });

  test("should handle 'tool' action", async ({ page, goToPage }) => {
    await goToPage(page, "/chat");
    await page.getByPlaceholder("Send a message...").fill("show_ui_tool_action");
    await page.getByRole("button", { name: "Send" }).click();
    
    const toolFrame = page.frameLocator('iframe');
    await toolFrame.locator("button").click();

    await expect(page.getByText("Tool executed with params: {\"foo\":\"bar\"}")).toBeVisible();
  });

  test("should handle 'prompt' action", async ({ page, goToPage }) => {
    await goToPage(page, "/chat");
    await page.getByPlaceholder("Send a message...").fill("show_ui_prompt_action");
    await page.getByRole("button", { name: "Send" }).click();

    const toolFrame = page.frameLocator('iframe');
    await toolFrame.locator("button").click();

    await expect(page.getByPlaceholder("Send a message...")).toHaveValue("This is a prompt");
  });

  test("should handle 'link' action", async ({ page, goToPage }) => {
    await goToPage(page, "/chat");
    await page.getByPlaceholder("Send a message...").fill("show_ui_link_action");
    await page.getByRole("button", { name: "Send" }).click();

    const toolFrame = page.frameLocator('iframe');
    const [newPage] = await Promise.all([
        page.context().waitForEvent("page"),
        toolFrame.locator("a").click(),
    ]);

    await expect(newPage).toHaveURL("https://example.com/");
  });

  test("should handle 'notify' action", async ({ page, goToPage }) => {
    await goToPage(page, "/chat");
    await page.getByPlaceholder("Send a message...").fill("show_ui_notify_action");
    await page.getByRole("button", { name: "Send" }).click();

    const toolFrame = page.frameLocator('iframe');
    await toolFrame.locator("button").click();

    await expect(page.getByText("This is a notification")).toBeVisible();
  });

  test("should handle 'intent' action", async ({ page, goToPage }) => {
    await goToPage(page, "/chat");
    await page.getByPlaceholder("Send a message...").fill("show_ui_intent_action");
    await page.getByRole("button", { name: "Send" }).click();

    const toolFrame = page.frameLocator('iframe');
    await toolFrame.locator("button").click();

    await expect(page.getByText("Intent executed with params: {\"foo\":\"bar\"}")).toBeVisible();
  });

  test("should render fallback table for simple object", async ({ page, goToPage }) => {
    await goToPage(page, "/chat");
    await page.getByPlaceholder("Send a message...").fill("show_ui_fallback");
    await page.getByRole("button", { name: "Send" }).click();
    
    const toolFrame = page.frameLocator('iframe');
    await expect(toolFrame.locator("table")).toBeVisible();
    await expect(toolFrame.locator("th:has-text('Property')")).toBeVisible();
    await expect(toolFrame.locator("th:has-text('Value')")).toBeVisible();
    await expect(toolFrame.locator("td:has-text('foo')")).toBeVisible();
    await expect(toolFrame.locator("td:has-text('bar')")).toBeVisible();
  });

  test("should display error and retry on failed import", async ({ page, goToPage }) => {
    await page.route("**/@mcp-ui/client", (route) => {
      route.abort();
    });

    await goToPage(page, "/chat");
    await page.getByPlaceholder("Send a message...").fill("show_ui_tool_action");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByText("Failed to load UI component:")).toBeVisible();
    
    await page.unroute("**/@mcp-ui/client");

    await page.route("**/@mcp-ui/client", (route) => {
      route.continue();
    });

    await page.getByRole("button", { name: "Retry" }).click();
    
    const toolFrame = page.frameLocator('iframe');
    await expect(toolFrame.locator("button")).toBeVisible();
  });
});
