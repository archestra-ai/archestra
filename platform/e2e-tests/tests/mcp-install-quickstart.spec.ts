import { expect } from "@playwright/test";
import { archestraApiSdk } from "@shared";
import { type Page, test } from "../fixtures";
import {
  goToMcpRegistry,
  installMcpServer,
  openAddMcpServerDialog,
  submitAddServer,
  waitForInstallDialog,
  waitForMcpServerCard,
} from "../utils";

test.describe("MCP Install quickstart", { tag: "@quickstart" }, () => {
  test("Self-hosted from catalog", async ({
    adminPage,
    extractCookieHeaders,
  }) => {
    const CONTEXT7_CATALOG_ITEM_NAME = "context7";

    await deleteCatalogItem(
      adminPage,
      extractCookieHeaders,
      CONTEXT7_CATALOG_ITEM_NAME,
    );

    await goToMcpRegistry(adminPage);

    await openAddMcpServerDialog(adminPage);

    await adminPage
      .getByRole("button", { name: "Select from Online Catalog" })
      .click();
    await adminPage.waitForLoadState("domcontentloaded");
    await adminPage
      .getByRole("textbox", { name: "Search servers by name..." })
      .fill("context7");
    await expect(adminPage.getByText("1 server found")).toBeVisible();
    await expect(
      adminPage.getByText(CONTEXT7_CATALOG_ITEM_NAME, { exact: true }),
    ).toBeVisible();
    const useAsTemplateButton = adminPage.getByRole("button", {
      name: "Use as Template",
    });
    await expect(useAsTemplateButton).toBeVisible();

    await useAsTemplateButton.click();
    await adminPage.waitForLoadState("domcontentloaded");

    await submitAddServer(adminPage);

    await waitForInstallDialog(adminPage, { titlePattern: /Install -/ });

    await adminPage
      .getByRole("textbox", { name: "context7_api_key *" })
      .fill("fake-api-key");

    await installMcpServer(adminPage);

    await waitForMcpServerCard(adminPage, CONTEXT7_CATALOG_ITEM_NAME);

    await deleteCatalogItem(
      adminPage,
      extractCookieHeaders,
      CONTEXT7_CATALOG_ITEM_NAME,
    );
  });
});

async function deleteCatalogItem(
  adminPage: Page,
  extractCookieHeaders: (page: Page) => Promise<string>,
  catalogItemName: string,
) {
  const cookieHeaders = await extractCookieHeaders(adminPage);
  await archestraApiSdk.deleteInternalMcpCatalogItemByName({
    path: { name: catalogItemName },
    headers: { Cookie: cookieHeaders },
  });
}
