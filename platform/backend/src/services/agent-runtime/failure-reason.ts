import {
  type AgentRuntimeError,
  AgentRuntimeErrorSchema,
  formatAgentRuntimeError,
} from "@archestra/shared";
import { z } from "zod";

const code = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.-]+$/);
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: reject terminal control characters in image-authored messages
    .refine((value) => !/[\x00-\x08\x0b-\x1f\x7f]/.test(value));

/** The pre-event-bus sidecar accepted only code and message. Keep it readable. */
const LegacyFailureSchema = z
  .object({
    version: z.literal(1),
    code,
    phase: z
      .enum([
        "startup",
        "credentials",
        "provider",
        "tool",
        "terminal",
        "protocol",
      ])
      .optional(),
    message: text(2000),
    resolution: text(1000).optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
  })
  .strict();

type AgentRuntimeFailure = {
  exitStatus: string;
  error: AgentRuntimeError;
};

/** Decode a bounded image-owned failure sidecar, without trusting its vocabulary. */
function parseAgentRuntimeFailure(result: string): AgentRuntimeFailure {
  const separator = result.indexOf("\n");
  const status = (
    separator === -1 ? result : result.slice(0, separator)
  ).trim();
  const exitStatus = /^\d{1,3}$/.test(status) ? status : "unknown";
  const fallback = fallbackError(exitStatus);
  if (separator === -1) return { exitStatus, error: fallback };
  const payload = result.slice(separator + 1);
  if (Buffer.byteLength(payload, "utf8") > 4096)
    return { exitStatus, error: fallback };
  try {
    const value: unknown = JSON.parse(payload);
    const structured = AgentRuntimeErrorSchema.safeParse(value);
    if (structured.success) return { exitStatus, error: structured.data };
    const legacy = LegacyFailureSchema.safeParse(value);
    if (legacy.success)
      return {
        exitStatus,
        error: {
          code: legacy.data.code,
          phase: legacy.data.phase ?? "terminal",
          message: legacy.data.message,
          resolution:
            legacy.data.resolution ??
            "Open the run logs to inspect the last output, then retry the run.",
          ...(legacy.data.httpStatus
            ? { httpStatus: legacy.data.httpStatus }
            : {}),
        },
      };
  } catch {
    // Keep provider and image-authored bodies out of task summaries.
  }
  return { exitStatus, error: fallback };
}

/** Render the same typed error used by the event monitor and notifications. */
export function agentRuntimeFailureReason(result: string): string {
  const failure = parseAgentRuntimeFailure(result);
  const rendered = formatAgentRuntimeError(failure.error);
  return failure.error.code === "unknown_exit"
    ? `${rendered} (Runtime exit status ${failure.exitStatus}.)`
    : rendered;
}

function fallbackError(exitStatus: string): AgentRuntimeError {
  return {
    code: exitStatus === "75" ? "runtime_unavailable" : "unknown_exit",
    phase: exitStatus === "75" ? "startup" : "terminal",
    message:
      exitStatus === "75"
        ? "The runtime became unavailable before a result was recorded."
        : "The agent stopped without reporting a structured failure reason.",
    resolution:
      exitStatus === "75"
        ? "Review the run logs and runtime capacity, then retry after the runtime is available."
        : "Open the run logs to inspect the last output, then check the agent configuration before retrying.",
  };
}
