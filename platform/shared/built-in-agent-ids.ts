/** Discriminator values for builtInAgentConfig.name. */
export const BUILT_IN_AGENT_IDS = {
  POLICY_CONFIG: "policy-configuration-subagent",
  DUAL_LLM_MAIN: "dual-llm-main-agent",
  DUAL_LLM_QUARANTINE: "dual-llm-quarantine-agent",
  CONTEXT_COMPACTION: "context-compaction-subagent",
  CHAT_TITLE_GENERATION: "chat-title-generation-subagent",
  APP_RUNTIME: "app-runtime-llm-agent",
  ADVISOR: "advisor-agent",
} as const;
