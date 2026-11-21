import type { Locator, Page } from "@playwright/test";

/** An LLM session's detail page. The sessions list is the unified Logs page. */
export class LlmLogsPage {
  readonly page: Page;
  /** Session detail: the request list at the top of the split. */
  readonly requestList: Locator;
  /** Session detail: the conversation column of the details pane. */
  readonly conversationPane: Locator;

  constructor(page: Page) {
    this.page = page;
    this.requestList = page.getByRole("list", { name: "Requests" });
    this.conversationPane = page.getByRole("tabpanel", {
      name: "Conversation",
    });
  }

  async gotoSession(sessionId: string) {
    await this.page.goto(`/llm/logs/${encodeURIComponent(sessionId)}`);
  }
}
