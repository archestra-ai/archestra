import type { Locator, Page } from "@playwright/test";
import { E2eTestId } from "@shared/e2e-test-ids";

export class McpRegistryPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly serverCards: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole("heading", { name: "MCP Registry" });
    this.serverCards = page.locator(
      `[data-testid^="${E2eTestId.McpServerCard}-"]`,
    );
  }

  async goto() {
    await this.page.goto("/mcp/registry");
  }

  cardForCatalogItem(name: string): Locator {
    return this.page.getByTestId(`${E2eTestId.McpServerCard}-${name}`);
  }

  settingsButtonFor(name: string): Locator {
    return this.page.getByTestId(
      `${E2eTestId.McpServerSettingsButton}-${name}`,
    );
  }
}
