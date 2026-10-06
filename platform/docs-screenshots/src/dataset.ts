/**
 * The demo organization every docs screenshot shows: a mid-size software company
 * with a few teams, the agents they run, the tools those agents use, and the
 * knowledge they draw on. Names are fictional and generic — never a real customer.
 * Add to this when a new screenshot needs data; the seeder only ever creates
 * what's missing, so additions are safe to re-run anywhere.
 */

export const TEAMS = [
  { name: "Platform Engineering", description: "Owns CI, infrastructure, and internal developer tools" },
  { name: "Customer Support", description: "Tier 1 and tier 2 support across chat and email" },
  { name: "Data Science", description: "Forecasting, experimentation, and analytics" },
  { name: "Security", description: "AppSec, IAM, and incident response" },
] as const;

export const ENVIRONMENTS = [
  { name: "staging", namespace: "archestra-staging" },
  { name: "production", namespace: "archestra-production" },
] as const;

export const AGENTS = [
  {
    name: "Support Triage",
    icon: "🎧",
    description: "Classifies incoming tickets, drafts first replies, and routes escalations",
    systemPrompt:
      "You triage customer support tickets. Classify each ticket by product area and urgency, draft a first reply in the customer's language, and escalate anything involving billing disputes or data loss to a human.",
  },
  {
    name: "Incident Responder",
    icon: "🚨",
    description: "Summarizes alerts, pulls recent deploys, and drafts the incident timeline",
    systemPrompt:
      "You help on-call engineers during incidents. Summarize the firing alerts, list deploys from the last six hours, and keep a running timeline in the incident channel.",
  },
  {
    name: "Research Assistant",
    icon: "🔎",
    description: "Answers questions from the engineering handbook with citations",
    systemPrompt:
      "Answer questions using the engineering handbook knowledge base. Always cite the source document, and say so when the handbook doesn't cover the question.",
  },
  {
    name: "Release Notes Writer",
    icon: "📝",
    description: "Turns merged pull requests into customer-facing release notes",
    systemPrompt:
      "Write release notes from the merged pull requests you're given. Group changes into Features, Improvements, and Fixes, and keep each entry to one sentence a customer can understand.",
  },
  {
    name: "Sales Ops Analyst",
    icon: "📊",
    description: "Builds weekly pipeline reports from the CRM export",
    systemPrompt:
      "Build the weekly pipeline report: new opportunities, stage changes, and deals at risk. Flag any deal whose close date slipped more than twice.",
  },
] as const;

/**
 * Provider keys the persona owns, so key pickers have something to show. The
 * values are fake. Archestra checks a new key with its provider, so these only
 * save where providers point at a mock, as in the CI stack (WireMock).
 */
export const PROVIDER_KEYS = [
  { name: "OpenAI production", provider: "openai", apiKey: "sk-docs-example-openai" },
  { name: "Anthropic production", provider: "anthropic", apiKey: "sk-ant-api03-docs-example" },
] as const;

export const MCP_GATEWAYS = [{ name: "Engineering Gateway" }, { name: "Support Gateway" }] as const;

export const REMOTE_MCP_SERVERS = [
  { name: "Linear", description: "Issues, projects, and cycles", serverUrl: "https://mcp.linear.app/mcp" },
  { name: "Notion", description: "Pages, databases, and comments", serverUrl: "https://mcp.notion.com/mcp" },
  { name: "PagerDuty", description: "Incidents, services, and on-call schedules", serverUrl: "https://mcp.pagerduty.com/mcp" },
  { name: "Atlassian", description: "Jira issues and Confluence pages", serverUrl: "https://mcp.atlassian.com/v1/mcp" },
  // Token header sign-in, so its Install dialog asks for a key.
  {
    name: "Stripe",
    description: "Customers, payments, and invoices",
    serverUrl: "https://mcp.stripe.com",
    userConfig: {
      access_token: {
        type: "string",
        title: "Access Token",
        description: "Bearer token for authentication",
        required: true,
        sensitive: true,
      },
    },
  },
] as const;

export const KNOWLEDGE_BASES = [
  { name: "Engineering Handbook", description: "Architecture docs, runbooks, and decisions from Platform Engineering" },
  { name: "Support Runbooks", description: "Help center articles, past tickets, and escalation guides" },
  { name: "Security Policies", description: "Policies, the incident response plan, and vendor reviews" },
] as const;

