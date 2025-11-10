/**
 * biome-ignore-all lint/correctness/noEmptyPattern: oddly enough in extend below this is required
 * see https://vitest.dev/guide/test-context.html#extend-test-context
 */
import { test as base, type Page } from "@playwright/test";
import { UI_BASE_URL } from "../../consts";

/**
 * Playwright test extension with fixtures
 * https://playwright.dev/docs/test-fixtures#creating-a-fixture
 */
interface TestFixtures {
  goToPage: typeof goToPage;
  makeRandomString: typeof makeRandomString;
}

const goToPage = (page: Page, path = "") => page.goto(`${UI_BASE_URL}${path}`);

const makeRandomString = (length = 10, prefix = "") =>
  `${prefix}-${Math.random()
    .toString(36)
    .substring(2, 2 + length)}`;

export * from "@playwright/test";
export const test = base.extend<TestFixtures>({
  goToPage: async ({}, use) => {
    await use(goToPage);
  },
  makeRandomString: async ({}, use) => {
    await use(makeRandomString);
  },
});
