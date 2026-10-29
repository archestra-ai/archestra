import type { Locator, Page } from "@playwright/test";

export class LlmLogsPage {
  readonly page: Page;
  readonly table: Locator;
  /** Session detail: the request list at the top of the split. */
  readonly requestList: Locator;
  /** Session detail: the conversation column of the details pane. */
  readonly conversationPane: Locator;

  constructor(page: Page) {
    this.page = page;
    this.table = page.getByRole("table");
    this.requestList = page.getByRole("list", { name: "Requests" });
    this.conversationPane = page.getByRole("tabpanel", {
      name: "Conversation",
    });
  }

  async goto() {
    await this.page.goto("/llm/logs");
  }

  async gotoSession(sessionId: string) {
    await this.page.goto(`/llm/logs/${encodeURIComponent(sessionId)}`);
  }

  get clientFilter(): Locator {
    return this.page.getByRole("combobox", {
      name: "Filter by apps and sources",
    });
  }

  rowForText(text: string | RegExp): Locator {
    return this.table.locator("tbody tr").filter({ hasText: text });
  }

  async selectClient(label: string) {
    await this.clientFilter.click();
    await this.page.getByRole("option", { name: label, exact: true }).click();
  }
}
