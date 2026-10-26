import { z } from "zod";
import type { A2ATaskFailure } from "@/types/a2a-task";
import { agentRunFailure, imageEnvelopeFailure } from "./run-failure";

/** Decode the image-owned failure envelope without interpreting its code. */
export function agentRuntimeFailureReason(result: string): string {
  const { exitStatus, envelope } = parseTurnResult(result);
  return envelope
    ? `${envelope.message} (Runtime exit status ${exitStatus}.)`
    : `The Agent Runtime turn exited with status ${exitStatus}`;
}

/** Classify a failed turn result: its envelope code, else the bare exit. */
export function agentRuntimeTurnFailure(result: string): A2ATaskFailure {
  const { envelope } = parseTurnResult(result);
  return envelope
    ? imageEnvelopeFailure(envelope.code)
    : agentRunFailure("turn.exit_status");
}

// ===================== internals =====================

function parseTurnResult(result: string): {
  exitStatus: string;
  envelope: z.infer<typeof FailureSchema> | null;
} {
  const separator = result.indexOf("\n");
  const status = (
    separator === -1 ? result : result.slice(0, separator)
  ).trim();
  const exitStatus = /^\d{1,3}$/.test(status) ? status : "unknown";
  if (separator === -1) return { exitStatus, envelope: null };
  const payload = result.slice(separator + 1);
  if (Buffer.byteLength(payload, "utf8") > 4096)
    return { exitStatus, envelope: null };
  try {
    const failure = FailureSchema.safeParse(JSON.parse(payload));
    return { exitStatus, envelope: failure.success ? failure.data : null };
  } catch {
    return { exitStatus, envelope: null };
  }
}

// Images own the vocabulary and must sanitize messages before publishing them.
// Plain text only: terminal control sequences must not enter task summaries.
const FailureSchema = z
  .object({
    version: z.literal(1),
    code: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_.-]+$/),
    message: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: reject terminal control characters in image-authored messages
      .refine((message) => !/[\x00-\x08\x0b-\x1f\x7f]/.test(message)),
  })
  .strict();
