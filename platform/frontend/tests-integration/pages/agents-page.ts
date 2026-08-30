import { E2eTestId } from "@archestra/shared/e2e-test-ids";
import type { Locator, Page } from "@playwright/test";

export class AgentsPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly table: Locator;
  readonly createButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole("heading", { name: "Agents", level: 1 });
    this.table = page.getByTestId(E2eTestId.AgentsTable);
    this.createButton = page.getByTestId(E2eTestId.CreateAgentButton);
  }

  async goto() {
    await this.page.goto("/agents");
  }

  // The DataTable truncates names with CSS and stashes the full string on the
  // <td title> attribute, so matching by title is the only stable locator.
  rowFor(name: string): Locator {
    const tableRow = this.table.getByRole("row").filter({
      has: this.page.getByText(name, { exact: true }),
    });
    return tableRow.or(this.cardFor(name));
  }

  private cardFor(name: string): Locator {
    return this.table
      .getByRole("heading", { name, level: 3 })
      .locator("../../..");
  }

  async openRowMenu(name: string): Promise<void> {
    await this.rowFor(name)
      .getByRole("button", { name: /more actions/i })
      .click();
  }

  cloneButtonFor(name: string): Locator {
    return this.page.getByTestId(`${E2eTestId.CloneAgentButton}-${name}`);
  }

  deleteButtonFor(name: string): Locator {
    return this.page.getByTestId(`${E2eTestId.DeleteAgentButton}-${name}`);
  }
}
