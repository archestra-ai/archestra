import { expect, test } from "../../fixtures";

test("internal-dev-test-server should be visible in MCP catalog registry", async ({
  page,
  goToPage,
}) => {
  await goToPage(page, "/mcp-catalog/registry");

  // Wait for the page to load and verify the test MCP server is visible
  await expect(page.getByText("internal-dev-test-server")).toBeVisible();
});
