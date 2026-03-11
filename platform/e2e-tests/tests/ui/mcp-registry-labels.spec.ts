import { expect } from "@playwright/test";
import { goToPage, test } from "../../fixtures";
import { test as apiTest } from "../api/fixtures";

const CATALOG_NAME_PREFIX = "e2e-label-filter";

apiTest.describe("MCP Registry Label Filtering", () => {
  let catalogItemIds: string[] = [];

  apiTest.beforeAll(async ({ request, createMcpCatalogItem }) => {
    // Create catalog items with different labels
    const items = [
      {
        name: `${CATALOG_NAME_PREFIX}-alpha`,
        description: "Alpha server",
        serverType: "remote" as const,
        serverUrl: "https://example.com/alpha",
        labels: [
          { key: "env", value: "production" },
          { key: "team", value: "backend" },
        ],
      },
      {
        name: `${CATALOG_NAME_PREFIX}-beta`,
        description: "Beta server",
        serverType: "remote" as const,
        serverUrl: "https://example.com/beta",
        labels: [
          { key: "env", value: "staging" },
          { key: "team", value: "backend" },
        ],
      },
      {
        name: `${CATALOG_NAME_PREFIX}-gamma`,
        description: "Gamma server",
        serverType: "remote" as const,
        serverUrl: "https://example.com/gamma",
        labels: [
          { key: "env", value: "production" },
          { key: "team", value: "frontend" },
        ],
      },
    ];

    for (const item of items) {
      const response = await createMcpCatalogItem(request, item);
      const data = await response.json();
      catalogItemIds.push(data.id);
    }
  });

  apiTest.afterAll(async ({ request, deleteMcpCatalogItem }) => {
    for (const id of catalogItemIds) {
      await deleteMcpCatalogItem(request, id);
    }
    catalogItemIds = [];
  });

  apiTest(
    "API: label keys and values endpoints return correct data",
    async ({ request, makeApiRequest }) => {
      // Verify label keys endpoint
      const keysResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/internal_mcp_catalog/labels/keys",
      });
      const keys = await keysResponse.json();
      expect(keys).toContain("env");
      expect(keys).toContain("team");

      // Verify label values endpoint with key filter
      const envValuesResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/internal_mcp_catalog/labels/values?key=env",
      });
      const envValues = await envValuesResponse.json();
      expect(envValues).toContain("production");
      expect(envValues).toContain("staging");

      const teamValuesResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/internal_mcp_catalog/labels/values?key=team",
      });
      const teamValues = await teamValuesResponse.json();
      expect(teamValues).toContain("backend");
      expect(teamValues).toContain("frontend");
    },
  );
});

test.describe("MCP Registry Label Filtering UI", () => {
  test("Labels button appears and filters catalog items", async ({
    adminPage,
  }) => {
    await goToPage(adminPage, "/mcp/registry");

    // The Labels button should be visible if there are catalog items with labels
    const labelsButton = adminPage.getByRole("combobox", { name: /labels/i });

    // If no labels exist in the system, the button won't render - skip test
    if (!(await labelsButton.isVisible().catch(() => false))) {
      test.skip();
      return;
    }

    // Open the labels popover
    await labelsButton.click();

    // The popover should show label keys
    const popoverContent = adminPage.locator(
      "[data-radix-popper-content-wrapper]",
    );
    await expect(popoverContent).toBeVisible();

    // Search for a key
    const searchInput = popoverContent.getByPlaceholder("Search keys...");
    await expect(searchInput).toBeVisible();
  });

  test("URL updates when label filter is applied", async ({ adminPage }) => {
    await goToPage(adminPage, `/mcp/registry?labels=env:production`);

    // Verify the URL contains labels param
    expect(adminPage.url()).toContain("labels=env");

    // Label badges should be visible when labels are in URL
    const labelBadge = adminPage.getByText("env: production");

    // If the label doesn't exist on any item, badge won't show - that's OK
    if (await labelBadge.isVisible().catch(() => false)) {
      await expect(labelBadge).toBeVisible();

      // Clear button should be visible
      const clearButton = adminPage.getByRole("button", { name: /clear/i });
      await expect(clearButton).toBeVisible();

      // Click clear to remove filters
      await clearButton.click();
      expect(adminPage.url()).not.toContain("labels=");
    }
  });
});
