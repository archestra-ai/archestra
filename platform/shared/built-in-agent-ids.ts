/** Discriminator values for builtInAgentConfig.name */
export const BUILT_IN_AGENT_IDS = {
  SRE: "sre-agent",
  OPENAPPA_CONFIG: "openappa-configuration-agent",
  CONTEXT_COMPACTION: "context-compaction-subagent",
  CHAT_TITLE_GENERATION: "chat-title-generation-subagent",
  APP_RUNTIME: "app-runtime-llm-agent",
} as const;
