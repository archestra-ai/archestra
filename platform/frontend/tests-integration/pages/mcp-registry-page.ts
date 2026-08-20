import { E2eTestId } from "@archestra/shared/e2e-test-ids";
import type { Locator, Page } from "@playwright/test";

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
    // The registry opens in its table view now; these specs are written
    // against the cards, so the page carries the preference a person who
    // picked that view would have. The one spec that wants the table clicks
    // the toggle itself.
    await this.page.addInitScript(() => {
      try {
        window.localStorage.setItem("archestra-mcp-registry-view", "cards");
      } catch {
        // Storage can be unavailable; the spec then fails where it looks
        // for a card rather than somewhere confusing.
      }
    });
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
