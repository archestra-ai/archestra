import type { Locator, Page } from "@playwright/test";

export class LlmLogsPage {
  readonly page: Page;
  readonly table: Locator;
  readonly latestConversationHeading: Locator;

  constructor(page: Page) {
    this.page = page;
    this.table = page.getByRole("table");
    this.latestConversationHeading = page.getByRole("heading", {
      name: "Latest Conversation",
    });
  }

  async goto() {
    await this.page.goto("/llm/logs");
  }

  async gotoSession(sessionId: string) {
    await this.page.goto(`/llm/logs/session/${encodeURIComponent(sessionId)}`);
  }

  // The filter bar renders four SearchableSelect comboboxes in order:
  // Profile, User, Source, Client. The combobox's accessible name changes to
  // the selected option, so the Client filter is addressed by position.
  get clientFilter(): Locator {
    return this.page.getByRole("combobox").nth(3);
  }

  rowForText(text: string | RegExp): Locator {
    return this.table.locator("tbody tr").filter({ hasText: text });
  }

  /**
   * Open the Client filter and pick an option by its visible label.
   * SearchableSelect renders options as buttons (not role="option"), and the
   * Claude options also carry the Anthropic logo's alt text ("Anthropic …"),
   * so match on the label as a substring.
   */
  async selectClient(label: string) {
    await this.clientFilter.click();
    await this.page.getByRole("button", { name: label }).click();
  }
}
