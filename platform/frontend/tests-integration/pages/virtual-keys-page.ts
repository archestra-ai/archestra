import {
  E2eTestId,
  getDeleteVirtualKeyButtonTestId,
  getVirtualKeyRowTestId,
} from "@archestra/shared/e2e-test-ids";
import type { Locator, Page } from "@playwright/test";

export class VirtualKeysPage {
  readonly page: Page;
  readonly addButton: Locator;
  readonly valueDisplay: Locator;

  constructor(page: Page) {
    this.page = page;
    this.addButton = page.getByTestId(E2eTestId.AddVirtualKeyButton);
    this.valueDisplay = page.getByTestId(E2eTestId.VirtualKeyValue);
  }

  async goto() {
    await this.page.goto("/llm/credentials/virtual-keys");
  }

  rowFor(name: string): Locator {
    return this.page.getByTestId(getVirtualKeyRowTestId(name));
  }

  deleteButtonFor(name: string): Locator {
    return this.page.getByTestId(getDeleteVirtualKeyButtonTestId(name));
  }
}
