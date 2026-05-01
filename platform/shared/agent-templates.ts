/**
 * Code-defined agent templates.
 *
 * These templates are not stored in Postgres. They exist purely in code and can
 * be used to prefill agent creation fields (prompt, model, labels).
 */

export const AGENT_TEMPLATE_IDS = {
  GENERAL_PURPOSE: "general-purpose-agent",
} as const;

export type AgentTemplateId =
  (typeof AGENT_TEMPLATE_IDS)[keyof typeof AGENT_TEMPLATE_IDS];

export type AgentTemplate = {
  id: AgentTemplateId;
  name: string;
  description: string;
  /** Used for catalog filtering (e.g. "dev", "security", "support") */
  type: string;
  /** Used for catalog filtering (freeform tags, e.g. ["mcp", "testing"]) */
  categories: string[];
  systemPrompt: string;
  llmModel: string | null;
  /**
   * Fully-qualified MCP tool names to pre-assign for the agent when using this template.
   *
   * Format: `${serverName}__${toolName}` (split on the last "__").
   * Example: "internal-dev-test-server__print_archestra_test"
   *
   * Why names (not IDs): tool IDs are environment-specific (seeded/discovered), but
   * full tool names are stable and already used throughout the UI/tests.
   */
  tools: string[];
  labels: Array<{ key: string; value: string }>;
  icon?: string | null;
};

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: AGENT_TEMPLATE_IDS.GENERAL_PURPOSE,
    name: "General Purpose Agent",
    description:
      "A safe, minimal production template with no preselected tools. Add MCP servers/tools as needed for your environment.",
    type: "prod",
    categories: ["production", "general"],
    systemPrompt:
      "You are a production assistant. Be concise and reliable. If a request requires actions outside your permissions or missing tools, say what you need and provide a safe alternative. Prefer using available tools when they are relevant, and avoid guessing when data is missing.",
    // Use org default model unless explicitly chosen by the user
    llmModel: null,
    tools: [],
    labels: [],
    icon: null,
  },
];

export function getAgentTemplateById(id: string): AgentTemplate | null {
  return AGENT_TEMPLATES.find((t) => t.id === id) ?? null;
}

