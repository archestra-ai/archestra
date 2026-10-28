import { ApiError } from "@archestra/shared/types";
import type { A2ATaskFailure } from "@/types/a2a-task";

/**
 * The one vocabulary of machine-readable Agent Runtime failure codes.
 *
 * A failed run carries `{ code, retriable }` next to its human-readable
 * status reason, so a client can decide whether to try again without
 * matching message text. `retriable` means a new run of the same Agent is
 * likely to succeed without a configuration change. Image-owned envelope
 * codes are passed through as `image.<code>`; see {@link imageEnvelopeFailure}.
 * Keep this table and the Agent Runtime docs page in sync.
 */
const AGENT_RUN_FAILURE_CODES = {
  /** The Kubernetes API was overloaded or unavailable during launch. */
  "launch.kubernetes_unavailable": { retriable: true },
  /** The Kubernetes API refused a launch request (permissions, validation). */
  "launch.kubernetes_rejected": { retriable: false },
  /** The cluster does not run the Agent Sandbox controller. */
  "launch.controller_missing": { retriable: false },
  /** The pod did not start or resume within the startup timeout. */
  "launch.capacity_timeout": { retriable: true },
  /**
   * The Agent's runtime configuration or the caller's credentials do not allow
   * a start (missing credentials, a credential the image cannot use).
   */
  "launch.misconfigured": { retriable: false },
  /** The turn's credentials did not reach the pod before its startup timeout. */
  "launch.credentials_timeout": { retriable: true },
  /** Kubernetes evicted or preempted the pod. */
  "pod.evicted": { retriable: true },
  /** A container in the pod ran out of memory. */
  "pod.oom_killed": { retriable: false },
  /** The image could not be pulled. */
  "pod.image_pull": { retriable: false },
  /** The pod failed for another reason. */
  "pod.failed": { retriable: false },
  /** The pod was replaced while the turn ran; the turn is never replayed. */
  "turn.interrupted": { retriable: true },
  /** The terminal recording stopped, so the turn was stopped. */
  "turn.recording_failed": { retriable: true },
  /** The agent process exited before it reported a result. */
  "turn.process_exited": { retriable: false },
  /** The turn exited non-zero without a failure envelope. */
  "turn.exit_status": { retriable: false },
  /** The run reached its maximum LLM cost (`maxCostUsd`). */
  "budget.exceeded": { retriable: false },
  /** The Agent's image or privilege setting changed under a retained workspace. */
  "run.settings_changed": { retriable: false },
  /** The retained workspace cannot take this turn (owner, retention, state). */
  "run.resume_refused": { retriable: false },
  /** Another turn claimed the retained workspace first. */
  "run.workspace_busy": { retriable: true },
  /** The workspace was removed while the turn ran. */
  "run.workspace_missing": { retriable: false },
  /** The workspace reached its lifetime deadline while the turn ran. */
  "run.deadline_exceeded": { retriable: false },
  /** No more specific classification applies. */
  "run.unknown": { retriable: false },
} as const satisfies Record<string, { retriable: boolean }>;

export type AgentRunFailureCode = keyof typeof AGENT_RUN_FAILURE_CODES;

export function agentRunFailure(code: AgentRunFailureCode): A2ATaskFailure {
  return { code, retriable: AGENT_RUN_FAILURE_CODES[code].retriable };
}

/**
 * Classify a failure envelope code. Codes written by platform-owned scripts
 * (`runtime.*`) map onto the platform vocabulary; every other code belongs to
 * the image and passes through as `image.<code>`. Maintained-image codes that
 * name a transient provider, proxy or startup problem are retriable; unknown
 * image codes are not.
 */
export function imageEnvelopeFailure(envelopeCode: string): A2ATaskFailure {
  const platformCode = RUNTIME_ENVELOPE_CODES[envelopeCode];
  if (platformCode) return agentRunFailure(platformCode);
  return {
    code: `image.${envelopeCode}`,
    retriable: RETRIABLE_IMAGE_ENVELOPE_CODES.has(envelopeCode),
  };
}

/**
 * Attach a classification to an error at the place that knows what went
 * wrong, without changing the error's type, status or message.
 */
export function tagAgentRunFailure<T extends Error>(
  error: T,
  failure: AgentRunFailureCode | A2ATaskFailure,
): T {
  Object.defineProperty(error, FAILURE_PROPERTY, {
    value: typeof failure === "string" ? agentRunFailure(failure) : failure,
    enumerable: false,
  });
  return error;
}

/**
 * Classification for an error that settles a run as failed: the nearest tag
 * on the error or its causes, else `launch.misconfigured` for a client error
 * the start path raised (missing credentials, an unusable credential or
 * model), else `run.unknown`.
 */
export function classifyAgentRunFailure(error: unknown): A2ATaskFailure {
  const seen = new Set<unknown>();
  for (
    let current: unknown = error;
    current instanceof Error && !seen.has(current);
    current = current.cause
  ) {
    seen.add(current);
    const tagged = (current as { [FAILURE_PROPERTY]?: A2ATaskFailure })[
      FAILURE_PROPERTY
    ];
    if (tagged) return tagged;
  }
  if (
    error instanceof ApiError &&
    error.statusCode >= 400 &&
    error.statusCode < 500
  ) {
    return agentRunFailure("launch.misconfigured");
  }
  return agentRunFailure("run.unknown");
}

// ===================== internals =====================

const FAILURE_PROPERTY = Symbol("agentRunFailure");

const RUNTIME_ENVELOPE_CODES: Record<string, AgentRunFailureCode> = {
  "runtime.interrupted": "turn.interrupted",
  "runtime.recording_failed": "turn.recording_failed",
  "runtime.pane_exited": "turn.process_exited",
  "runtime.credential_projection_timeout": "launch.credentials_timeout",
};

/** Maintained-image codes (docker_images/agent) for transient problems. */
const RETRIABLE_IMAGE_ENVELOPE_CODES = new Set([
  // Claude Code StopFailure: rate limit, provider overloaded or server error.
  "claude_rate_limit",
  "claude_unavailable",
  // Grok Build StopFailure or ACP driver failure: provider or CLI, not the model.
  "grok_unavailable",
  // Kimi Code StopFailure or print-mode failure: provider or CLI, not the model.
  "kimi_unavailable",
  // Shared initialization could not reach the platform proxy.
  "proxy_unavailable",
  // The MCP gateway tools did not load at startup.
  "mcp_startup",
  // The task did not reach the Agent's terminal.
  "task_submission",
]);
