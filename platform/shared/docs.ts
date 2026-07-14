import { WEBSITE_URL } from "./consts";

const DOCS_BASE_URL = `${WEBSITE_URL}/docs`;
export const COMMUNITY_DOCS_URL = getDocsUrl("platform-quickstart");

/**
 * All valid documentation page slugs.
 * Keep this in sync with docs/pages/*.md file names (without .md extension).
 */
export const DocsPage = {
  Contributing: "contributing",
  McpAuthentication: "mcp-authentication",
  Security: "security",
  // Platform
  PlatformAccessControl: "platform-access-control",
  PlatformAddingLlmProviders: "platform-adding-llm-providers",
  PlatformAgentTriggersEmail: "platform-agent-triggers-email",
  PlatformAgents: "platform-agents",
  PlatformApps: "platform-apps",
  PlatformArchestraMcpServer: "platform-archestra-mcp-server",
  PlatformApiReference: "platform-api-reference",
  PlatformBuiltInSubagents: "platform-built-in-subagents",
  PlatformChat: "platform-chat",
  PlatformClaudeCodeExample: "platform-claude-code-example",
  PlatformClaudeDesktopExample: "platform-claude-desktop-example",
  PlatformConnection: "platform-connection",
  PlatformCostsAndLimits: "platform-costs-and-limits",
  PlatformDeployment: "platform-deployment",
  PlatformDeveloperQuickstart: "platform-developer-quickstart",
  PlatformAiToolGuardrails: "platform-ai-tool-guardrails",
  PlatformEnterpriseManagedAuth: "platform-enterprise-managed-auth",
  PlatformEnvironments: "platform-environments",
  PlatformFoundry: "platform-foundry",
  PlatformIdentityProviders: "platform-identity-providers",
  PlatformKnowledge: "platform-knowledge",
  PlatformLlmProxyAuthentication: "platform-llm-proxy-authentication",
  PlatformLlmProxy: "platform-llm-proxy",
  PlatformMastraExample: "platform-mastra-example",
  PlatformMcpGateway: "platform-mcp-gateway",
  PlatformMigrateFromClaudeOpenclawHermes:
    "platform-migrate-from-claude-openclaw-hermes",
  PlatformMsTeams: "platform-ms-teams",
  PlatformN8nExample: "platform-n8n-example",
  PlatformObservability: "platform-observability",
  PlatformOpenwebuiExample: "platform-openwebui-example",
  PlatformOrchestrator: "platform-orchestrator",
  PlatformOverview: "platform-overview",
  PlatformPerformanceBenchmarks: "platform-performance-benchmarks",
  PlatformPricingModel: "platform-pricing-model",
  PlatformPrivateRegistry: "platform-private-registry",
  PlatformProjects: "platform-projects",
  PlatformPydanticExample: "platform-pydantic-example",
  PlatformQuickstart: "platform-quickstart",
  PlatformSecretsManagement: "platform-secrets-management",
  PlatformSlack: "platform-slack",
  PlatformSsoTeamSync: "platform-sso-team-sync",
  PlatformTelegram: "platform-telegram",
  PlatformSupportedLlmProviders: "platform-supported-llm-providers",
  PlatformVercelAiExample: "platform-vercel-ai-example",
} as const;

export type DocsPage = (typeof DocsPage)[keyof typeof DocsPage];

/**
 * Construct a full documentation URL for a given page slug and optional anchor.
 *
 * @example
 * getDocsUrl(DocsPage.PlatformAgents) // "https://archestra.ai/docs/platform-agents"
 * getDocsUrl(DocsPage.PlatformSupportedLlmProviders, "using-vertex-ai") // "https://archestra.ai/docs/platform-supported-llm-providers#using-vertex-ai"
 */
export function getDocsUrl(page: DocsPage, anchor?: string): string {
  const url = `${DOCS_BASE_URL}/${page}`;
  return anchor ? `${url}#${anchor}` : url;
}
