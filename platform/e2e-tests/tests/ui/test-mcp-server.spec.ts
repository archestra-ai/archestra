import { expect, test } from "../../fixtures";
import { goToMcpRegistry } from "../../utils";

test("internal-dev-test-server should be visible in MCP catalog registry", async ({
  page,
}) => {
  await goToMcpRegistry(page);

  // Wait for the page to load and verify the test MCP server is visible
  await expect(page.getByText("internal-dev-test-server")).toBeVisible();
});