/**
 * Knowledge connectors on Knowledge → Connectors, with their last sync. The
 * hosts are fictional, so a real sync would fail: `db-seed.ts` writes these
 * rows straight to the database with a finished sync and `documents` indexed
 * documents each, and no sync task is queued.
 */
export const KNOWLEDGE_CONNECTORS = [
  {
    id: "7a2d3b40-0000-4000-8000-000000000001",
    name: "Engineering Confluence",
    description: "ENG and PLATFORM spaces",
    config: { type: "confluence", confluenceUrl: "https://acme.atlassian.net/wiki", isCloud: true, spaceKeys: ["ENG", "PLATFORM"] },
    knowledgeBases: ["Engineering Handbook"],
    documents: 1284,
    status: "success",
    syncedMinutesAgo: 38,
    schedule: "0 */6 * * *",
  },
  {
    id: "7a2d3b40-0000-4000-8000-000000000002",
    name: "Platform Jira",
    description: "PLAT and INFRA projects",
    config: { type: "jira", jiraBaseUrl: "https://acme.atlassian.net", isCloud: true, projectKey: "PLAT,INFRA" },
    knowledgeBases: ["Engineering Handbook"],
    documents: 3912,
    status: "success",
    syncedMinutesAgo: 52,
    schedule: "0 */6 * * *",
  },
  {
    id: "7a2d3b40-0000-4000-8000-000000000003",
    name: "Platform Repositories",
    description: "READMEs, docs folders, and pull requests",
    config: { type: "github", githubUrl: "https://api.github.com", owner: "acme", repos: ["platform", "deploy-tools", "infra"], includePullRequests: true, includeRepositoryFiles: true },
    knowledgeBases: ["Engineering Handbook"],
    documents: 642,
    status: "running",
    syncedMinutesAgo: 2,
    schedule: "0 * * * *",
  },
  {
    id: "7a2d3b40-0000-4000-8000-000000000004",
    name: "Help Center",
    description: "help.acme.example, crawled daily",
    config: { type: "web_crawler", startUrl: "https://help.acme.example" },
    knowledgeBases: ["Support Runbooks"],
    documents: 218,
    status: "success",
    syncedMinutesAgo: 190,
    schedule: "0 3 * * *",
  },
  {
    id: "7a2d3b40-0000-4000-8000-000000000005",
    name: "Support Jira",
    description: "SUP project, last 12 months",
    config: { type: "jira", jiraBaseUrl: "https://acme.atlassian.net", isCloud: true, projectKey: "SUP" },
    knowledgeBases: ["Support Runbooks"],
    documents: 5431,
    status: "completed_with_errors",
    syncedMinutesAgo: 75,
    schedule: "0 */6 * * *",
  },
  {
    id: "7a2d3b40-0000-4000-8000-000000000006",
    name: "IT ServiceNow",
    description: "Incidents and knowledge articles",
    config: { type: "servicenow", instanceUrl: "https://acme.service-now.com", includeIncidents: true, includeKnowledgeArticles: true },
    knowledgeBases: ["Support Runbooks", "Security Policies"],
    documents: 2076,
    status: "success",
    syncedMinutesAgo: 110,
    schedule: "0 */12 * * *",
  },
  {
    id: "7a2d3b40-0000-4000-8000-000000000007",
    name: "Security Notion",
    description: "Policies and the incident playbook",
    config: { type: "notion", pageIds: ["security-policies", "incident-playbook"] },
    knowledgeBases: ["Security Policies"],
    documents: 187,
    status: "success",
    syncedMinutesAgo: 240,
    schedule: "0 2 * * *",
  },
] as const;

/** Agents that search each Knowledge Base, for its Agents count. */
export const KNOWLEDGE_BASE_AGENTS = [
  { knowledgeBase: "Engineering Handbook", agent: "Research Assistant" },
  { knowledgeBase: "Engineering Handbook", agent: "Incident Responder" },
  { knowledgeBase: "Engineering Handbook", agent: "Release Notes Writer" },
  { knowledgeBase: "Support Runbooks", agent: "Support Triage" },
  { knowledgeBase: "Security Policies", agent: "Research Assistant" },
] as const;

/**
 * Uploaded files on Knowledge → Files. `directory` null is the top level;
 * `knowledgeBase` null leaves the file stored but not indexed.
 */
