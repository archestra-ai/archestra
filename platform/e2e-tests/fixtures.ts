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
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  adminAuthFile,
  EDITOR_EMAIL,
  EDITOR_PASSWORD,
  editorAuthFile,
  MEMBER_EMAIL,
  MEMBER_PASSWORD,
  memberAuthFile,
  UI_BASE_URL,
} from "./consts";
import { cleanupWorkerAuthFile, createWorkerAuthStorage } from "./worker-auth";

/** Type for user-specific navigation function */
type GoToPageFn = (path?: string) => ReturnType<Page["goto"]>;

/**
 * Worker-scoped fixtures that run once per worker.
 * Each worker gets its own authenticated session to avoid race conditions.
 */
interface WorkerFixtures {
  /** Path to worker-specific admin auth storage file */
  workerAdminStoragePath: string;
  /** Path to worker-specific editor auth storage file */
  workerEditorStoragePath: string;
  /** Path to worker-specific member auth storage file */
  workerMemberStoragePath: string;
}

/**
 * Playwright test extension with fixtures
 * https://playwright.dev/docs/test-fixtures#creating-a-fixture
 */
interface TestFixtures {
  goToPage: typeof goToPage;
  makeRandomString: typeof makeRandomString;
  extractCookieHeaders: (page: Page) => Promise<string>;
  /** Overridden page fixture with worker-specific auth */
  page: Page;
  /** Page authenticated as admin (alias for page) */
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
export const test = base.extend<TestFixtures, WorkerFixtures>({
  /**
   * Worker-scoped fixture: Creates a fresh admin authenticated session per worker.
   */
  workerAdminStoragePath: [
    async ({ browser }, use, workerInfo) => {
      const storagePath = await createWorkerAuthStorage({
        browser,
        baseAuthFile: adminAuthFile,
        workerIndex: workerInfo.workerIndex,
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
        userType: "admin",
      });
      await use(storagePath);
      await cleanupWorkerAuthFile(storagePath);
    },
    { scope: "worker" },
  ],

  /**
   * Worker-scoped fixture: Creates a fresh editor authenticated session per worker.
   */
  workerEditorStoragePath: [
    async ({ browser }, use, workerInfo) => {
      const storagePath = await createWorkerAuthStorage({
        browser,
        baseAuthFile: editorAuthFile,
        workerIndex: workerInfo.workerIndex,
        email: EDITOR_EMAIL,
        password: EDITOR_PASSWORD,
        userType: "editor",
      });
      await use(storagePath);
      await cleanupWorkerAuthFile(storagePath);
    },
    { scope: "worker" },
  ],

  /**
   * Worker-scoped fixture: Creates a fresh member authenticated session per worker.
   */
  workerMemberStoragePath: [
    async ({ browser }, use, workerInfo) => {
      const storagePath = await createWorkerAuthStorage({
        browser,
        baseAuthFile: memberAuthFile,
        workerIndex: workerInfo.workerIndex,
        email: MEMBER_EMAIL,
        password: MEMBER_PASSWORD,
        userType: "member",
      });
      await use(storagePath);
      await cleanupWorkerAuthFile(storagePath);
    },
    { scope: "worker" },
  ],

  goToPage: async ({}, use) => {
    await use(goToPage);
  },
  makeRandomString: async ({}, use) => {
    await use(makeRandomString);
  },
  extractCookieHeaders: async ({}, use) => {
    await use(async (page: Page) => {
      const cookies = await page.context().cookies();
      return cookies
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join("; ");
    });
  },
  /**
   * Override default page fixture to use worker-specific auth.
   * This ensures each worker has its own authenticated session,
   * preventing race conditions when multiple workers share the same session.
   */
  page: async ({ browser, workerAdminStoragePath }, use) => {
    const { context, page } = await createAuthenticatedPage(
      browser,
      workerAdminStoragePath,
    );
    await use(page);
    await context.close();
  },
  /**
   * Admin page - alias for page (uses worker-specific auth storage)
   */
  adminPage: async ({ page }, use) => {
    await use(page);
  },
  /**
   * Editor page - uses worker-specific auth storage
   */
  editorPage: async ({ browser, workerEditorStoragePath }, use) => {
    const { context, page } = await createAuthenticatedPage(
      browser,
      workerEditorStoragePath,
    );
    await use(page);
    await context.close();
  },
  /**
   * Member page - uses worker-specific auth storage
   */
  memberPage: async ({ browser, workerMemberStoragePath }, use) => {
    const { context, page } = await createAuthenticatedPage(
      browser,
      workerMemberStoragePath,
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
