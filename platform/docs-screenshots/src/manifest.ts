import type { Page } from "@playwright/test";
import type { Shot } from "./shot";

/**
 * Every docs screenshot of the Archestra app. Screenshots of other products
 * (Claude Desktop, Slack, Telegram, …) can't be captured here and stay manual.
 *
 * `asset` is the path under docs/assets without `.webp`; the capture writes the
 * light shot there and its dark twin beside it as `.dark.webp`.
 */
export const SHOTS: Shot[] = [
  {
    asset: "automated_screenshots/platform-environments_overview",
    route: () => "/settings/environments",
  },
  {
    asset: "automated_screenshots/agents_catalog",
    route: () => "/agents",
    // Three rows: the persona's agents. The admin's personal assistant sorts last.
    viewport: { width: 1440, height: 760 },
  },
  {
    asset: "automated_screenshots/mcp-servers_registry",
    route: () => "/mcp/registry",
  },
  {
    asset: "automated_screenshots/mcp-servers-adding_remote",
    route: () => "/mcp/registry/new",
    viewport: { width: 1440, height: 1000 },
    prepare: async (page) => {
      await page.getByText("Start from scratch").click();
      await page.getByPlaceholder("e.g., GitHub MCP Server").fill("Figma");
      await page
        .getByPlaceholder("Describe what this MCP server does...")
        .fill("Design files, components, and comments");
      await page
        .getByPlaceholder("https://api.example.com/mcp")
        .fill("https://mcp.figma.com/mcp");
      await page.getByText("OAuth 2.1", { exact: true }).click();
    },
  },
  {
    asset: "automated_screenshots/mcp-servers-installing_install",
    route: () => "/mcp/registry",
    prepare: async (page) => {
      await page.getByRole("button", { name: "Install Stripe" }).click();
    },
    target: (page) => page.getByRole("dialog"),
  },
  {
    asset: "automated_screenshots/mcp-gateway_gateways",
    route: () => "/mcp/gateways",
  },
  {
    asset: "automated_screenshots/knowledge_knowledge-bases",
    route: () => "/knowledge/knowledge-bases",
    viewport: { width: 1440, height: 760 },
  },
  {
    asset: "automated_screenshots/knowledge_connectors",
    route: () => "/knowledge/connectors",
    viewport: { width: 1440, height: 800 },
  },
  {
    asset: "automated_screenshots/knowledge_files",
    route: () => "/knowledge/files",
    viewport: { width: 1440, height: 760 },
  },
  {
    asset: "automated_screenshots/knowledge_settings",
    route: () => "/settings/knowledge",
  },
  {
    asset: "automated_screenshots/platform-connection_connect-with-ai",
    route: () => "/connection?clientId=codex",
  },
  {
    asset: "automated_screenshots/platform-connection_browser-approval",
    route: () => "/connection",
    // An installer would start this request; a pending one expires in ten minutes.
    prepare: async (page) => {
      const response = await page.request.post("/api/client-connections", {
        data: { clientId: "codex", platform: "macos" },
      });
      const { verificationPath } = await response.json();
      await page.goto(verificationPath);
      await page.waitForLoadState("networkidle");
    },
    viewport: { width: 1100, height: 480 },
  },
  {
    asset: "automated_screenshots/chat_composer",
    route: () => "/chat",
  },
  {
    asset: "automated_screenshots/chat-apps_gallery",
    route: () => "/apps",
  },
  {
    asset: "automated_screenshots/platform-projects_project-overview",
    route: (seed) => `/projects/${seed.projects["Q4 Launch Plan"]}`,
  },

  {
    asset: "automated_screenshots/platform-agent-skills_skills-in-studio",
    route: () => "/skills",
  },
  {
    asset: "automated_screenshots/platform-agent-skills_import-from-github",
    route: () => "/skills/new",
    prepare: async (page) => {
      await page.getByText("Custom GitHub URL", { exact: true }).click();
      await page.getByLabel("Repository URL").fill("acme-corp/agent-skills");
    },
    target: (page) => page.getByRole("dialog"),
  },
  {
    asset:
      "automated_screenshots/platform-agent-skills-sharing_connection-setup",
    route: () => "/connection?clientId=claude-code",
    prepare: async (page) => {
      // The card's skills column, e.g. "+3 skills".
      await page
        .getByText(/^\+\d+ skills?$/)
        .first()
        .waitFor();
    },
  },
  {
    asset:
      "automated_screenshots/platform-agent-skills-sharing_marketplace-link",
    // Any Client opens on its prompt; the marketplace step is in Manual setup.
    route: () => "/connection?clientId=generic&mode=manual",
    prepare: async (page) => {
      await page.getByTestId("skills-marketplace-credential-toggle").click();
    },
    target: (page) => page.getByTestId("skills-marketplace-static"),
  },
  {
    asset:
      "automated_screenshots/platform-identity-providers_sso-providers-overview",
    route: () => "/settings/identity-providers",
  },
  {
    asset:
      "automated_screenshots/platform-supported-llm-providers_model-providers",
    route: () => "/llm/model-providers",
  },
  {
    asset: "automated_screenshots/llm-proxy_proxy",
    route: () => "/llm/proxy",
    viewport: { width: 1440, height: 920 },
    prepare: async (page) => {
      await page
        .getByRole("button", { name: "Create new virtual key" })
        .first()
        .waitFor();
    },
  },
  {
    // Creates a key on each run: the dialog shows connection details only after Create.
    asset: "automated_screenshots/llm-proxy_model-router-key",
    // The LLM Proxy page closes the dialog once the key exists; this page
    // keeps it open on the connection details.
    route: () => "/llm/proxy/virtual-keys",
    viewport: { width: 1440, height: 1000 },
    prepare: async (page) => {
      await page.getByRole("button", { name: "Create Virtual Key" }).click();
      await page
        .getByRole("menuitem", { name: /Standard virtual key/ })
        .click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Name").fill("Support bot");
      // The single-page form starts with each provider's primary key selected.
      await dialog.getByRole("button", { name: "Create key" }).click();
      await page.getByText("Copy your key").waitFor();
    },
    target: (page) => page.getByRole("dialog"),
  },
  {
    asset: "automated_screenshots/llm-proxy_my-usage",
    route: () => "/llm/usage?timeframe=30d",
    viewport: { width: 1440, height: 900 },
    prepare: async (page) => {
      await page.getByText("Where your tokens went").first().waitFor();
      await page.waitForLoadState("networkidle");
    },
  },
  {
    asset: "automated_screenshots/llm-proxy_costs",
    route: () => "/llm/costs?timeframe=30d",
    viewport: { width: 1440, height: 780 },
    prepare: async (page) => {
      await page.getByText("Billed spend").first().waitFor();
      await page.waitForLoadState("networkidle");
    },
  },
  {
    asset: "automated_screenshots/llm-proxy_limits",
    route: () => "/llm/limits",
    viewport: { width: 1440, height: 640 },
    prepare: async (page) => {
      await page.getByText("Platform Engineering").first().waitFor();
    },
  },
  {
    asset: "automated_screenshots/platform-agent-plugins_catalog",
    route: () => "/plugins",
  },
  {
    asset: "automated_screenshots/agents-plugins_plugin-details",
    route: (seed) => `/plugins/${seed.plugins["Branch Guard"]}`,
  },
  {
    asset: "automated_screenshots/agents-runtime_create-agent",
    route: () => "/agents/new",
  },
  {
    asset: "automated_screenshots/agents-runtime_runtime-picker",
    route: () => "/agents/new",
    prepare: async (page) => {
      await page.getByText("Claude Code", { exact: true }).first().click();
      await page.locator(".monaco-editor").first().waitFor();
      await page.waitForLoadState("networkidle");
      await page.locator("input").first().blur();
      // Runtime icons load after the picker renders.
      await page.waitForTimeout(1_000);
      await page
        .getByRole("heading", { name: "Runtime", exact: true })
        .scrollIntoViewIfNeeded();
    },
  },
  {
    asset: "automated_screenshots/agents-subagents_agent-subagents",
    route: (seed) => `/agents/${seed.agents["Support Triage"]}?section=tools`,
    prepare: async (page) => {
      await page.getByRole("combobox", { name: "Add subagent" }).click();
      await page.getByRole("option", { name: /Research Assistant/ }).click();
      await page
        .getByRole("heading", { name: "Subagents", exact: true })
        .click();
    },
    target: (page) =>
      page.locator("section").filter({
        has: page.getByRole("heading", { name: "Subagents", exact: true }),
      }),
  },
  {
    asset: "automated_screenshots/agents-hooks_hooks-editor",
    route: (seed) => `/agents/${seed.agents["Support Triage"]}?section=tools`,
    viewport: { width: 1440, height: 1200 },
    beforeNavigate: async (page) => {
      await page.route("**/api/config", async (route) => {
        const response = await route.fetch();
        const json = await response.json();
        if (json?.features) {
          json.features.agentHooksEnabled = true;
          json.features.sandbox = true;
        }
        await route.fulfill({ response, json });
      });
    },
    prepare: async (page) => {
      await page.addStyleTag({
        content: `
          [data-page-header], [data-wizard-footer] {
            display: none !important;
          }
        `,
      });
      await page
        .getByRole("heading", { name: "Hooks", exact: true })
        .scrollIntoViewIfNeeded();
      await page.getByText("pre-tool-use.py").waitFor();
      await page.getByRole("button", { name: "Edit pre-tool-use.py" }).click();
      await page.locator(".monaco-editor").first().waitFor();
      await page.waitForTimeout(500);
    },
    target: (page) =>
      page.locator("section").filter({
        has: page.getByRole("heading", { name: "Hooks", exact: true }),
      }),
  },
  {
    asset: "automated_screenshots/agents-subagents-built-in_built-in-agents",
    route: () => "/agents?scope=built_in",
  },
  {
    asset: "automated_screenshots/agents-subagents-external_connect",
    route: () => "/agents/a2a/new",
  },
  {
    asset:
      "automated_screenshots/agents-triggers-and-channels-webhook-a2a_a2a-tab",
    route: (seed) => `/agents/${seed.agents["Support Triage"]}?section=connect`,
  },
  {
    asset: "automated_screenshots/agents-triggers-and-channels_agent-channels",
    route: (seed) =>
      `/agents/${seed.agents["Support Triage"]}?section=messaging`,
    prepare: async (page) => {
      await page.getByText("support-escalations").first().waitFor();
    },
    target: (page) =>
      page.locator("section").filter({
        has: page.getByRole("heading", { name: "Channels", exact: true }),
      }),
  },
  {
    asset: "automated_screenshots/agents-triggers-and-channels-slack_setup",
    route: () => "/settings/messaging-channels/slack",
    viewport: { width: 1440, height: 700 },
  },
  {
    asset: "automated_screenshots/agents-triggers-and-channels-ms-teams_setup",
    route: () => "/settings/messaging-channels/ms-teams",
    viewport: { width: 1440, height: 700 },
  },
  {
    asset: "automated_screenshots/agents-triggers-and-channels-telegram_setup",
    route: () => "/settings/messaging-channels/telegram",
    prepare: async (page) => {
      await page.getByRole("button", { name: "Setup Telegram" }).click();
    },
    target: (page) => page.getByRole("dialog"),
  },
  {
    asset: "automated_screenshots/agents-triggers-and-channels-email_setup",
    route: () => "/settings/messaging-channels/email",
    viewport: { width: 1440, height: 700 },
  },
  {
    asset: "automated_screenshots/platform-ai-tool-guardrails_overview",
    route: () => "/openappa",
    prepare: showGuardrailsEnforced,
  },
  {
    asset: "automated_screenshots/platform-ai-tool-guardrails_client_coverage",
    route: () => "/openappa",
    prepare: showGuardrailsEnforced,
    target: (page) =>
      page.locator('[data-slot="card"]').filter({ hasText: "Client coverage" }),
  },
  {
    asset: "automated_screenshots/platform-openappa_batteries",
    route: () => "/openappa/batteries",
  },
  {
    asset: "automated_screenshots/platform-openappa_policy",
    route: () => "/openappa/policy",
    prepare: async (page) => {
      await page.locator(".monaco-editor").first().waitFor();
    },
  },
];

/*
 * Not migrated yet — each renders an empty state until the seeder creates the data
 * it shows, so the hand-captured image stays until then:
 *
 * - platform-credentials_overview: saved credentials of each kind
 * - platform-costs-and-limits_costs, _my-usage, _proxy-attribution,
 *   platform-llm-proxy-authentication_logs-virtual-key: LLM proxy traffic over
 *   several days (drive it through WireMock so costs, logs, and usage fill in)
 * - platform-projects_*: project files, instructions, schedules, and chats
 * - chat and orchestrator shots: conversations and a hibernated MCP server
 */

/**
 * Guardrails as they look with enforcement on. The deployment status is answered
 * in the browser only, so capturing never turns enforcement on for the instance.
 */
async function showGuardrailsEnforced(page: Page) {
  await page.route("**/api/guardrails-deployment", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      response,
      json: { ...status, enabled: true, active: true },
    });
  });
  await page.reload();
  await page.getByText("Policy coverage", { exact: true }).waitFor();
  await page.waitForLoadState("networkidle");
}