export const KNOWLEDGE_DIRECTORIES = ["Vendor security reviews", "HR policies", "Sales enablement"] as const;

export const KNOWLEDGE_FILES = [
  { filename: "incident-response-plan.pdf", directory: null, knowledgeBase: "Security Policies", text: "Incident Response Plan. Declare an incident when customer data or availability is at risk. The incident commander owns the timeline." },
  { filename: "acceptable-use-policy.pdf", directory: null, knowledgeBase: "Security Policies", text: "Acceptable Use Policy. Company devices are for company work. Report a lost device to IT within one hour." },
  { filename: "data-retention-policy.md", directory: null, knowledgeBase: "Security Policies", text: "# Data Retention Policy\n\nCustomer data is deleted 30 days after an account closes. Audit logs are kept for one year." },
  { filename: "on-call-handbook.md", directory: null, knowledgeBase: "Engineering Handbook", text: "# On-Call Handbook\n\nAcknowledge a page within five minutes. Hand over open incidents at the end of each shift." },
  { filename: "refund-policy.md", directory: null, knowledgeBase: "Support Runbooks", text: "# Refund Policy\n\nAnnual plans get a prorated refund within 30 days. Monthly plans are not refunded." },
  { filename: "pricing-2026.csv", directory: null, knowledgeBase: "Support Runbooks", text: "plan,monthly_usd,annual_usd\nStarter,29,290\nTeam,99,990\nBusiness,399,3990\n" },
  { filename: "q3-board-update.pdf", directory: null, knowledgeBase: null, text: "Q3 Board Update. Revenue grew 18 percent over Q2. Net retention is 112 percent." },
  { filename: "northwind-hosting-soc2-type2.pdf", directory: "Vendor security reviews", knowledgeBase: "Security Policies", text: "SOC 2 Type II report for Northwind Hosting. No exceptions were noted for the review period." },
  { filename: "northwind-hosting-questionnaire.pdf", directory: "Vendor security reviews", knowledgeBase: "Security Policies", text: "Security questionnaire. Customer data is stored in eu-west-1 and us-east-1." },
  { filename: "bluepeak-analytics-soc2-type2.pdf", directory: "Vendor security reviews", knowledgeBase: "Security Policies", text: "SOC 2 Type II report for Bluepeak Analytics. One exception in access reviews was noted." },
  { filename: "bluepeak-analytics-dpa.pdf", directory: "Vendor security reviews", knowledgeBase: "Security Policies", text: "Data processing agreement with Bluepeak Analytics. Sub-processors are listed in Annex 3." },
  { filename: "parental-leave-policy.pdf", directory: "HR policies", knowledgeBase: null, text: "Parental Leave Policy. All employees get 16 weeks of paid leave." },
  { filename: "travel-and-expenses.pdf", directory: "HR policies", knowledgeBase: null, text: "Travel and Expenses. Book economy for flights under six hours." },
  { filename: "remote-work-policy.md", directory: "HR policies", knowledgeBase: null, text: "# Remote Work Policy\n\nEmployees can work from any country where the company has an entity." },
  { filename: "competitive-battlecard.md", directory: "Sales enablement", knowledgeBase: "Support Runbooks", text: "# Competitive Battlecard\n\nLead with single sign-on and audit logs in every plan." },
  { filename: "security-faq-for-prospects.md", directory: "Sales enablement", knowledgeBase: "Support Runbooks", text: "# Security FAQ\n\nWe encrypt data at rest with AES-256 and in transit with TLS 1.2 or later." },
] as const;

export const PROJECTS = [
  { name: "Q4 Launch Plan", description: "Launch checklist, messaging, and the rollout schedule" },
  { name: "Churn Analysis", description: "Why accounts downgraded last quarter, by segment" },
  { name: "SOC 2 Evidence", description: "Collecting evidence for the annual audit" },
] as const;

