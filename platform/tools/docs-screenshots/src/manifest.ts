import { expect, type Page } from "@playwright/test";
import { LOG_SESSION } from "./dataset";
import { USAGE_TIMEFRAME } from "./determinism";
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
    asset: "automated_screenshots/admin-logs_session-waterfall",
    route: () => `/llm/logs/${LOG_SESSION.id}`,
    fixedTime: true,
    viewport: { width: 1600, height: 1120 },
    prepare: async (page) => {
      await expect(
        page.getByRole("heading", { name: LOG_SESSION.prompt, exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: /^Tool call get_incident on PagerDuty,/,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: /^Tool call post_message on Slack,/ }),
      ).toBeVisible();
      await expect(
        page
          .getByRole("list", { name: "Requests", exact: true })
          .getByRole("listitem"),
      ).toHaveCount(9);
    },
  },
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
      // Setup generation can start after networkidle and light the sidebar spinner.
      await expect(page.getByTestId("connect-command-status")).toHaveText(
        "Setup command ready",
      );
      const code = page.getByText(/^[A-F0-9]{4}-[A-F0-9]{4}$/);
      await code.waitFor();
      await code.evaluate((element) => {
        element.textContent = "0123-4567";
      });
    },
    viewport: { width: 1100, height: 480 },
  },
  {
    asset: "automated_screenshots/chat_composer",
    route: (seed) => `/chat?agentId=${seed.agents["Support Triage"]}`,
    beforeNavigate: async (page) => {
      await page.route("**/api/llm-models/available*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([
            {
              id: "claude-3-5-sonnet-20241022",
              dbId: "m0000000-0000-4000-8000-000000000001",
              displayName: "Claude 3.5 Sonnet",
              provider: "anthropic",
              isBest: true,
              isFree: false,
            },
          ]),
        });
      });
      await page.route(
        "**/api/llm-provider-api-keys/available*",
        async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify([
              {
                id: "k0000000-0000-4000-8000-000000000001",
                name: "Anthropic Production",
                provider: "anthropic",
                scope: "org",
                isPrimary: true,
                isSystem: false,
              },
            ]),
          });
        },
      );
    },
    prepare: async (page) => {
      await page.getByText("Claude 3.5 Sonnet").first().waitFor();
    },
  },
  {
    asset: "automated_screenshots/chat-apps_gallery",
    route: () => "/chat/c0000000-0000-4000-8000-000000000099",
    viewport: { width: 1440, height: 900 },
    beforeNavigate: async (page) => {
      const convId = "c0000000-0000-4000-8000-000000000099";
      const appId = "7b8e1a20-0000-4000-8000-000000000099";

      await page.addInitScript(
        ({ id }) => {
          window.localStorage.setItem(
            `archestra-chat-right-panel-open-${id}`,
            "true",
          );
          window.localStorage.setItem(
            `archestra-chat-right-panel-tab-${id}`,
            "apps",
          );
          window.localStorage.setItem("archestra-right-panel-width", "560");
        },
        { id: convId },
      );

      await page.route("**/api/llm-models/available*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([
            {
              id: "claude-3-5-sonnet-20241022",
              dbId: "m0000000-0000-4000-8000-000000000001",
              displayName: "Claude 3.5 Sonnet",
              provider: "anthropic",
              isBest: true,
              isFree: false,
            },
          ]),
        });
      });
      await page.route(
        "**/api/llm-provider-api-keys/available*",
        async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify([
              {
                id: "k0000000-0000-4000-8000-000000000001",
                name: "Anthropic Production",
                provider: "anthropic",
                scope: "org",
                isPrimary: true,
                isSystem: false,
              },
            ]),
          });
        },
      );

      await page.route(
        `**/api/chat/conversations/${convId}*`,
        async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              id: convId,
              userId: "u0000000-0000-4000-8000-000000000001",
              organizationId: "o0000000-0000-4000-8000-000000000001",
              title: "Incident INC-4091 Command Center",
              selectedModel: "m0000000-0000-4000-8000-000000000001",
              selectedProvider: "anthropic",
              modelId: "claude-3-5-sonnet-20241022",
              thinkingEffort: "medium",
              hasCustomToolSelection: false,
              hooksDebugEnabled: false,
              todoList: null,
              artifact: null,
              projectId: null,
              origin: "user",
              titleIsPlaceholder: false,
              encryptedChat: false,
              pinnedAt: null,
              lastMessageAt: "2026-10-12T12:00:00.000Z",
              createdAt: "2026-10-12T12:00:00.000Z",
              updatedAt: "2026-10-12T12:00:00.000Z",
              deletedAt: null,
              chatErrors: [],
              compactions: [],
              messages: [
                {
                  id: "msg-user-1",
                  role: "user",
                  parts: [
                    {
                      type: "text",
                      text: "Deploy the Incident Command Center for INC-4091 to coordinate remediation.",
                    },
                  ],
                },
                {
                  id: "msg-assistant-1",
                  role: "assistant",
                  parts: [
                    {
                      type: "text",
                      text: "I've launched the Incident Command Center for INC-4091. Real-time telemetry, blast radius metrics, and remediation controls are ready in the right panel.",
                    },
                    {
                      type: "dynamic-tool",
                      toolName: "archestra__render_app",
                      toolCallId: "call_render_app_1",
                      state: "output-available",
                      input: { app_id: appId },
                      output: {
                        content: "Rendered Incident Command Center",
                        structuredContent: {
                          id: appId,
                          name: "Incident Command Center",
                          latestVersion: 1,
                        },
                      },
                    },
                  ],
                  metadata: { createdAt: "2026-10-12T12:00:00.000Z" },
                },
              ],
            }),
          });
        },
      );

      await page.route(`**/api/apps/${appId}*`, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: appId,
            organizationId: "o0000000-0000-4000-8000-000000000001",
            authorId: null,
            name: "Incident Command Center",
            slug: "incident-command-center",
            description:
              "Real-time incident telemetry, blast radius assessment, and mitigation controls.",
            templateId: null,
            mcpServerId: null,
            spec: {
              summary: "Incident Command Center",
              features: ["Telemetry", "Blast Radius", "Remediation"],
              tools: [],
            },
            latestVersion: 1,
            enabled: true,
            openInFullscreen: false,
            locked: false,
            createdByServiceAccountId: null,
            createdAt: "2026-10-12T12:00:00.000Z",
            updatedAt: "2026-10-12T12:00:00.000Z",
            deletedAt: null,
            scope: "org",
            environmentId: null,
            icon: "🚨",
            labels: [],
          }),
        });
      });

      await page.route(`**/api/apps/${appId}/tools*`, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([]),
        });
      });

      await page.route(`**/api/mcp/app/${appId}*`, async (route) => {
        const body = route.request().postDataJSON?.();
        if (body?.method === "resources/read") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                contents: [
                  {
                    uri: `ui://archestra-app/${appId}`,
                    mimeType: "text/html",
                    text: INCIDENT_COMMAND_CENTER_HTML,
                  },
                ],
              },
            }),
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: body?.id ?? 1,
            result: {},
          }),
        });
      });
    },
    prepare: async (page) => {
      await page.locator("iframe").first().waitFor();
      await page.waitForTimeout(1000);
    },
  },
  {
    asset: "automated_screenshots/platform-projects_project-overview",
    route: (seed) => `/projects/${seed.projects["Q4 Launch Plan"]}`,
    beforeNavigate: async (page, seed) => {
      await page.addInitScript((id) => {
        window.localStorage.setItem("selected-chat-agent", id);
      }, seed.agents["Support Triage"]);
    },
  },

  {
    asset: "automated_screenshots/platform-agent-skills_skills-in-studio",
    route: () => "/skills?sortBy=name&sortDirection=asc",
  },
  {
    asset: "automated_screenshots/platform-agent-skills_import-from-github",
    route: () => "/skills/new",
    prepare: async (page) => {
      await page.getByText("Git repository", { exact: true }).click();
      await page.getByRole("button", { name: /^GitLab/ }).waitFor();
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
    fixedTime: true,
    route: () => `/llm/usage?timeframe=${encodeURIComponent(USAGE_TIMEFRAME)}`,
    viewport: { width: 1440, height: 900 },
    prepare: async (page) => {
      await page.getByRole("region", { name: "Usage explorer" }).waitFor();
      await page.waitForLoadState("networkidle");
    },
  },
  {
    asset: "automated_screenshots/llm-proxy_costs",
    fixedTime: true,
    route: () => `/llm/costs?timeframe=${encodeURIComponent(USAGE_TIMEFRAME)}`,
    viewport: { width: 1440, height: 780 },
    prepare: async (page) => {
      await page.getByText("Billed spend", { exact: true }).first().waitFor();
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
    asset: "automated_screenshots/llm-proxy_throughput",
    route: () => "/llm/limits",
    viewport: { width: 1440, height: 1000 },
    prepare: prepareThroughputLimit,
  },
  {
    asset: "automated_screenshots/llm-proxy_throughput-mobile",
    route: () => "/llm/limits",
    viewport: { width: 390, height: 844 },
    prepare: prepareThroughputLimit,
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
    // Tall enough for the third row of runtime cards, which the default 900px
    // frame cuts off.
    viewport: { width: 1440, height: 1040 },
  },
  {
    asset: "automated_screenshots/agents-runtime_runtime-picker",
    route: () => "/agents/new",
    prepare: async (page) => {
      await page.getByText("Claude Code", { exact: true }).first().click();
      await page.locator(".monaco-editor").first().waitFor();
      await page.waitForLoadState("networkidle");
      await page.locator("input").first().blur();
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
      // Bootstrap primes the config cache before useConfig can fetch /api/config.
      await page.route(/\/api\/(config|bootstrap)$/, async (route) => {
        const response = await route.fetch();
        const json = await response.json();
        const config = json.config ?? json;
        if (config?.features) {
          config.features.agentHooksEnabled = true;
          config.features.sandbox = true;
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
      // Other wizard steps keep their editors mounted but hidden.
      await page
        .locator("section")
        .filter({
          has: page.getByRole("heading", { name: "Hooks", exact: true }),
        })
        .locator(".monaco-editor")
        .waitFor();
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
      // Slack channels live in the agent's Slack bot section now.
      await page
        .getByRole("listitem", { name: "MS Teams channel Support › Tier 2" })
        .waitFor();
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
    asset: "automated_screenshots/platform-openappa_batteries",
    route: () => "/openappa/batteries",
  },
  {
    asset: "automated_screenshots/platform-openappa_policy",
    route: () => "/openappa/policy",
    prepare: async (page) => {
      // The docs' rules are at the end of the file: jump there, then drop focus
      // so no cursor shows.
      await page.locator(".monaco-editor .view-line").first().click();
      await page.keyboard.press(
        process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End",
      );
      await page.evaluate(() =>
        (document.activeElement as HTMLElement | null)?.blur(),
      );
      // Monaco renders spaces as non-breaking spaces, so match a token without one.
      await page
        .locator(".view-line")
        .filter({ hasText: "acme/sdk" })
        .first()
        .waitFor();
    },
  },
  {
    asset: "automated_screenshots/platform-openappa_validations",
    route: () => "/openappa/validation",
    prepare: async (page) => {
      await page
        .getByText("Slack data can't go into a public GitHub issue")
        .first()
        .waitFor();
    },
  },
  {
    asset: "automated_screenshots/platform-openappa_yells",
    route: () => "/openappa/yells",
    prepare: async (page) => {
      await page
        .getByText("Blocked from opening an issue in acme/sdk")
        .waitFor();
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

async function prepareThroughputLimit(page: Page) {
  await page.getByRole("button", { name: "Add Limit", exact: true }).click();
  await page.getByRole("combobox", { name: "Limit kind", exact: true }).click();
  await page.getByRole("option", { name: "Tokens", exact: true }).click();
  await page.getByLabel("Limit value", { exact: true }).fill("100000");
  await page.getByRole("combobox", { name: "Interval", exact: true }).click();
  await page.getByRole("option", { name: "Calendar day", exact: true }).click();
}

async function showGuardrailsEnforced(page: Page) {
  const response = await page.request.put("/api/guardrails-deployment", {
    data: { enabled: true },
    headers: { Origin: new URL(page.url()).origin },
  });
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({ enabled: true, active: true });
  await page.reload();
  await page.getByText("Enforcement on", { exact: true }).waitFor();
  await page
    .getByRole("heading", { name: "How your policy decides", exact: true })
    .waitFor();
  await page.waitForLoadState("networkidle");
}

const INCIDENT_COMMAND_CENTER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Incident Command Center</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: light-dark(#ffffff, #09090b);
      --card-bg: light-dark(#f8fafc, #141417);
      --card-border: light-dark(#e2e8f0, #27272a);
      --text: light-dark(#0f172a, #f8fafc);
      --text-muted: light-dark(#64748b, #a1a1aa);
      --red: #ef4444;
      --red-bg: light-dark(#fef2f2, #2d1214);
      --red-border: light-dark(#fecaca, #4c1d24);
      --yellow: #f59e0b;
      --yellow-bg: light-dark(#fffbeb, #2e230d);
      --yellow-border: light-dark(#fde68a, #523e13);
      --green: #10b981;
      --green-bg: light-dark(#f0fdf4, #0d2818);
      --green-border: light-dark(#bbf7d0, #144626);
      --blue: #3b82f6;
      --blue-bg: light-dark(#eff6ff, #0f2744);
      --blue-border: light-dark(#bfdbfe, #1d4575);
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    body {
      background: var(--bg);
      color: var(--text);
      padding: 20px;
      line-height: 1.5;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 20px;
      padding-bottom: 14px;
      border-bottom: 1px solid var(--card-border);
    }
    .header-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .badge-sev1 {
      background: var(--red-bg);
      color: var(--red);
      border: 1px solid var(--red-border);
      padding: 3px 10px;
      border-radius: 9999px;
      font-weight: 700;
      font-size: 11px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    .title {
      font-size: 17px;
      font-weight: 700;
    }
    .live-indicator {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--red);
      font-weight: 600;
    }
    .pulse-dot {
      width: 8px;
      height: 8px;
      background: var(--red);
      border-radius: 50%;
      box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.7);
    }
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
      margin-bottom: 20px;
    }
    .metric-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 10px;
      padding: 14px;
    }
    .metric-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-bottom: 4px;
    }
    .metric-value {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .metric-sub {
      font-size: 11px;
      margin-top: 2px;
      font-weight: 500;
    }
    .val-red { color: var(--red); }
    .val-yellow { color: var(--yellow); }
    .val-green { color: var(--green); }
    .section-title {
      font-size: 13px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      margin-bottom: 10px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 10px;
      padding: 14px;
      margin-bottom: 16px;
    }
    .blast-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .blast-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 13px;
    }
    .blast-name {
      font-weight: 600;
    }
    .blast-status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 2px 8px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
    }
    .status-down {
      background: var(--red-bg);
      color: var(--red);
      border: 1px solid var(--red-border);
    }
    .status-degraded {
      background: var(--yellow-bg);
      color: var(--yellow);
      border: 1px solid var(--yellow-border);
    }
    .status-healthy {
      background: var(--green-bg);
      color: var(--green);
      border: 1px solid var(--green-border);
    }
    .remediation-panel {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .remediation-step {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      font-size: 13px;
      padding: 10px;
      border-radius: 8px;
      background: var(--bg);
      border: 1px solid var(--card-border);
    }
    .step-icon {
      font-size: 16px;
      line-height: 1;
      margin-top: 2px;
    }
    .step-details {
      flex: 1;
    }
    .step-title {
      font-weight: 600;
      margin-bottom: 2px;
    }
    .step-desc {
      font-size: 12px;
      color: var(--text-muted);
    }
    .action-btn {
      padding: 5px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      border: none;
      cursor: pointer;
      align-self: center;
      white-space: nowrap;
    }
    .btn-primary {
      background: var(--red);
      color: #ffffff;
    }
    .btn-secondary {
      background: var(--card-border);
      color: var(--text);
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <span class="badge-sev1">SEV-1 Critical</span>
      <h1 class="title">INC-4091: Gateway Outage</h1>
    </div>
    <div class="live-indicator">
      <span class="pulse-dot"></span>
      LIVE MONITORING
    </div>
  </div>

  <div class="metrics-grid">
    <div class="metric-card">
      <div class="metric-label">Error Rate</div>
      <div class="metric-value val-red">48.2%</div>
      <div class="metric-sub val-red">↑ +46.8% vs normal</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">p99 Latency</div>
      <div class="metric-value val-yellow">3,840ms</div>
      <div class="metric-sub val-yellow">↑ +3,200ms degradation</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Impacted Tenants</div>
      <div class="metric-value val-red">1,420</div>
      <div class="metric-sub text-muted">Across 3 clusters</div>
    </div>
  </div>

  <div class="section-title">Blast Radius &amp; Dependency Health</div>
  <div class="card">
    <div class="blast-list">
      <div class="blast-item">
        <span class="blast-name">edge-proxy-us-east</span>
        <span class="blast-status status-down">● Degrading (HTTP 502)</span>
      </div>
      <div class="blast-item">
        <span class="blast-name">auth-token-vault</span>
        <span class="blast-status status-degraded">● Connection Pool Starvation</span>
      </div>
      <div class="blast-item">
        <span class="blast-name">payment-worker-pool</span>
        <span class="blast-status status-healthy">● Healthy (Queued 0)</span>
      </div>
    </div>
  </div>

  <div class="section-title">Automated Remediation Actions</div>
  <div class="remediation-panel">
    <div class="remediation-step">
      <div class="step-icon">⚡</div>
      <div class="step-details">
        <div class="step-title">Drain traffic from us-east cluster</div>
        <div class="step-desc">Reroutes incoming traffic to us-central with zero dropped sockets.</div>
      </div>
      <button class="action-btn btn-primary">Execute Failover</button>
    </div>
    <div class="remediation-step">
      <div class="step-icon">🔄</div>
      <div class="step-details">
        <div class="step-title">Restart connection pool pods</div>
        <div class="step-desc">Performs rolling restart of 8 auth-vault connection pool replicas.</div>
      </div>
      <button class="action-btn btn-secondary">Restart Pods</button>
    </div>
  </div>
</body>
</html>`;
