import type { Locator, Page } from "@playwright/test";

export class SkillsNewPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly searchInput: Locator;
  // ActionCard button that opens the GitHub / GitLab import dialog.
  readonly gitRepositoryCard: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole("heading", { name: "Add a new skill" });
    this.searchInput = page.getByPlaceholder(
      "Search skills by name, repo, or use case...",
    );
    this.gitRepositoryCard = page.getByRole("button", {
      name: /^Git repository/,
    });
  }

  async goto() {
    await this.page.goto("/skills/new");
  }

  // A catalog search result row — the row is a button whose aria-label is
  // `Import <name> from <repo>` (see SkillIndexResult in new/page.client.tsx).
  importResultFor(name: string, repo: string): Locator {
    return this.page.getByRole("button", {
      name: `Import ${name} from ${repo}`,
    });
  }
}
