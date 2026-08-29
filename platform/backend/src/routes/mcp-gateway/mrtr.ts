import { createHmac, timingSafeEqual } from "node:crypto";

import config from "@/config";

/**
 * Multi Round-Trip Requests (MRTR).
 *
 * Under 2026-07-28 a server may no longer open a server-to-client request
 * mid-call. Instead it answers with an `InputRequiredResult` describing what it
 * needs, and the client re-sends the *original* request with the answers
 * attached. The two requests are fully independent, so any replica can serve
 * the retry — which is the point, and a good fit for our multi-replica gateway.
 *
 * The server carries no state between the two. Everything it needs is encoded
 * into `requestState`, which travels through the client and therefore must be
 * treated as attacker-controlled: the spec requires integrity protection, and
 * requires rejecting state that fails it. This module owns that.
 */

export const INPUT_REQUIRED_RESULT_TYPE = "input_required";
export const COMPLETE_RESULT_TYPE = "complete";

/**
 * The only client requests that may answer with an `InputRequiredResult`.
 * Anything else must not, so the gateway never widens this set by accident.
 */
export const MRTR_SUPPORTED_METHODS = new Set([
  "tools/call",
  "prompts/get",
  "resources/read",
]);

/**
 * How long a `requestState` stays redeemable.
 *
 * Short by design: it bounds the replay window. It still has to outlast a human
 * completing an interactive prompt (an OAuth consent screen, say), so this is a
 * compromise rather than a value to minimise freely.
 */
export const REQUEST_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * How many times one logical call may bounce back for input.
 *
 * Each retry re-runs the tool from the top — the gateway keeps no continuation,
 * which is the whole point of MRTR — so an upstream that elicits on every
 * attempt would re-execute whatever it does before eliciting, once per round,
 * while prompting the user forever. The cap bounds both. It is deliberately
 * small: a tool needing more than a few rounds is asking the wrong way.
 */
export const MAX_INPUT_ROUNDS = 3;

const STATE_VERSION = 1;

/**
 * Domain separator, so a signature minted here can never be mistaken for one
 * produced elsewhere from the same underlying secret.
 */
const HMAC_DOMAIN = "archestra.mcp-gateway.mrtr.request-state.v1";

export type InputRequest = {
  method: "elicitation/create" | "sampling/createMessage" | "roots/list";
  params?: Record<string, unknown>;
};

export type InputRequests = Record<string, InputRequest>;
export type InputResponses = Record<string, unknown>;

export type InputRequiredResult = {
  resultType: typeof INPUT_REQUIRED_RESULT_TYPE;
  inputRequests?: InputRequests;
  requestState?: string;
};

export type RequestStatePayload = {
  /** Schema version, so the format can change without accepting old blobs. */
  v: number;
  /** Authenticated principal the state was minted for. */
  principal: string;
  /** Originating request method. */
  method: string;
  /** Digest of the salient request parameters. */
  paramsDigest: string;
  /** Absolute expiry, epoch milliseconds. */
  exp: number;
  /** Keys issued in the matching `inputRequests`. */
  keys: string[];
  /** How many rounds of input this call has already taken. */
  round: number;
};

export type VerifyFailure =
  | "malformed"
  | "bad_signature"
  | "expired"
  | "principal_mismatch"
  | "request_mismatch"
  | "unsupported_version";

export type VerifyResult =
  | { ok: true; payload: RequestStatePayload }
  | { ok: false; reason: VerifyFailure };

/**
 * Thrown from deep inside tool execution when the gateway needs input it does
 * not have.
 *
 * An exception rather than a return value because the need surfaces several
 * frames down — inside the elicitation callback the MCP client invokes — and
 * every frame between there and the request handler is typed to return a tool
 * result. Unwinding is what lets the handler answer with an
 * `InputRequiredResult` instead.
 */
export class InputRequiredSignal extends Error {
  readonly key: string;
  readonly request: InputRequest;

  constructor(params: { key: string; request: InputRequest }) {
    super(`MCP input required: ${params.request.method}`);
    this.name = "InputRequiredSignal";
    this.key = params.key;
    this.request = params.request;
  }
}

export function isInputRequiredSignal(
  error: unknown,
): error is InputRequiredSignal {
  return error instanceof InputRequiredSignal;
}

/**
 * The single input-request key the gateway issues.
 *
 * Keys need only be unique within one response, and the gateway asks for at
 * most one thing at a time, so a constant keeps the retry correlation trivial.
 */
export const GATEWAY_INPUT_REQUEST_KEY = "gateway_elicitation";

