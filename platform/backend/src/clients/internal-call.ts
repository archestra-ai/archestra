import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Two per-process proofs, each under its own header name and with its own
 * random value, so one cannot be presented as the other:
 * - in-process: this process is calling the proxy (chat, internal callers).
 *   Authenticates the call for the proxy's credential paths; grants no bypass.
 * - guardrail: the platform's own guardrail models (OpenAPPA annotator and
 *   review calls). Also lets OpenAPPA skip enforcement for that call.
 */
const IN_PROCESS: Proof = {
  header: "x-archestra-internal-call",
  value: randomBytes(32),
};
const GUARDRAIL: Proof = {
  header: "x-archestra-guardrail-call",
  value: randomBytes(32),
};

/** Proof that a proxy call came from this process. */
export function internalCallHeader(): Record<string, string> {
  return proofHeader(IN_PROCESS);
}

/** Proof that a proxy call is one of the platform's own guardrail calls. */
export function guardrailCallHeader(): Record<string, string> {
  return proofHeader(GUARDRAIL);
}

/**
 * Removes both proofs from the headers and reports which were valid. Every
 * check goes through this, so the proofs never reach the provider.
 */
export function takeInternalCall(
  headers: Record<string, string | string[] | undefined>,
): { inProcess: boolean; guardrail: boolean } {
  const inProcess = hasProof(headers, IN_PROCESS);
  const guardrail = hasProof(headers, GUARDRAIL);
  delete headers[IN_PROCESS.header];
  delete headers[GUARDRAIL.header];
  return { inProcess, guardrail };
}

// =========================================================================
// Internal helpers
// =========================================================================

type Proof = { header: string; value: Buffer };

function proofHeader(proof: Proof): Record<string, string> {
  return { [proof.header]: proof.value.toString("base64url") };
}

function hasProof(
  headers: Record<string, string | string[] | undefined>,
  proof: Proof,
): boolean {
  const presented = headers[proof.header];
  if (typeof presented !== "string") return false;
  const bytes = Buffer.from(presented, "base64url");
  return (
    bytes.length === proof.value.length && timingSafeEqual(bytes, proof.value)
  );
}
