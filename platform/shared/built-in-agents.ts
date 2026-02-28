/**
 * Built-in agent identifiers and names.
 * Used across backend, frontend, and e2e-tests.
 */

/** Display names for built-in agents */
export const BUILT_IN_AGENT_NAMES = {
  POLICY_CONFIG: "Policy Configuration Subagent",
} as const;

/** Discriminator values for builtInAgentConfig.name */
export const BUILT_IN_AGENT_IDS = {
  POLICY_CONFIG: "policy-configuration-subagent",
} as const;