export const SKILLS = [
  {
    name: "pdf-to-markdown",
    content: `---
name: pdf-to-markdown
description: Extract text from a PDF and convert it to clean markdown.
---

# PDF to Markdown

When the user asks to convert a PDF:

1. Extract the text page by page.
2. Rebuild headings, lists, and tables as markdown.
3. Return the markdown and note any pages that were images only.
`,
  },
  {
    name: "incident-timeline",
    content: `---
name: incident-timeline
description: Build an incident timeline from alerts, deploys, and chat messages.
---

# Incident Timeline

Collect events from the alerting tool, the deploy log, and the incident channel.
Sort them by time and write one line per event: time (UTC), source, what happened.
`,
  },
  {
    name: "release-notes",
    content: `---
name: release-notes
description: Turn merged pull requests into customer-facing release notes.
---

# Release Notes

Group the changes into Features, Improvements, and Fixes.
Write one plain-language sentence per change and link the pull request.
`,
  },
] as const;

/** Plugins on the Plugins page: hook and command bundles for coding clients. */
export const PLUGINS = [
  {
    displayName: "Branch Guard",
    description: "Blocks commits and pushes to main from Claude Code sessions",
    clientType: "claude-code",
    supportedPlatforms: ["posix", "windows"],
    files: [
      {
        path: "hooks/hooks.json",
        content: `{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "\${CLAUDE_PLUGIN_ROOT}/scripts/check-branch.sh" }]
      }
    ]
  }
}
`,
      },
      {
        path: "scripts/check-branch.sh",
        content: `#!/bin/sh
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ "$branch" = "main" ]; then
  echo "Commit on a feature branch, not main." >&2
  exit 2
fi
`,
      },
    ],
  },
  {
    displayName: "Release Checklist",
    description: "Adds a /release-checklist command that walks through the release steps",
    clientType: "codex",
    supportedPlatforms: ["posix"],
    files: [
      {
        path: "commands/release-checklist.md",
        content: `Walk through the release checklist: changelog updated, version bumped, tests green, tag pushed.
`,
      },
    ],
  },
  {
    displayName: "Secret Scanner",
    description: "A skill that checks staged changes for API keys before a commit",
    clientType: "copilot-cli",
    supportedPlatforms: ["posix", "windows"],
    files: [
      {
        path: "skills/secret-scanner/SKILL.md",
        content: `---
name: secret-scanner
description: Check staged changes for API keys and tokens before committing.
---

Run \`git diff --cached\` and look for strings that look like API keys or tokens. Stop and report any you find.
`,
      },
    ],
  },
] as const;

/**
 * Messaging channels a live bot would discover. The public API cannot create
 * them, so `db-seed.ts` writes them straight to the instance's database.
 */
export const CHANNEL_BINDINGS = {
  agent: "Support Triage",
  channels: [
    {
      id: "6f1c2a10-0000-4000-8000-000000000001",
      provider: "slack",
      channelId: "C0DOCS00001",
      workspaceId: "T0DOCS00001",
      workspaceName: "Acme Corp",
      channelName: "support-escalations",
      answerAllMessages: true,
      channelInstructions: "Every message here is a customer ticket. Classify it and draft a first reply.",
    },
    {
      id: "6f1c2a10-0000-4000-8000-000000000002",
      provider: "slack",
      channelId: "C0DOCS00002",
      workspaceId: "T0DOCS00001",
      workspaceName: "Acme Corp",
      channelName: "customer-success",
      answerAllMessages: false,
      channelInstructions: null,
    },
    {
      id: "6f1c2a10-0000-4000-8000-000000000003",
      provider: "ms-teams",
      channelId: "19:docs-support-tier-2@thread.tacv2",
      workspaceId: "docs-team-support",
      workspaceName: "Acme Corp",
      channelName: "Support › Tier 2",
      answerAllMessages: false,
      channelInstructions: null,
    },
    {
      id: "6f1c2a10-0000-4000-8000-000000000004",
      provider: "telegram",
      channelId: "-1001000000004",
      workspaceId: null,
      workspaceName: null,
      channelName: "Support On-Call",
      answerAllMessages: false,
      channelInstructions: null,
    },
  ],
} as const;

/** Monthly budgets on Costs & Limits → Limits, by the kind of record they apply to. */
export const LIMITS = [
  { entity: "organization", name: "id", dollars: 2500 },
  { entity: "teams", name: "Platform Engineering", dollars: 800 },
  { entity: "teams", name: "Customer Support", dollars: 300 },
  { entity: "environments", name: "production", dollars: 1500 },
] as const;

