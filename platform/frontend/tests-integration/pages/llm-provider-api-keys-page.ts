import { E2eTestId } from "@archestra/shared/e2e-test-ids";
import type { Locator, Page } from "@playwright/test";

export class LlmProviderApiKeysPage {
  readonly page: Page;
  readonly addButton: Locator;
  readonly table: Locator;

  constructor(page: Page) {
    this.page = page;
    this.addButton = page.getByTestId(E2eTestId.AddChatApiKeyButton);
    this.table = page.getByTestId(E2eTestId.ChatApiKeysTable);
  }

  async goto() {
    await this.page.goto("/llm/model-providers");
  }

  rowFor(name: string): Locator {
    return this.page.getByTestId(`${E2eTestId.ChatApiKeyRow}-${name}`);
  }

  editButtonFor(name: string): Locator {
    return this.page.getByTestId(`${E2eTestId.EditChatApiKeyButton}-${name}`);
  }

  deleteButtonFor(name: string): Locator {
    return this.page.getByTestId(`${E2eTestId.DeleteChatApiKeyButton}-${name}`);
  }
}
