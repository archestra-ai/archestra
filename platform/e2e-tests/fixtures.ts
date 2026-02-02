/**
 * biome-ignore-all lint/correctness/noEmptyPattern: oddly enough in extend below this is required
 * see https://vitest.dev/guide/test-context.html#extend-test-context
 */
import {
  type Browser,
  type BrowserContext,
  test as base,
  type Page,
} from "@playwright/test";
import { editorAuthFile, memberAuthFile, UI_BASE_URL } from "./consts";

/** Type for user-specific navigation function */
type GoToPageFn = (path?: string) => ReturnType<Page["goto"]>;

/**
 * Playwright test extension with fixtures
 * https://playwright.dev/docs/test-fixtures#creating-a-fixture
 */
interface TestFixtures {
  goToPage: typeof goToPage;
  makeRandomString: typeof makeRandomString;
  extractCookieHeaders: (page: Page) => Promise<string>;
  /** Page authenticated as admin (same as default `page`) */
  adminPage: Page;
  /** Page authenticated as editor */
  editorPage: Page;
  /** Page authenticated as member */
  memberPage: Page;
  /** Navigate admin page to a path */
  goToAdminPage: GoToPageFn;
  /** Navigate editor page to a path */
  goToEditorPage: GoToPageFn;
  /** Navigate member page to a path */
  goToMemberPage: GoToPageFn;
}

export const goToPage = async (page: Page, path = "") => {
  await page.goto(`${UI_BASE_URL}${path}`);
  await page.waitForTimeout(500);
};

const makeRandomString = (length = 10, prefix = "") =>
  `${prefix}-${Math.random()
    .toString(36)
    .substring(2, 2 + length)}`;

/**
 * Create a page with specific auth state
 */
async function createAuthenticatedPage(
  browser: Browser,
  storageState: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  return { context, page };
}

export * from "@playwright/test";
export const test = base.extend<TestFixtures>({
  goToPage: async ({}, use) => {
    await use(goToPage);
  },
  makeRandomString: async ({}, use) => {
    await use(makeRandomString);
  },
  extractCookieHeaders: async ({}, use) => {
    await use(async (page: Page) => {
      // Ensure page has navigated to establish cookie context
      // This is needed because some tests call extractCookieHeaders before navigating
      if (page.url() === "about:blank") {
        await page.goto(`${UI_BASE_URL}/`);
        await page.waitForLoadState("networkidle");
      }
      const cookies = await page.context().cookies();
      return cookies
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join("; ");
    });
  },
  /**
   * Admin page - same auth as default `page` fixture
   */
  adminPage: async ({ page }, use) => {
    // Default page is already admin (via storageState in config)
    await use(page);
  },
  /**
   * Editor page - creates a new browser context with editor auth
   */
  editorPage: async ({ browser }, use) => {
    const { context, page } = await createAuthenticatedPage(
      browser,
      editorAuthFile,
    );
    await use(page);
    await context.close();
  },
  /**
   * Member page - creates a new browser context with member auth
   */
  memberPage: async ({ browser }, use) => {
    const { context, page } = await createAuthenticatedPage(
      browser,
      memberAuthFile,
    );
    await use(page);
    await context.close();
  },
  /**
   * Navigate admin page to a path
   */
  goToAdminPage: async ({ adminPage }, use) => {
    await use((path = "") => adminPage.goto(`${UI_BASE_URL}${path}`));
  },
  /**
   * Navigate editor page to a path
   */
  goToEditorPage: async ({ editorPage }, use) => {
    await use((path = "") => editorPage.goto(`${UI_BASE_URL}${path}`));
  },
  /**
   * Navigate member page to a path
   */
  goToMemberPage: async ({ memberPage }, use) => {
    await use((path = "") => memberPage.goto(`${UI_BASE_URL}${path}`));
  },
});
