/**
 * Agent helpers shared across backend, frontend, and e2e-tests.
 */

/** Prefix used for agent delegation tools */
export const AGENT_TOOL_PREFIX = "agent__";

/** Prefix used in swap-agent poke text */
export const SWAP_AGENT_POKE_PREFIX = "Swapping to agent: ";

/**
 * Returns true if the tool name is an agent delegation tool.
 */
export function isAgentTool(toolName: string): boolean {
  return toolName.startsWith(AGENT_TOOL_PREFIX);
}

/**
 * Builds the poke text used to trigger a swap to another agent.
 */
export function makeSwapAgentPokeText(agentName: string): string {
  const { TOOL_SWAP_TO_DEFAULT_AGENT_FULL_NAME } = require("./archestra-mcp-server");
  return `${SWAP_AGENT_POKE_PREFIX}${agentName}. Use the ${TOOL_SWAP_TO_DEFAULT_AGENT_FULL_NAME} tool to switch back to the default agent.`;
}

// ---------------------------------------------------------------------------
// Schedule triggers
// ---------------------------------------------------------------------------

/** Supported schedule trigger types */
export type AgentScheduleTriggerType = "cron" | "interval" | "once";

/**
 * A cron-based schedule trigger.
 * `expression` follows standard cron syntax: "minute hour day month weekday"
 */
export interface AgentCronScheduleTrigger {
  type: "cron";
  expression: string;
  /** Optional human-readable label */
  label?: string;
}

/**
 * An interval-based schedule trigger.
 * `intervalMs` is the number of milliseconds between runs.
 */
export interface AgentIntervalScheduleTrigger {
  type: "interval";
  intervalMs: number;
  /** Optional human-readable label */
  label?: string;
}

/**
 * A one-shot schedule trigger that fires at a specific ISO 8601 datetime.
 */
export interface AgentOnceScheduleTrigger {
  type: "once";
  /** ISO 8601 datetime string */
  at: string;
  /** Optional human-readable label */
  label?: string;
}

/** Union of all schedule trigger variants */
export type AgentScheduleTrigger =
  | AgentCronScheduleTrigger
  | AgentIntervalScheduleTrigger
  | AgentOnceScheduleTrigger;

/**
 * Configuration for an agent's schedule trigger, including what prompt
 * to run when the trigger fires.
 */
export interface AgentScheduleTriggerConfig {
  /** Unique identifier for this schedule entry */
  id: string;
  /** The agent identifier (agentId) this schedule belongs to */
  agentId: string;
  /** The trigger definition */
  trigger: AgentScheduleTrigger;
  /** The prompt/message that will be sent to the agent when triggered */
  prompt: string;
  /** Whether this schedule is active */
  enabled: boolean;
  /** ISO 8601 datetime of the last successful run, if any */
  lastRunAt?: string;
  /** ISO 8601 datetime of the next scheduled run, if any */
  nextRunAt?: string;
}

// ---------------------------------------------------------------------------
// Schedule trigger helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if a schedule trigger is currently enabled.
 */
export function isScheduleTriggerEnabled(
  config: AgentScheduleTriggerConfig,
): boolean {
  return config.enabled;
}

/**
 * Returns true if the given trigger is a cron trigger.
 */
export function isCronTrigger(
  trigger: AgentScheduleTrigger,
): trigger is AgentCronScheduleTrigger {
  return trigger.type === "cron";
}

/**
 * Returns true if the given trigger is an interval trigger.
 */
export function isIntervalTrigger(
  trigger: AgentScheduleTrigger,
): trigger is AgentIntervalScheduleTrigger {
  return trigger.type === "interval";
}

/**
 * Returns true if the given trigger is a one-shot trigger.
 */
export function isOnceTrigger(
  trigger: AgentScheduleTrigger,
): trigger is AgentOnceScheduleTrigger {
  return trigger.type === "once";
}

/**
 * Returns a human-readable description of a schedule trigger.
 */
export function describeScheduleTrigger(trigger: AgentScheduleTrigger): string {
  if (trigger.label) {
    return trigger.label;
  }
  switch (trigger.type) {
    case "cron":
      return `Cron: ${trigger.expression}`;
    case "interval":
      return `Every ${trigger.intervalMs}ms`;
    case "once":
      return `Once at ${trigger.at}`;
  }
}

/**
 * Validates a schedule trigger configuration.
 * Returns an array of validation error messages (empty if valid).
 */
export function validateScheduleTrigger(
  trigger: AgentScheduleTrigger,
): string[] {
  const errors: string[] = [];

  switch (trigger.type) {
    case "cron": {
      if (!trigger.expression || trigger.expression.trim() === "") {
        errors.push("Cron expression must not be empty.");
      } else {
        const parts = trigger.expression.trim().split(/\s+/);
        if (parts.length < 5 || parts.length > 6) {
          errors.push(
            "Cron expression must have 5 or 6 space-separated fields.",
          );
        }
      }
      break;
    }
    case "interval": {
      if (!Number.isFinite(trigger.intervalMs) || trigger.intervalMs <= 0) {
        errors.push("intervalMs must be a positive finite number.");
      }
      break;
    }
    case "once": {
      if (!trigger.at || trigger.at.trim() === "") {
        errors.push("'at' must not be empty.");
      } else {
        const d = new Date(trigger.at);
        if (isNaN(d.getTime())) {
          errors.push("'at' must be a valid ISO 8601 datetime string.");
        }
      }
      break;
    }
  }

  return errors;
}