/**
 * Build the `InputRequiredResult` a client sees when the gateway needs input.
 *
 * The spec requires at least one of `inputRequests` or `requestState`; callers
 * that pass neither get an error rather than a result no client can act on.
 */
export function buildInputRequiredResult(params: {
  inputRequests?: InputRequests;
  requestState?: string;
}): InputRequiredResult {
  const { inputRequests, requestState } = params;

  if (!inputRequests && !requestState) {
    throw new Error(
      "InputRequiredResult requires at least one of inputRequests or requestState",
    );
  }

  return {
    resultType: INPUT_REQUIRED_RESULT_TYPE,
    ...(inputRequests && { inputRequests }),
    ...(requestState && { requestState }),
  };
}

/**
 * Mint a signed `requestState`.
 *
 * The payload binds the state to a principal, an originating request, and an
 * expiry. Verification checks all three, which is what stops the blob being
 * replayed by another user, against a different call, or indefinitely.
 */
export function encodeRequestState(params: {
  principal: string;
  method: string;
  requestParams: unknown;
  keys: string[];
  round?: number;
  now?: number;
}): string {
  const {
    principal,
    method,
    requestParams,
    keys,
    round = 1,
    now = Date.now(),
  } = params;

  const payload: RequestStatePayload = {
    v: STATE_VERSION,
    principal,
    method,
    paramsDigest: digestRequestParams(method, requestParams),
    exp: now + REQUEST_STATE_TTL_MS,
    keys: [...keys].sort(),
    round,
  };

  const encoded = base64UrlEncode(JSON.stringify(payload));
  return `${encoded}.${sign(encoded)}`;
}

/**
 * Verify a `requestState` presented on a retry.
 *
 * Order matters: the signature is checked before the payload is trusted for
 * anything, so a forged blob never reaches the comparisons below it.
 */
