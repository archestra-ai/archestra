/**
 * Context condition keys used in policy evaluation.
 * These are used by both frontend (policy condition UI) and backend (policy evaluation).
 */
export const CONTEXT_EXTERNAL_AGENT_ID = "context.externalAgentId";
export const CONTEXT_TEAM_IDS = "context.teamIds";

/**
 * All context condition keys for iteration/validation.
 */
export const CONTEXT_CONDITION_KEYS = [
  CONTEXT_EXTERNAL_AGENT_ID,
  CONTEXT_TEAM_IDS,
] as const;

export type ContextConditionKey = (typeof CONTEXT_CONDITION_KEYS)[number];
