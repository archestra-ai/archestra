import type { AgentType } from "@shared";

export function getNamePlaceholder(agentType: AgentType): string {
  const placeholders: Record<AgentType, string> = {
    mcp_gateway: "Enter MCP Gateway name",
    llm_proxy: "Enter LLM Proxy name",
    agent: "Enter agent name",
    profile: "Enter profile name",
  };
  return placeholders[agentType];
}

export function getDescriptionPlaceholder(agentType: AgentType): string {
  const placeholders: Record<AgentType, string> = {
    mcp_gateway: "Describe what this MCP Gateway is for",
    llm_proxy: "Describe what this LLM Proxy is for",
    agent: "Describe what this agent does",
    profile: "Describe what this profile is for",
  };
  return placeholders[agentType];
}

export function shouldShowDescriptionField(params: {
  agentType: AgentType;
  isBuiltIn: boolean;
}) {
  return !params.isBuiltIn;
}
