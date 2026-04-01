const POLICY_CONFIG_TOOL_CONTEXT_KEY = "tool";

export const POLICY_CONFIG_SYSTEM_PROMPT_VARIABLE_PATHS = {
  toolName: `${POLICY_CONFIG_TOOL_CONTEXT_KEY}.name`,
  toolDescription: `${POLICY_CONFIG_TOOL_CONTEXT_KEY}.description`,
  toolParameters: `${POLICY_CONFIG_TOOL_CONTEXT_KEY}.parameters`,
  toolAnnotations: `${POLICY_CONFIG_TOOL_CONTEXT_KEY}.annotations`,
  mcpServerName: "mcpServerName",
} as const;

export const POLICY_CONFIG_SYSTEM_PROMPT_EXPRESSIONS = {
  toolName: toTemplateExpression(
    POLICY_CONFIG_SYSTEM_PROMPT_VARIABLE_PATHS.toolName,
  ),
  toolDescription: toTemplateExpression(
    POLICY_CONFIG_SYSTEM_PROMPT_VARIABLE_PATHS.toolDescription,
  ),
  toolParameters: toTemplateExpression(
    POLICY_CONFIG_SYSTEM_PROMPT_VARIABLE_PATHS.toolParameters,
  ),
  toolAnnotations: toTemplateExpression(
    POLICY_CONFIG_SYSTEM_PROMPT_VARIABLE_PATHS.toolAnnotations,
  ),
  mcpServerName: toTemplateExpression(
    POLICY_CONFIG_SYSTEM_PROMPT_VARIABLE_PATHS.mcpServerName,
  ),
} as const;

export const POLICY_CONFIG_SYSTEM_PROMPT_TEMPLATE_EXPRESSIONS = [
  {
    expression: POLICY_CONFIG_SYSTEM_PROMPT_EXPRESSIONS.toolName,
    description: "Name of the MCP tool being evaluated",
  },
  {
    expression: POLICY_CONFIG_SYSTEM_PROMPT_EXPRESSIONS.toolDescription,
    description: "Description of the MCP tool being evaluated",
  },
  {
    expression: POLICY_CONFIG_SYSTEM_PROMPT_EXPRESSIONS.toolParameters,
    description: "JSON schema for the MCP tool parameters",
  },
  {
    expression: POLICY_CONFIG_SYSTEM_PROMPT_EXPRESSIONS.toolAnnotations,
    description: "MCP tool annotations such as read-only or destructive hints",
  },
  {
    expression: POLICY_CONFIG_SYSTEM_PROMPT_EXPRESSIONS.mcpServerName,
    description: "Name of the MCP server that provides the tool",
  },
] as const;

export function buildPolicyConfigSystemPromptContext(params: {
  toolName: string;
  toolDescription: string;
  toolParameters: string;
  toolAnnotations: string;
  mcpServerName: string;
}) {
  return {
    [POLICY_CONFIG_TOOL_CONTEXT_KEY]: {
      name: params.toolName,
      description: params.toolDescription,
      parameters: params.toolParameters,
      annotations: params.toolAnnotations,
    },
    mcpServerName: params.mcpServerName,
  };
}

function toTemplateExpression(path: string) {
  return `{{${path}}}`;
}
