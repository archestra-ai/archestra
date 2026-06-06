import type { archestraApiTypes } from "@archestra/shared";

/**
 * Quickstart agent templates (issue #3858).
 *
 * A curated catalog of pre-built agents so a user can spin up a fully-configured
 * agent (system prompt + recommended model + recommended MCP servers) in a
 * single click instead of assembling everything by hand.
 *
 * The template data here is pure and side-effect-free so it can be unit-tested
 * and reused by the catalog UI. `buildCreateAgentBodyFromTemplate` maps a
 * template into the exact body the create-agent API expects (the same shape
 * AgentDialog submits), and `recommendedMcpServers` lists the MCP servers the
 * catalog offers to install via the existing MCP install flow.
 */

type CreateAgentBody = archestraApiTypes.CreateAgentData["body"];

export interface AgentTemplateMcpServer {
  /** Display name shown in the catalog UI. */
  name: string;
  /**
   * Identifier used to find the server in the MCP catalog when offering to
   * install it (matched case-insensitively against catalog item names).
   */
  catalogName: string;
}

export interface AgentTemplate {
  /** Stable identifier (kebab-case), unique across the catalog. */
  id: string;
  name: string;
  /** One-line description shown on the template card. */
  description: string;
  /** Lucide icon name used by AgentIcon, or null for the default. */
  icon: string | null;
  /** Grouping shown in the catalog (e.g. "Engineering", "Support"). */
  category: string;
  /** Pre-written system prompt for the agent. */
  systemPrompt: string;
  /**
   * Recommended model id (provider/model). Optional — left unset means the user
   * picks a model after creation, so templates never reference a model the
   * user's workspace may not have configured.
   */
  recommendedModelId?: string;
  /** Example prompts surfaced to the user to get started. */
  suggestedPrompts: string[];
  /** MCP servers the catalog offers to install for this agent. */
  recommendedMcpServers: AgentTemplateMcpServer[];
}

export const AGENT_TEMPLATES: readonly AgentTemplate[] = [
  {
    id: "code-reviewer",
    name: "Code Reviewer",
    description:
      "Reviews pull requests for correctness, security, and clarity, and leaves actionable inline feedback.",
    icon: "Code",
    category: "Engineering",
    systemPrompt:
      "You are a meticulous senior software engineer doing code review. " +
      "For each change, check correctness, edge cases, security, and readability. " +
      "Prefer concrete, minimal suggestions with example diffs. Call out anything " +
      "risky explicitly, and say so plainly when a change looks good.",
    suggestedPrompts: [
      "Review the latest pull request on this repository.",
      "What are the riskiest changes in this diff?",
    ],
    recommendedMcpServers: [{ name: "GitHub", catalogName: "github" }],
  },
  {
    id: "research-assistant",
    name: "Research Assistant",
    description:
      "Researches a question across the web, verifies claims, and writes a cited summary.",
    icon: "Search",
    category: "Productivity",
    systemPrompt:
      "You are a rigorous research assistant. Break the question into sub-questions, " +
      "gather information from multiple sources, cross-check claims, and never fabricate " +
      "facts or citations. Present a concise summary with sources listed for every claim, " +
      "and flag anything you could not verify.",
    suggestedPrompts: [
      "Summarize the current state of WebGPU browser support.",
      "Compare the top 3 open-source vector databases.",
    ],
    recommendedMcpServers: [
      { name: "Brave Search", catalogName: "brave-search" },
      { name: "Fetch", catalogName: "fetch" },
    ],
  },
  {
    id: "customer-support",
    name: "Customer Support Agent",
    description:
      "Answers customer questions from your knowledge base in a friendly, accurate tone.",
    icon: "MessagesSquare",
    category: "Support",
    systemPrompt:
      "You are a friendly, accurate customer support agent. Answer using only the " +
      "information available in the connected knowledge base. If you are unsure or the " +
      "answer is not covered, say so and offer to escalate rather than guessing. Keep " +
      "replies concise and empathetic.",
    suggestedPrompts: [
      "How do I reset my password?",
      "What is covered by the free plan?",
    ],
    recommendedMcpServers: [],
  },
  {
    id: "data-analyst",
    name: "Data Analyst",
    description:
      "Explores databases, writes safe read-only SQL, and explains the results in plain language.",
    icon: "ChartBar",
    category: "Data",
    systemPrompt:
      "You are a careful data analyst. Write read-only SQL only — never mutate data. " +
      "Explain your query plan before running it, show the SQL you ran, and interpret " +
      "results in plain language with the caveats and assumptions made.",
    suggestedPrompts: [
      "What were our top 10 customers by revenue last month?",
      "Show the schema of the orders table.",
    ],
    recommendedMcpServers: [{ name: "PostgreSQL", catalogName: "postgres" }],
  },
  {
    id: "devops-helper",
    name: "DevOps Helper",
    description:
      "Inspects infrastructure and CI, and proposes fixes for failing builds and deployments.",
    icon: "Server",
    category: "Engineering",
    systemPrompt:
      "You are a pragmatic DevOps engineer. Diagnose CI and deployment failures from logs, " +
      "explain the root cause, and propose the smallest safe fix. Never run destructive " +
      "commands without explicitly calling out the risk and asking for confirmation first.",
    suggestedPrompts: [
      "Why did the latest CI run fail?",
      "Summarize errors in the deployment logs.",
    ],
    recommendedMcpServers: [{ name: "GitHub", catalogName: "github" }],
  },
  {
    id: "writing-editor",
    name: "Writing Editor",
    description:
      "Polishes drafts for clarity, tone, and concision without changing your meaning.",
    icon: "PenLine",
    category: "Productivity",
    systemPrompt:
      "You are a sharp writing editor. Improve clarity, flow, tone, and concision while " +
      "preserving the author's voice and intent. Explain notable changes briefly, and " +
      "never invent facts or claims that were not in the original text.",
    suggestedPrompts: [
      "Tighten this paragraph without losing meaning.",
      "Make this email more professional but still warm.",
    ],
    recommendedMcpServers: [],
  },
];

/**
 * Map a template to the body the create-agent API expects — the same shape
 * AgentDialog submits for a new internal agent (`agentType: "agent"`).
 */
export function buildCreateAgentBodyFromTemplate(
  template: AgentTemplate,
  options?: { name?: string; scope?: CreateAgentBody["scope"] },
): CreateAgentBody {
  return {
    name: options?.name?.trim() || template.name,
    agentType: "agent",
    icon: template.icon,
    description: template.description,
    systemPrompt: template.systemPrompt,
    modelId: template.recommendedModelId ?? null,
    scope: options?.scope ?? "personal",
  };
}

/** Look up a template by id. */
export function getAgentTemplateById(id: string): AgentTemplate | undefined {
  return AGENT_TEMPLATES.find((t) => t.id === id);
}
