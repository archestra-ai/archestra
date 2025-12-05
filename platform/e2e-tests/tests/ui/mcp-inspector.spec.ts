import { expect, test } from "../../fixtures";

test.describe("MCP Inspector", () => {
  test("can navigate to MCP Inspector and verify it loads", async ({
    page,
    goToMcpInspector,
  }) => {
    await goToMcpInspector();
    await expect(page.getByText("MCP Inspector")).toBeVisible({
      timeout: 10000,
    });
  });
});
