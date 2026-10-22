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

type Headers = Record<string, string | string[] | undefined>;
type ProofCarrier = {
  headers: Headers;
  raw?: { headers: Headers; rawHeaders?: string[] };
};
type Provenance = { inProcess: boolean; guardrail: boolean };
const verified = new WeakMap<object, Provenance>();

/**
 * Capture provenance before header validation, and retain it for every reader
 * of the same raw request. Neither a schema transform nor a previous reader
 * can erase it or upgrade an outside request later.
 */
export function internalCallProvenance(request: ProofCarrier): Provenance {
  const key = request.raw ?? request;
  const result = verified.get(key) ?? verifyInternalCall(request.headers);
  verified.set(key, result);
  // Later hooks may rebuild header views, so cleanup is required on cache hits.
  for (const headers of new Set([request.headers, request.raw?.headers])) {
    if (headers) {
      delete headers[IN_PROCESS.header];
      delete headers[GUARDRAIL.header];
    }
  }
  const rawHeaders = request.raw?.rawHeaders;
  if (rawHeaders) {
    for (let i = rawHeaders.length - 2; i >= 0; i -= 2) {
      const name = rawHeaders[i].toLowerCase();
      if (name === IN_PROCESS.header || name === GUARDRAIL.header) {
        rawHeaders.splice(i, 2);
      }
    }
  }
  return result;
}

/** Verify each proof's purpose; the caller owns cleanup of all header views. */
function verifyInternalCall(
  headers: Record<string, string | string[] | undefined>,
): { inProcess: boolean; guardrail: boolean } {
  return {
    inProcess: hasProof(headers, IN_PROCESS),
    guardrail: hasProof(headers, GUARDRAIL),
  };
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
  if (typeof presented !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(presented))
    return false;
  const bytes = Buffer.from(presented, "base64url");
  return (
    bytes.toString("base64url") === presented &&
    bytes.length === proof.value.length &&
    timingSafeEqual(bytes, proof.value)
  );
}
