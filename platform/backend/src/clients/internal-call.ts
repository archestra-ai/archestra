import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Per-process proof that an LLM proxy call came from this process (chat,
 * subagents, title generation, app runtime, A2A and scheduled runs — every
 * caller that builds its model through `createLLMModel`).
 *
 * The socket peer cannot stand in for this: the frontend rewrites public
 * `/v1/*` traffic to the API over loopback, so a remote request arrives from
 * 127.0.0.1 too. The value is random per process and never configured, so
 * nothing changes for a deployment and nothing outside this process holds it.
 */
const PROOF_HEADER = "x-archestra-internal-call";
const PROOF_VALUE = randomBytes(32);

/** Header an in-process caller attaches to its proxy requests. */
export function internalCallHeader(): Record<string, string> {
  return { [PROOF_HEADER]: PROOF_VALUE.toString("base64url") };
}

/**
 * Whether the request carried a valid proof. The first call verifies the
 * header and removes it from both the parsed and raw headers, so the proof
 * never reaches a provider or a log; later calls for the same request return
 * that first answer. A missing, malformed, wrong or repeated header is false.
 */
export function isInternalCall(request: ProofCarrier): boolean {
  const key = request.raw ?? request;
  const result = verified.get(key) ?? hasProof(request.headers[PROOF_HEADER]);
  for (const headers of new Set([request.headers, request.raw?.headers])) {
    if (headers) delete headers[PROOF_HEADER];
  }
  const rawHeaders = request.raw?.rawHeaders;
  if (rawHeaders) {
    for (let i = rawHeaders.length - 2; i >= 0; i -= 2) {
      if (rawHeaders[i].toLowerCase() === PROOF_HEADER) {
        rawHeaders.splice(i, 2);
      }
    }
  }
  verified.set(key, result);
  return result;
}

// =========================================================================
// Internal helpers
// =========================================================================

type Headers = Record<string, string | string[] | undefined>;
type ProofCarrier = {
  headers: Headers;
  raw?: { headers: Headers; rawHeaders?: string[] };
};

const verified = new WeakMap<object, boolean>();

function hasProof(presented: string | string[] | undefined): boolean {
  if (typeof presented !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(presented))
    return false;
  const bytes = Buffer.from(presented, "base64url");
  return (
    bytes.toString("base64url") === presented &&
    bytes.length === PROOF_VALUE.length &&
    timingSafeEqual(bytes, PROOF_VALUE)
  );
}