/** Colleagues of the persona, so company usage spreads across people. */
export const COLLEAGUES = [
  { key: "priya", name: "Priya Raman", email: "priya.raman@example.com" },
  { key: "marcus", name: "Marcus Webb", email: "marcus.webb@example.com" },
  { key: "sofia", name: "Sofia Lindqvist", email: "sofia.lindqvist@example.com" },
  { key: "daniel", name: "Daniel Okafor", email: "daniel.okafor@example.com" },
] as const;

/**
 * Request streams. `user` is a colleague key or "persona"; `client` is the
 * coding client the requests came from, or null for chat with `agent`.
 */
export const USAGE = [
  { user: "priya", agent: "Support Triage", client: null, type: "anthropic:messages", model: "claude-sonnet-4-6", billingMode: "metered", authMethod: "internal", source: "chat", perDay: 180, inputTokens: 9000, outputTokens: 700, inputPrice: 3, outputPrice: 15, cacheShare: 0.5 },
  { user: "marcus", agent: "Incident Responder", client: null, type: "anthropic:messages", model: "claude-opus-4-6", billingMode: "metered", authMethod: "internal", source: "chat", perDay: 36, inputTokens: 28000, outputTokens: 2200, inputPrice: 5, outputPrice: 25, cacheShare: 0.6 },
  { user: "sofia", agent: "Research Assistant", client: null, type: "openai:responses", model: "gpt-5.4", billingMode: "metered", authMethod: "internal", source: "chat", perDay: 75, inputTokens: 16000, outputTokens: 1800, inputPrice: 2.5, outputPrice: 15, cacheShare: 0.3 },
  { user: "marcus", agent: "Release Notes Writer", client: null, type: "gemini:generateContent", model: "gemini-2.5-pro", billingMode: "metered", authMethod: "internal", source: "chat", perDay: 18, inputTokens: 40000, outputTokens: 3000, inputPrice: 1.25, outputPrice: 10, cacheShare: 0.2 },
  { user: "daniel", agent: "Sales Ops Analyst", client: null, type: "openai:chatCompletions", model: "gpt-5.4-mini", billingMode: "metered", authMethod: "internal", source: "chat", perDay: 90, inputTokens: 6000, outputTokens: 500, inputPrice: 0.75, outputPrice: 4.5, cacheShare: 0.1 },
  { user: "priya", agent: null, client: "anthropic_claude_code", type: "anthropic:messages", model: "claude-sonnet-4-6", billingMode: "subscription", authMethod: "passthrough_virtual_key", source: "api", perDay: 135, inputTokens: 30000, outputTokens: 1500, inputPrice: 3, outputPrice: 15, cacheShare: 0.8 },
  { user: "persona", agent: null, client: "anthropic_claude_code", type: "anthropic:messages", model: "claude-opus-4-6", billingMode: "subscription", authMethod: "passthrough_virtual_key", source: "api", perDay: 70, inputTokens: 60000, outputTokens: 1800, inputPrice: 5, outputPrice: 25, cacheShare: 0.85 },
  { user: "persona", agent: null, client: "openai_codex", type: "openai:responses", model: "gpt-5.4", billingMode: "subscription", authMethod: "passthrough_virtual_key", source: "api", perDay: 25, inputTokens: 30000, outputTokens: 1500, inputPrice: 2.5, outputPrice: 15, cacheShare: 0.6 },
  { user: "persona", agent: null, client: "cursor", type: "anthropic:messages", model: "claude-sonnet-4-6", billingMode: "metered", authMethod: "virtual_key", source: "api", perDay: 30, inputTokens: 20000, outputTokens: 900, inputPrice: 3, outputPrice: 15, cacheShare: 0.5 },
  { user: "persona", agent: "Research Assistant", client: null, type: "openai:responses", model: "gpt-5.4", billingMode: "metered", authMethod: "internal", source: "chat", perDay: 10, inputTokens: 16000, outputTokens: 1800, inputPrice: 2.5, outputPrice: 15, cacheShare: 0.3 },
] as const;

/** Which team runs each agent, and where it runs, so team and environment budgets have usage. */
export const AGENT_PLACEMENT = [
  { agent: "Support Triage", team: "Customer Support", environment: "production" },
  { agent: "Incident Responder", team: "Platform Engineering", environment: "production" },
  { agent: "Research Assistant", team: "Data Science", environment: "staging" },
  { agent: "Release Notes Writer", team: "Platform Engineering", environment: "staging" },
  { agent: "Sales Ops Analyst", team: "Data Science", environment: "production" },
] as const;
