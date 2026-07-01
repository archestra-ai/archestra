import { test as base } from "@playwright/test";
import { MswControl } from "./helpers/msw-control";
import { AgentsPage } from "./pages/agents-page";
import { LlmLogsPage } from "./pages/llm-logs-page";
import { LlmProviderApiKeysPage } from "./pages/llm-provider-api-keys-page";
import { McpRegistryPage } from "./pages/mcp-registry-page";
import { SkillsNewPage } from "./pages/skills-new-page";
import { VirtualKeysPage } from "./pages/virtual-keys-page";

// Biome's useImportType rule otherwise rewrites these to `import type` because
// the class identifiers only appear in `new X(page)` positions, which it
// classifies as type-shaped. The runtime constructors are required at fixture
// build time — keep value imports.
void AgentsPage;
void LlmLogsPage;
void LlmProviderApiKeysPage;
void SkillsNewPage;
void VirtualKeysPage;

type Fixtures = {
  agentsPage: AgentsPage;
  llmKeysPage: LlmProviderApiKeysPage;
  llmLogsPage: LlmLogsPage;
  mcpRegistryPage: McpRegistryPage;
  mswControl: MswControl;
  skillsNewPage: SkillsNewPage;
  virtualKeysPage: VirtualKeysPage;
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
  agentsPage: async ({ page }, use) => {
    await use(new AgentsPage(page));
  },
  llmKeysPage: async ({ page }, use) => {
    await use(new LlmProviderApiKeysPage(page));
  },
  llmLogsPage: async ({ page }, use) => {
    await use(new LlmLogsPage(page));
  },
  mcpRegistryPage: async ({ page }, use) => {
    await use(new McpRegistryPage(page));
  },
  skillsNewPage: async ({ page }, use) => {
    await use(new SkillsNewPage(page));
  },
  virtualKeysPage: async ({ page }, use) => {
    await use(new VirtualKeysPage(page));
  },
  mswControl: async ({ request, page, baseURL }, use) => {
    if (!baseURL) {
      throw new Error("baseURL is required for mswControl fixture");
    }
    const control = new MswControl(request, page, baseURL);
    await control.reset();
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
