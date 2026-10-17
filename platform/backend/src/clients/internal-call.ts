import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Two purposes, one per-process secret, each under its own header name:
 * - in-process: this process is calling the proxy (chat, internal callers).
 *   Authenticates the call for the proxy's credential paths; grants no bypass.
 * - guardrail: the platform's own guardrail models (OpenAPPA annotator and
 *   review calls). Also lets OpenAPPA skip enforcement for that call.
 */
const IN_PROCESS_HEADER = "x-archestra-internal-call";
const GUARDRAIL_HEADER = "x-archestra-guardrail-call";
const secret = randomBytes(32);

/** Proof that a proxy call came from this process. */
export function internalCallHeader(): Record<string, string> {
  return { [IN_PROCESS_HEADER]: secret.toString("base64url") };
}

/** Proof that a proxy call is one of the platform's own guardrail calls. */
export function guardrailCallHeader(): Record<string, string> {
  return { [GUARDRAIL_HEADER]: secret.toString("base64url") };
}

/**
 * Removes both proofs from the headers and reports which were valid. Callers
 * must use this, not a non-destructive check, so the proofs never reach the
 * provider.
 */
export function takeInternalCall(
  headers: Record<string, string | string[] | undefined>,
): { inProcess: boolean; guardrail: boolean } {
  const inProcess = hasProof(headers, IN_PROCESS_HEADER);
  const guardrail = hasProof(headers, GUARDRAIL_HEADER);
  delete headers[IN_PROCESS_HEADER];
  delete headers[GUARDRAIL_HEADER];
  return { inProcess, guardrail };
}

/** Whether the headers carry a valid in-process or guardrail proof. */
export function hasInternalCall(
  headers: Record<string, string | string[] | undefined>,
): boolean {
  return (
    hasProof(headers, IN_PROCESS_HEADER) || hasProof(headers, GUARDRAIL_HEADER)
  );
}

// =========================================================================
// Internal helpers
// =========================================================================

function hasProof(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): boolean {
  const presented = headers[name];
  if (typeof presented !== "string") return false;
  const bytes = Buffer.from(presented, "base64url");
  return bytes.length === secret.length && timingSafeEqual(bytes, secret);
}
