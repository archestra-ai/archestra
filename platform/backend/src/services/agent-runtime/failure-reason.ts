import { z } from "zod";

/** Decode the image-owned failure envelope without interpreting its code. */
export function agentRuntimeFailureReason(result: string): string {
  const separator = result.indexOf("\n");
  const status = (
    separator === -1 ? result : result.slice(0, separator)
  ).trim();
  const exitStatus = /^\d{1,3}$/.test(status) ? status : "unknown";
  const fallback = `The Agent Runtime turn exited with status ${exitStatus}`;
  if (separator === -1) return fallback;
  const payload = result.slice(separator + 1);
  if (Buffer.byteLength(payload, "utf8") > 4096) return fallback;
  try {
    const failure = FailureSchema.safeParse(JSON.parse(payload));
    return failure.success
      ? `${failure.data.message} (Runtime exit status ${exitStatus}.)`
      : fallback;
  } catch {
    return fallback;
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
