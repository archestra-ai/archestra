import {
  ARCHESTRA_MCP_SERVER_NAME,
  TOOL_GET_LIMITS_FULL_NAME,
  TOOL_GET_MCP_SERVERS_FULL_NAME,
  TOOL_LIST_AGENTS_FULL_NAME,
} from "./archestra-mcp-server";
import { MCP_SERVER_TOOL_NAME_SEPARATOR } from "./consts";

export const TOOL_WILDCARD = "*";

export function isWildcardTool(fqn: string): boolean {
  const idx = fqn.lastIndexOf(MCP_SERVER_TOOL_NAME_SEPARATOR);
  if (idx < 1) return false;
  return fqn.slice(idx + MCP_SERVER_TOOL_NAME_SEPARATOR.length) === TOOL_WILDCARD;
}

export interface AgentTemplateLabel {
  key: string;
  value: string;
}

export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  type: string;
  categories: string[];
  systemPrompt: string;
  llmModel: string | null;
  tools: string[];
  labels: AgentTemplateLabel[];
  icon: string | null;
}

/**
 * Extracts unique MCP server display names from template tool FQNs.
 * Filters out built-in archestra server.
 * Derives display name from server name dynamically (no hardcoded mapping).
 */
export function getTemplateRequiredMcpServers(tools: string[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const fqn of tools) {
    const idx = fqn.lastIndexOf(MCP_SERVER_TOOL_NAME_SEPARATOR);
    if (idx < 1) continue;
    const server = fqn.slice(0, idx);
    if (server === ARCHESTRA_MCP_SERVER_NAME || seen.has(server)) continue;
    seen.add(server);
    names.push(server.charAt(0).toUpperCase() + server.slice(1));
  }
  return names;
}

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: "ops-engineer",
    name: "Ops Engineer",
    description:
      "Investigates agent behavior, MCP connectivity, and usage limits with built-in platform tools.",
    type: "agent",
    categories: ["operations", "internal-tools"],
    systemPrompt: `You are an operations engineer working inside the platform.
Use the available tools to inspect agents, MCP server availability, tool execution status, and operational limits.
Prioritize diagnosing the current issue, explaining what you verified, and recommending the smallest safe next step.`,
    llmModel: null,
    tools: [
      TOOL_LIST_AGENTS_FULL_NAME,
      TOOL_GET_MCP_SERVERS_FULL_NAME,
      TOOL_GET_LIMITS_FULL_NAME,
    ],
    labels: [
      { key: "template", value: "ops-engineer" },
      { key: "persona", value: "operations" },
    ],
    icon: "🛠️",
  },
  {
    id: "code-reviewer",
    name: "Code Reviewer",
    description:
      "Reviews repositories and issues, then summarizes correctness risks and follow-up actions.",
    type: "agent",
    categories: ["engineering", "collaboration"],
    systemPrompt: `You are a careful code reviewer.
Inspect repository context and open issues before giving feedback.
Focus on correctness, regressions, and actionable recommendations.`,
    llmModel: null,
    tools: ["github__*"],
    labels: [
      { key: "template", value: "code-reviewer" },
      { key: "persona", value: "review" },
    ],
    icon: "🔎",
  },
  {
    id: "general-purpose",
    name: "General Purpose",
    description:
      "Starts with no tool assignments so the agent can be customized after creation.",
    type: "agent",
    categories: ["general"],
    systemPrompt: `You are a general-purpose assistant.
Ask clarifying questions when requirements are ambiguous, explain your reasoning clearly, and adapt to the user's workflow.`,
    llmModel: null,
    tools: [],
    labels: [],
    icon: "✨",
  },
];

export function getAgentTemplateById(id: string): AgentTemplate | undefined {
  return AGENT_TEMPLATES.find((template) => template.id === id);
}
