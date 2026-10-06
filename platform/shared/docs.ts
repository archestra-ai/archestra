import { WEBSITE_URL } from "./consts";

export function getDocsBaseUrl(): string {
  if (typeof process !== "undefined" && process.env) {
    const customDocsUrl =
      process.env.NEXT_PUBLIC_ARCHESTRA_DOCS_URL ||
      process.env.ARCHESTRA_DOCS_URL;
    if (customDocsUrl) {
      return customDocsUrl.replace(/\/+$/, "");
    }
    const websiteUrl = process.env.NEXT_PUBLIC_WEBSITE_URL;
    if (websiteUrl) {
      const base = websiteUrl.replace(/\/+$/, "");
      return base.endsWith("/docs") ? base : `${base}/docs`;
    }
    if (process.env.NODE_ENV === "test" || process.env.VITEST) {
      return `${WEBSITE_URL}/docs`;
    }
  }

  if (typeof window !== "undefined" && window.location) {
    const host = window.location.hostname || "";
    if (host.startsWith("stack") && host.includes(".localhost")) {
      const port =
        (typeof process !== "undefined" &&
          process.env?.NEXT_PUBLIC_ARCHESTRA_DOCS_PORT) ||
        `305${host.replace(/^stack(\d+)\..*/, "$1")}`;
      return `${window.location.protocol}//${host}:${port}/docs`;
    }
  }

  return `${WEBSITE_URL}/docs`;
}

export const COMMUNITY_DOCS_URL = getDocsUrl("get-started");

/**
 * All valid documentation page slugs.
 * Keep this in sync with docs/pages/*.md file names (without .md extension).
 */
export const DocsPage = {
  Contributing: "contributing",
  McpAuthentication: "mcp/authentication",
  Security: "contributing/security",
  // Platform
  PlatformAccessControl: "admin/access-control",
  PlatformAddingLlmProviders: "contributing/adding-llm-providers",
  PlatformAgentTriggersEmail: "agents/triggers-and-channels/email",
  PlatformAgentTriggersWebhookA2a: "agents/triggers-and-channels/webhook-a2a",
  PlatformAgentHooks: "agents/hooks",
  PlatformAgentRuntime: "agents/runtime",
  PlatformCredentials: "admin/security/credentials",
  PlatformAgents: "agents",
  PlatformApps: "chat/apps",
  PlatformArchestraMcpServer: "reference/archestra-mcp-server",
  PlatformApiReference: "reference/api",
  PlatformBuiltInSubagents: "agents/subagents/built-in",
  PlatformChat: "chat",
  PlatformClaudeCodeExample: "integrations/claude-code",
  PlatformClaudeDesktopExample: "integrations/claude-desktop",
  PlatformCodeSandbox: "agents",
  PlatformConnection: "get-started/connect",
  PlatformCostsAndLimits: "llm-proxy/costs-and-limits",
  PlatformDeployment: "admin/deployment",
  PlatformDeveloperQuickstart: "contributing/developer-quickstart",
  PlatformAiToolGuardrails: "agents/guardrails",
  PlatformAiToolGuardrailsBatteries: "agents/guardrails/batteries",
  PlatformAiToolGuardrailsClients: "agents/guardrails/clients",
  PlatformEnterpriseManagedAuth: "admin/identity/enterprise-managed-auth",
  PlatformEnvironments: "admin/environments",
  PlatformFoundry: "integrations/foundry",
  PlatformIdentityProviders: "admin/identity",
  PlatformKnowledge: "knowledge",
  PlatformKnowledgeConnectors: "knowledge/connectors",
  PlatformKnowledgeSettings: "knowledge/settings",
  PlatformLlmProxyAuthentication: "llm-proxy/authentication",
  PlatformLlmProxy: "llm-proxy",
  PlatformMastraExample: "integrations/mastra",
  PlatformMcpGateway: "mcp/gateway",
  PlatformMigrateYourAgents: "get-started/migrate",
  PlatformMsTeams: "agents/triggers-and-channels/ms-teams",
  PlatformN8nExample: "integrations/n8n",
  PlatformObservability: "admin/observability",
  PlatformObservabilityMetrics: "admin/observability/metrics",
  PlatformOpenwebuiExample: "integrations/openwebui",
  PlatformOrchestrator: "mcp/servers",
  PlatformOverview: "get-started",
  PlatformPerformanceBenchmarks: "admin/observability/performance-benchmarks",
  PlatformTwoFactorAuthentication: "admin/identity/two-factor-authentication",
  PlatformPrivateRegistry: "mcp/servers",
  PlatformProjects: "chat/projects",
  PlatformPydanticExample: "integrations/pydantic",
  PlatformQuickstart: "get-started",
  PlatformResetUserPassword: "admin/identity/reset-user-password",
  PlatformSecretsManagement: "admin/security/secrets-management",
  PlatformSlack: "agents/triggers-and-channels/slack",
  PlatformSsoRoleMapping: "admin/identity/sso-role-mapping",
  PlatformSsoTeamSync: "admin/identity/sso-team-sync",
  PlatformTelegram: "agents/triggers-and-channels/telegram",
  PlatformSupportedLlmProviders: "llm-proxy/providers",
  PlatformVercelAiExample: "integrations/vercel-ai",
} as const;

export type DocsPage = (typeof DocsPage)[keyof typeof DocsPage];

/**
 * Construct a full documentation URL for a given page slug and optional anchor.
 *
 * @example
 * getDocsUrl(DocsPage.PlatformAgents) // "https://archestra.ai/docs/agents"
 * getDocsUrl(DocsPage.PlatformSupportedLlmProviders, "using-vertex-ai") // "https://archestra.ai/docs/llm-proxy/providers#using-vertex-ai"
 */
export function getDocsUrl(page: DocsPage | string, anchor?: string): string {
  const url = `${getDocsBaseUrl()}/${page}`;
  return anchor ? `${url}#${anchor}` : url;
}
