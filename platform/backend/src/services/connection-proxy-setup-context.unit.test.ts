import { createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { CONNECTION_SETUP_WINDOW_MS } from "@archestra/shared/connection-setup";
import { afterEach, expect, test, vi } from "vitest";
import {
  connectionProxySetupContext,
  issueConnectionProxySetupContext,
  rewriteConnectionProxySetupUrl,
  verifyConnectionProxySetupContext,
} from "./connection-proxy-setup-context";
import {
  issueConnectionSetupContext,
  verifyConnectionSetupContext,
} from "./connection-setup-context";

const PREFIX = "cps1_";
const DOMAIN = "archestra-connection-proxy-setup-v1:";
const scope = {
  organizationId: "org-1",
  virtualApiKeyId: "virtual-key-1",
  proxyAgentId: "proxy-1",
  setupId: "setup-1",
  secret: "a-shared-signing-key-for-proxy-setup",
};

afterEach(() => vi.useRealTimers());

test("the capability is bound to org, presented key, and proxy", () => {
  const token = issueConnectionProxySetupContext(scope);
  expect(token).toMatch(/^cps1_[A-Za-z0-9_.-]+$/);
  expect(decode(token)).not.toHaveProperty("userId");
  expect(verifyConnectionProxySetupContext({ ...scope, token })).toBe(true);
  expect(
    verifyConnectionProxySetupContext({
      ...scope,
      virtualApiKeyId: "other-key",
      token,
    }),
  ).toBe(false);
  expect(
    verifyConnectionProxySetupContext({
      ...scope,
      organizationId: "other-org",
      token,
    }),
  ).toBe(false);
  expect(
    verifyConnectionProxySetupContext({
      ...scope,
      proxyAgentId: "other-proxy",
      token,
    }),
  ).toBe(false);
  const mcp = issueConnectionSetupContext({
    userId: "user-1",
    organizationId: scope.organizationId,
    gatewayId: scope.proxyAgentId,
    setupId: scope.setupId,
    secret: scope.secret,
  });
  expect(verifyConnectionProxySetupContext({ ...scope, token: mcp })).toBe(
    false,
  );
  expect(
    verifyConnectionSetupContext({
      token,
      userId: "user-1",
      organizationId: scope.organizationId,
      gatewayId: scope.proxyAgentId,
      secret: scope.secret,
    }),
  ).toBe(false);
});

test("empty, missing, and null keys are rejected", () => {
  const token = issueConnectionProxySetupContext(scope);
  expect(() =>
    issueConnectionProxySetupContext({ ...scope, virtualApiKeyId: "" }),
  ).toThrow("Connection proxy setup scope is incomplete");
  expect(() =>
    issueConnectionProxySetupContext({
      ...scope,
      virtualApiKeyId: null as unknown as string,
    }),
  ).toThrow("Connection proxy setup scope is incomplete");
  expect(
    verifyConnectionProxySetupContext({
      ...scope,
      virtualApiKeyId: "",
      token,
    }),
  ).toBe(false);
  const now = Date.now();
  const withoutKey = signed({
    aud: "connection-proxy-setup",
    organizationId: scope.organizationId,
    proxyAgentId: scope.proxyAgentId,
    setupId: scope.setupId,
    issuedAt: now,
    expiresAt: now + CONNECTION_SETUP_WINDOW_MS,
  });
  expect(
    verifyConnectionProxySetupContext({ ...scope, token: withoutKey }),
  ).toBe(false);
  expect(
    verifyConnectionProxySetupContext({
      ...scope,
      token: signed({ ...issuedClaims(now), virtualApiKeyId: null }),
    }),
  ).toBe(false);
});

test("tamper, malformed claims, and a drifted window fail", () => {
  vi.useFakeTimers();
  const start = Date.parse("2026-09-29T12:00:00.000Z");
  vi.setSystemTime(start);
  const token = issueConnectionProxySetupContext(scope);
  const [payload, signature] = token.slice(PREFIX.length).split(".");
  expect(
    verifyConnectionProxySetupContext({
      ...scope,
      token: `${PREFIX}${payload}A.${signature}`,
    }),
  ).toBe(false);
  expect(
    verifyConnectionProxySetupContext({
      ...scope,
      token: `${PREFIX}${payload}.${nonCanonical(signature ?? "")}`,
    }),
  ).toBe(false);
  expect(
    verifyConnectionProxySetupContext({
      ...scope,
      token: signed({ ...issuedClaims(start), aud: "connection-mcp-setup" }),
    }),
  ).toBe(false);
  expect(
    verifyConnectionProxySetupContext({
      ...scope,
      token: signed({
        ...issuedClaims(start),
        expiresAt: start + CONNECTION_SETUP_WINDOW_MS + 1,
      }),
    }),
  ).toBe(false);
  vi.setSystemTime(start - 1);
  expect(verifyConnectionProxySetupContext({ ...scope, token })).toBe(false);
  vi.setSystemTime(start + CONNECTION_SETUP_WINDOW_MS - 1);
  expect(verifyConnectionProxySetupContext({ ...scope, token })).toBe(true);
  vi.setSystemTime(start + CONNECTION_SETUP_WINDOW_MS);
  expect(verifyConnectionProxySetupContext({ ...scope, token })).toBe(false);
});

test("a missing signing secret fails closed", () => {
  expect(() =>
    issueConnectionProxySetupContext({ ...scope, secret: "" }),
  ).toThrow("Connection proxy setup signing key is missing");
  const token = issueConnectionProxySetupContext(scope);
  expect(
    verifyConnectionProxySetupContext({ ...scope, secret: undefined, token }),
  ).toBe(false);
});

test("a setup URL rewrites to the provider path and preserves the query", () => {
  const token = issueConnectionProxySetupContext(scope);
  const query = "?stream=true&foo=a%20b";
  const request = asRequest(
    `/v1/connection-setup/${token}/anthropic/v1/messages${query}`,
  );
  request.originalUrl = request.url;
  expect(rewriteConnectionProxySetupUrl(request)).toBe(
    `/v1/anthropic/v1/messages${query}`,
  );
  expect(request.url).not.toContain(token);
  expect(request.originalUrl).not.toContain(token);
  expect(connectionProxySetupContext(request)).toBe(token);

  const ordinary = `/v1/openai/chat/completions?next=/v1/connection-setup/${token}/x`;
  const untouched = asRequest(ordinary);
  expect(rewriteConnectionProxySetupUrl(untouched)).toBe(ordinary);
  expect(connectionProxySetupContext(untouched)).toBeUndefined();
});

test("malformed and percent-encoded tokens are stripped and not stored", () => {
  const secretish = "not-a-capability-secret";
  const malformed = asRequest(
    `/v1/connection-setup/${secretish}/chat/completions`,
  );
  expect(rewriteConnectionProxySetupUrl(malformed)).toBe(
    "/v1/chat/completions",
  );
  expect(malformed.url).not.toContain(secretish);
  expect(connectionProxySetupContext(malformed)).toBeUndefined();

  const token = issueConnectionProxySetupContext(scope);
  const encoded = asRequest(
    `/v1/connection-setup/${token.replaceAll(".", "%2E")}/openai/v1/messages`,
  );
  expect(rewriteConnectionProxySetupUrl(encoded)).toBe(
    "/v1/openai/v1/messages",
  );
  expect(connectionProxySetupContext(encoded)).toBeUndefined();
  const encodedSlash = `/v1/connection-setup%2F${token}/chat/completions`;
  expect(rewriteConnectionProxySetupUrl(asRequest(encodedSlash))).toBe(
    encodedSlash,
  );
});

test("forged headers cannot install a capability", () => {
  const token = issueConnectionProxySetupContext(scope);
  const request = asRequest("/v1/chat/completions", {
    authorization: `Bearer ${token}`,
    "x-connection-proxy-setup": token,
  });
  expect(rewriteConnectionProxySetupUrl(request)).toBe("/v1/chat/completions");
  expect(connectionProxySetupContext(request)).toBeUndefined();
});

test("an expired capability still rewrites and does not authorize", () => {
  vi.useFakeTimers();
  const start = Date.parse("2026-09-29T12:00:00.000Z");
  vi.setSystemTime(start);
  const token = issueConnectionProxySetupContext(scope);
  vi.setSystemTime(start + CONNECTION_SETUP_WINDOW_MS);
  const request = asRequest(
    `/v1/connection-setup/${token}/chat/completions?x=1`,
  );
  expect(rewriteConnectionProxySetupUrl(request)).toBe(
    "/v1/chat/completions?x=1",
  );
  expect(connectionProxySetupContext(request)).toBe(token);
  expect(verifyConnectionProxySetupContext({ ...scope, token })).toBe(false);
  expect(rewriteConnectionProxySetupUrl({} as IncomingMessage)).toBe("");
});

function asRequest(
  url: string,
  headers: Record<string, string> = {},
): IncomingMessage & { originalUrl?: string; url?: string } {
  return { url, headers, originalUrl: url } as IncomingMessage & {
    originalUrl?: string;
  };
}

function issuedClaims(now: number) {
  return {
    aud: "connection-proxy-setup",
    organizationId: scope.organizationId,
    virtualApiKeyId: scope.virtualApiKeyId,
    proxyAgentId: scope.proxyAgentId,
    setupId: scope.setupId,
    issuedAt: now,
    expiresAt: now + CONNECTION_SETUP_WINDOW_MS,
  };
}

function signed(claims: unknown): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const mac = createHmac("sha256", scope.secret)
    .update(DOMAIN)
    .update(payload)
    .digest("base64url");
  return `${PREFIX}${payload}.${mac}`;
}

function decode(token: string): Record<string, unknown> {
  const payload = token.slice(PREFIX.length).split(".")[0] ?? "";
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

function nonCanonical(signature: string): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const index = alphabet.indexOf(signature.at(-1) ?? "");
  const original = Buffer.from(signature, "base64url");
  for (const bit of [1, 2, 3]) {
    const alt = alphabet[index ^ bit];
    if (!alt) continue;
    const candidate = `${signature.slice(0, -1)}${alt}`;
    const decoded = Buffer.from(candidate, "base64url");
    if (
      decoded.equals(original) &&
      decoded.toString("base64url") === signature
    ) {
      return candidate;
    }
  }
  throw new Error("expected a non-canonical base64url spelling");
}
