import { BUILT_IN_AGENT_IDS } from "./built-in-agents";

/**
 * System prompt template variables and helpers available for Handlebars templating.
 * Used by both the backend (for rendering) and frontend (for documentation/UI hints).
 */

export const SYSTEM_PROMPT_VARIABLES = [
  {
    expression: "{{user.name}}",
    description: "Name of the user invoking the agent",
  },
  {
    expression: "{{user.email}}",
    description: "Email of the user invoking the agent",
  },
  {
    expression: "{{user.teams}}",
    description: "Team names the user belongs to (array)",
  },
] as const;

export const SYSTEM_PROMPT_HELPERS = [
  {
    expression: "{{currentDate}}",
    description: "Current date in UTC (YYYY-MM-DD)",
  },
  {
    expression: "{{currentTime}}",
    description: "Current time in UTC (HH:MM:SS UTC)",
  },
] as const;

/**
 * All available template expressions (variables + helpers) for display in the UI.
 */
export const SYSTEM_PROMPT_TEMPLATE_EXPRESSIONS = [
  ...SYSTEM_PROMPT_VARIABLES,
  ...SYSTEM_PROMPT_HELPERS,
] as const;

export const POLICY_CONFIG_SYSTEM_PROMPT_TEMPLATE_EXPRESSIONS = [
  {
    expression: "{{tool.name}}",
    description: "Name of the MCP tool being evaluated",
  },
  {
    expression: "{{tool.description}}",
    description: "Description of the MCP tool being evaluated",
  },
  {
    expression: "{{tool.parameters}}",
    description: "JSON schema for the MCP tool parameters",
  },
  {
    expression: "{{tool.annotations}}",
    description: "MCP tool annotations such as read-only or destructive hints",
  },
  {
    expression: "{{mcpServerName}}",
    description: "Name of the MCP server that provides the tool",
  },
] as const;

export function getSystemPromptTemplateExpressions(params?: {
  builtInAgentId?: string | null;
}) {
  if (params?.builtInAgentId === BUILT_IN_AGENT_IDS.POLICY_CONFIG) {
    return [
      ...SYSTEM_PROMPT_TEMPLATE_EXPRESSIONS,
      ...POLICY_CONFIG_SYSTEM_PROMPT_TEMPLATE_EXPRESSIONS,
    ];
  }

  return SYSTEM_PROMPT_TEMPLATE_EXPRESSIONS;
}
