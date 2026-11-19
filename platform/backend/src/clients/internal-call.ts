import { randomBytes, timingSafeEqual } from "node:crypto";
import { drainScopeHeaders } from "@/utils/drain-scope";

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
const SERVICE_ACCOUNT_HEADER = "x-archestra-internal-service-account";

const GUARDRAIL: Proof = {
  header: "x-archestra-guardrail-call",
  value: randomBytes(32),
};

/** Proof that a proxy call came from this process. */
export function internalCallHeader(
  serviceAccountId?: string,
): Record<string, string> {
  return {
    ...proofHeader(IN_PROCESS),
    ...drainScopeHeaders(),
    ...(serviceAccountId ? { [SERVICE_ACCOUNT_HEADER]: serviceAccountId } : {}),
  };
}

/** Proof that a proxy call is one of the platform's own guardrail calls. */
export function guardrailCallHeader(): Record<string, string> {
  return { ...proofHeader(GUARDRAIL), ...drainScopeHeaders() };
}

type Headers = Record<string, string | string[] | undefined>;
type ProofCarrier = {
  headers: Headers;
  raw?: { headers: Headers; rawHeaders?: string[] };
};
type Provenance = {
  inProcess: boolean;
  guardrail: boolean;
  /** Server-resolved actor, accepted only with the in-process proof. */
  serviceAccountId?: string;
};
const verified = new WeakMap<object, Provenance>();

/**
 * Capture provenance before header validation, and retain it for every reader
 * of the same raw request. Neither a schema transform nor a previous reader
 * can erase it or upgrade an outside request later.
 */
export function internalCallProvenance(request: ProofCarrier): Provenance {
  const key = request.raw ?? request;
  const result = verified.get(key) ?? verifyInternalCall(request);
  verified.set(key, result);
  // Later hooks may rebuild header views, so cleanup is required on cache hits.
  for (const headers of new Set([request.headers, request.raw?.headers])) {
    if (headers) {
      delete headers[IN_PROCESS.header];
      delete headers[GUARDRAIL.header];
      delete headers[SERVICE_ACCOUNT_HEADER];
    }
  }
  const rawHeaders = request.raw?.rawHeaders;
  if (rawHeaders) {
    for (let i = rawHeaders.length - 2; i >= 0; i -= 2) {
      const name = rawHeaders[i].toLowerCase();
      if (
        name === IN_PROCESS.header ||
        name === GUARDRAIL.header ||
        name === SERVICE_ACCOUNT_HEADER
      ) {
        rawHeaders.splice(i, 2);
      }
    }
  }
  return result;
}

/** Verify each proof's purpose; the caller owns cleanup of all header views. */
function verifyInternalCall(request: ProofCarrier): Provenance {
  const { headers } = request;
  const inProcess = hasProof(headers, IN_PROCESS);
  const account = headers[SERVICE_ACCOUNT_HEADER];
  const duplicate =
    (request.raw?.rawHeaders?.filter(
      (name, index) =>
        index % 2 === 0 && name.toLowerCase() === SERVICE_ACCOUNT_HEADER,
    ).length ?? 0) > 1;
  // The ordinary user attribution header never authenticates a principal.
  // Only the trusted model constructor supplies this separate actor carrier.
  const serviceAccountId =
    inProcess &&
    !duplicate &&
    typeof account === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      account,
    )
      ? account
      : undefined;
  return {
    inProcess,
    guardrail: hasProof(headers, GUARDRAIL),
    ...(serviceAccountId ? { serviceAccountId } : {}),
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
