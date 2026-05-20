import { test as base } from "@playwright/test";
import { MswControl } from "./helpers/msw-control";
import { McpRegistryPage } from "./pages/mcp-registry-page";

type Fixtures = {
  mcpRegistryPage: McpRegistryPage;
  mswControl: MswControl;
};

type AutoFixtures = {
  // Auto-applied. Owns three checks at fixture teardown:
  //   1. Browser request to the real backend (localhost:9000) — direct leak.
  //   2. Browser unhandled API request — MSW worker had no matching handler.
  //   3. Node unhandled API request — MSW server had no matching handler.
  // Any of the three means MSW coverage has a gap and the test passed by luck.
  // biome-ignore lint/suspicious/noConfusingVoidType: Playwright auto-fixture convention is `void`.
  _backendLeakGuard: void;
};

export const test = base.extend<Fixtures & AutoFixtures>({
  mcpRegistryPage: async ({ page }, use) => {
    await use(new McpRegistryPage(page));
  },
  mswControl: async ({ request, page, baseURL }, use) => {
    if (!baseURL) {
      throw new Error("baseURL is required for mswControl fixture");
    }
    const control = new MswControl(request, page, baseURL);
    await use(control);
    // Reset after each test so overrides and unhandled-request lists don't
    // leak across tests when the Next.js dev server is reused
    // (`reuseExistingServer: true`).
    await control.reset();
  },
  _backendLeakGuard: [
    async ({ page, mswControl }, use) => {
      const leaks: string[] = [];
      page.on("request", (req) => {
        const url = req.url();
        if (
          url.includes("://localhost:9000") ||
          url.includes("://127.0.0.1:9000")
        ) {
          leaks.push(`${req.method()} ${url}`);
        }
      });

      await use();

      const browserUnhandled = await page
        .evaluate(() => window.__archestraUnhandledRequests ?? [])
        .catch<string[]>(() => []);

      const nodeUnhandled = await mswControl.getUnhandled().catch(() => []);

      const failures = [
        ...leaks.map((u) => `${u} [client→:9000]`),
        ...browserUnhandled.map((u) => `${u} [client]`),
        ...nodeUnhandled.map((u) => `${u} [ssr]`),
      ];

      if (failures.length > 0) {
        throw new Error(
          `MSW coverage gap: ${failures.length} request(s) escaped MSW.\n` +
            `Each should be either mocked by a handler in src/mocks/handlers.ts ` +
            `or overridden by the test via mswControl.use(...).\n  ${failures.join("\n  ")}`,
        );
      }
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
