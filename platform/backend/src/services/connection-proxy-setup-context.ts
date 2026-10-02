import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { CONNECTION_SETUP_WINDOW_MS } from "@archestra/shared/connection-setup";

const PREFIX = "cps1_";
const SIGNING_DOMAIN = "archestra-connection-proxy-setup-v1:";
const PATH_PREFIX = "/v1/connection-setup/";
const MAX_TOKEN_LENGTH = 2048;
const SAFE_TOKEN = /^cps1_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

interface ProxySetupClaims {
  aud: "connection-proxy-setup";
  organizationId: string;
  virtualApiKeyId: string;
  proxyAgentId: string;
  setupId: string;
  issuedAt: number;
  expiresAt: number;
}

type IssueParams = {
  organizationId: string;
  virtualApiKeyId: string;
  proxyAgentId: string;
  setupId: string;
  secret: string | undefined;
};

// setupId identifies the approving installation, not each inference session.
// Later requests authenticate by org/key/proxy; they do not resend setup tickets.
type VerifyParams = {
  token: string;
  organizationId: string;
  virtualApiKeyId: string;
  proxyAgentId: string;
  secret: string | undefined;
};

/** Short-lived proxy setup capability. Not an authentication credential. */
export function issueConnectionProxySetupContext(params: IssueParams): string {
  if (!params.secret) {
    throw new Error("Connection proxy setup signing key is missing");
  }
  if (
    !isNonEmptyString(params.organizationId) ||
    !isNonEmptyString(params.virtualApiKeyId) ||
    !isNonEmptyString(params.proxyAgentId) ||
    !isNonEmptyString(params.setupId)
  ) {
    throw new Error("Connection proxy setup scope is incomplete");
  }
  const issuedAt = Date.now();
  const claims: ProxySetupClaims = {
    aud: "connection-proxy-setup",
    organizationId: params.organizationId,
    virtualApiKeyId: params.virtualApiKeyId,
    proxyAgentId: params.proxyAgentId,
    setupId: params.setupId,
    issuedAt,
    expiresAt: issuedAt + CONNECTION_SETUP_WINDOW_MS,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const token = `${PREFIX}${payload}.${signature(payload, params.secret).toString("base64url")}`;
  if (token.length > MAX_TOKEN_LENGTH) {
    throw new Error("Connection proxy setup capability is too long");
  }
  return token;
}

/** True only for this org, presented key, proxy, secret, and exact window. */
export function verifyConnectionProxySetupContext(
  params: VerifyParams,
): boolean {
  try {
    return claimsMatch(params);
  } catch {
    return false;
  }
}

/**
 * Map `/v1/connection-setup/<token>/<suffix>` to `/v1/<suffix>`.
 * Stashes a literal token for later verification. Does not authorize.
 */
export function rewriteConnectionProxySetupUrl(
  request: IncomingMessage,
): string {
  const current = readUrl(request);
  const stripped = stripCapabilityPrefix(current);
  if (!stripped) return current;
  remember(request, stripped);
  return stripped.url;
}

/** Opaque token stashed by rewrite, if any. Unverified. */
export function connectionProxySetupContext(
  request: IncomingMessage,
): string | undefined {
  return capabilities.get(request);
}

const capabilities = new WeakMap<IncomingMessage, string>();

function claimsMatch(params: VerifyParams): boolean {
  if (
    !params.secret ||
    !hasCompleteScope(params) ||
    !params.token.startsWith(PREFIX) ||
    params.token.length > MAX_TOKEN_LENGTH
  ) {
    return false;
  }
  const parts = params.token.slice(PREFIX.length).split(".");
  if (parts.length !== 2) return false;
  const [payload, encodedSignature] = parts;
  if (!payload || !encodedSignature) return false;
  const received = decodeCanonicalBase64Url(encodedSignature);
  const payloadBytes = decodeCanonicalBase64Url(payload);
  if (!received || !payloadBytes) return false;
  const expected = signature(payload, params.secret);
  if (
    received.length !== expected.length ||
    !timingSafeEqual(received, expected)
  ) {
    return false;
  }
  const parsed = JSON.parse(payloadBytes.toString("utf8")) as unknown;
  if (!isRecord(parsed)) return false;
  const now = Date.now();
  const issuedAt = readInteger(parsed, "issuedAt");
  const expiresAt = readInteger(parsed, "expiresAt");
  return (
    parsed.aud === "connection-proxy-setup" &&
    readRequiredString(parsed, "organizationId") === params.organizationId &&
    readRequiredString(parsed, "virtualApiKeyId") === params.virtualApiKeyId &&
    readRequiredString(parsed, "proxyAgentId") === params.proxyAgentId &&
    readRequiredString(parsed, "setupId") !== undefined &&
    issuedAt !== undefined &&
    expiresAt !== undefined &&
    issuedAt <= now &&
    expiresAt > now &&
    expiresAt - issuedAt === CONNECTION_SETUP_WINDOW_MS
  );
}

function hasCompleteScope(params: {
  organizationId: string;
  virtualApiKeyId: string;
  proxyAgentId: string;
}): boolean {
  return (
    isNonEmptyString(params.organizationId) &&
    isNonEmptyString(params.virtualApiKeyId) &&
    isNonEmptyString(params.proxyAgentId)
  );
}

function stripCapabilityPrefix(
  url: string,
): { url: string; token: string | undefined } | null {
  if (!url.startsWith(PATH_PREFIX)) return null;
  const rest = url.slice(PATH_PREFIX.length);
  const end = segmentEnd(rest);
  if (end === 0) return null;
  const segment = rest.slice(0, end);
  return {
    url: `/v1${rest.slice(end)}`,
    token: isStorableToken(segment) ? segment : undefined,
  };
}

function segmentEnd(rest: string): number {
  let end = rest.length;
  for (const marker of ["/", "?", "#"]) {
    const index = rest.indexOf(marker);
    if (index >= 0 && index < end) end = index;
  }
  return end;
}

function isStorableToken(segment: string): boolean {
  return segment.length <= MAX_TOKEN_LENGTH && SAFE_TOKEN.test(segment);
}

function remember(
  request: IncomingMessage,
  stripped: { url: string; token: string | undefined },
): void {
  try {
    request.url = stripped.url;
    (request as IncomingMessage & { originalUrl?: string }).originalUrl =
      stripped.url;
    if (stripped.token) capabilities.set(request, stripped.token);
    else capabilities.delete(request);
  } catch {
    return;
  }
}

function readUrl(request: IncomingMessage): string {
  try {
    return typeof request.url === "string" ? request.url : "";
  } catch {
    return "";
  }
}

function signature(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret)
    .update(SIGNING_DOMAIN)
    .update(payload)
    .digest();
}

function decodeCanonicalBase64Url(text: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const bytes = Buffer.from(text, "base64url");
  return bytes.toString("base64url") === text ? bytes : null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequiredString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  return isNonEmptyString(value) ? value : undefined;
}

function readInteger(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : undefined;
}