export function verifyRequestState(params: {
  state: string;
  principal: string;
  method: string;
  requestParams: unknown;
  now?: number;
}): VerifyResult {
  const { state, principal, method, requestParams, now = Date.now() } = params;

  const separator = state.lastIndexOf(".");
  if (separator <= 0 || separator === state.length - 1) {
    return { ok: false, reason: "malformed" };
  }

  const encoded = state.slice(0, separator);
  const signature = state.slice(separator + 1);

  if (!verifySignature(encoded, signature)) {
    return { ok: false, reason: "bad_signature" };
  }

  let payload: RequestStatePayload;
  try {
    payload = JSON.parse(base64UrlDecode(encoded)) as RequestStatePayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (payload?.v !== STATE_VERSION) {
    return { ok: false, reason: "unsupported_version" };
  }

  if (typeof payload.exp !== "number" || payload.exp <= now) {
    return { ok: false, reason: "expired" };
  }

  // Cross-user replay: a blob minted for one caller must not be redeemable by
  // another, even though both may hold a valid token for the same gateway.
  if (payload.principal !== principal) {
    return { ok: false, reason: "principal_mismatch" };
  }

  // Cross-request replay: state minted while eliciting for one tool call must
  // not authorise a different one.
  if (
    payload.method !== method ||
    payload.paramsDigest !== digestRequestParams(method, requestParams)
  ) {
    return { ok: false, reason: "request_mismatch" };
  }

  return { ok: true, payload };
}

/**
 * The principal a `requestState` is bound to.
 *
 * Prefers the individual user; falls back to the token identity for org and
 * team tokens, which have no single user behind them. Two different callers can
 * never collapse onto the same string, which is what the binding relies on.
 */
export function deriveStatePrincipal(auth: {
  userId?: string;
  tokenId?: string;
  organizationId?: string;
}): string {
  if (auth.userId) return `user:${auth.userId}`;
  if (auth.tokenId) return `token:${auth.tokenId}`;
  if (auth.organizationId) return `org:${auth.organizationId}`;
  return "anonymous";
}

/**
 * Whether a method may answer with an `InputRequiredResult`.
 */
export function supportsInputRequired(method: string | undefined): boolean {
  return typeof method === "string" && MRTR_SUPPORTED_METHODS.has(method);
}

/**
 * Read the MRTR fields a client sends on a retry.
 *
 * These come from the raw JSON-RPC body rather than the parsed request: the
 * bundled SDK's `CallToolRequestSchema` drops unknown params, so by the time a
 * request handler runs, both fields are already gone.
 */
export function extractMrtrParams(body: unknown): {
  inputResponses?: InputResponses;
  requestState?: string;
} {
  if (typeof body !== "object" || body === null) return {};
  const params = (body as { params?: unknown }).params;
  if (typeof params !== "object" || params === null) return {};

  const { inputResponses, requestState } = params as {
    inputResponses?: unknown;
    requestState?: unknown;
  };

  return {
    ...(isPlainObject(inputResponses) && {
      inputResponses: inputResponses as InputResponses,
    }),
    ...(typeof requestState === "string" && { requestState }),
  };
}

/**
 * Client capabilities as carried on each request under 2026-07-28, replacing
 * what `initialize` negotiated once per connection.
 */
export function readClientCapabilities(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return undefined;
  const params = (body as { params?: unknown }).params;
  if (typeof params !== "object" || params === null) return undefined;
  const meta = (params as { _meta?: unknown })._meta;
  if (typeof meta !== "object" || meta === null) return undefined;
  return (meta as Record<string, unknown>)[MCP_CLIENT_CAPABILITIES_META_KEY];
}

/**
 * `_meta` key carrying client capabilities on every request.
 */
export const MCP_CLIENT_CAPABILITIES_META_KEY =
  "io.modelcontextprotocol/clientCapabilities";

/**
 * Whether the client declared support for the capability an input request
 * needs. The spec forbids asking a client for something it never said it could
 * do, so an undeclared capability means the gateway must fail the call rather
 * than elicit into the void.
 */
export function clientSupportsInputRequest(params: {
  clientCapabilities: unknown;
  request: InputRequest;
}): boolean {
  const { clientCapabilities, request } = params;
  if (!isPlainObject(clientCapabilities)) return false;

  const capabilityName = CAPABILITY_BY_METHOD[request.method];
  if (!capabilityName) return false;

  return capabilityName in (clientCapabilities as Record<string, unknown>);
}

// =============================================================================
// Internal helpers
// =============================================================================

const CAPABILITY_BY_METHOD: Record<string, string> = {
  "elicitation/create": "elicitation",
  "sampling/createMessage": "sampling",
  "roots/list": "roots",
};

/**
 * Derived from the session-signing secret rather than a new env var, so an
 * existing deployment gains MRTR without new configuration. Deployments have a
 * secret already; without one the gateway cannot sign, and callers below fail
 * closed rather than emitting unprotected state.
 */
function hmacKey(): string | null {
  const secret = config.auth.secret;
  if (!secret) return null;
  return createHmac("sha256", secret).update(HMAC_DOMAIN).digest("hex");
}

function sign(encoded: string): string {
  const key = hmacKey();
  if (!key) {
    throw new Error(
      "Cannot sign MRTR request state: no auth secret is configured",
    );
  }
  const hmac = createHmac("sha256", key);
  // codeql[js/insufficient-password-hash] This HMAC authenticates opaque request state; it does not store or verify passwords.
  return hmac.update(encoded).digest("base64url");
}

function verifySignature(encoded: string, signature: string): boolean {
  const key = hmacKey();
  if (!key) return false;

  const expected = createHmac("sha256", key)
    .update(encoded)
    .digest("base64url");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);

  // Length must match before timingSafeEqual, which throws on a mismatch —
  // and the comparison stays constant-time for equal-length input.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Digest of the fields that identify a request.
 *
 * Only the identifying fields are digested, never the whole params object. The
 * two sides see different objects — the signing side has the parsed request,
 * the verifying side has the raw JSON-RPC body, which also carries `_meta` and
 * the MRTR fields — so digesting everything would make every retry fail to
 * match. Narrowing to the fields that actually name the operation is what lets
 * both sides agree.
 */
function digestRequestParams(method: string, requestParams: unknown): string {
  const key = hmacKey();
  if (!key) {
    throw new Error(
      "Cannot digest MRTR request parameters: no auth secret is configured",
    );
  }

  // Key the digest because request parameters may contain credentials. A
  // plain hash inside the client-visible state would permit offline guessing.
  return createHmac("sha256", key)
    .update(stableStringify(canonicalRequestParams(method, requestParams)))
    .digest("base64url");
}

function canonicalRequestParams(
  method: string,
  requestParams: unknown,
): Record<string, unknown> {
  if (!isPlainObject(requestParams)) return {};
  const params = requestParams as Record<string, unknown>;

  switch (method) {
    case "tools/call":
    case "prompts/get":
      return { name: params.name ?? null, arguments: params.arguments ?? {} };
    case "resources/read":
      return { uri: params.uri ?? null };
    default:
      return {};
  }
}

/**
 * Key-ordered JSON, so two structurally equal parameter objects always digest
 * the same regardless of the order the client happened to serialise them in.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);

  return `{${entries.join(",")}}`;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function isPlainObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
