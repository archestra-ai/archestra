/**
 * Instance-wide entity counts reported with analytics heartbeats.
 */
export type InstanceEntityCounts = {
  users: number;
  teams: number;
  /** Internal agents (agentType = 'agent'). */
  agents: number;
  /** Legacy profiles (agentType = 'profile'). */
  profiles: number;
  /** MCP gateways (agentType = 'mcp_gateway'). */
  mcpGateways: number;
  /** LLM proxies (agentType = 'llm_proxy'). */
  llmProxies: number;
  /** Distinct LLM providers with at least one configured API key. */
  llmProviders: number;
  virtualApiKeys: number;
  mcpServers: number;
  conversations: number;
  skills: number;
  apps: number;
  knowledgeBases: number;
};
