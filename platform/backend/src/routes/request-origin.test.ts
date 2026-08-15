import type { FastifyRequest } from "fastify";
import { describe, expect, test, vi } from "vitest";

// trustProxy is deliberately ON for every case here: the allowlist must hold
// regardless of it. This module reads the raw X-Forwarded-Host header rather
// than request.hostname, so Fastify's trusted-proxy gating never filters the
// value — honoring trustProxy would accept a forwarded host from any client.
vi.mock("@/config", async () => {
  const actual = await vi.importActual<typeof import("@/config")>("@/config");
  return {
    ...actual,
    default: {
      ...actual.default,
      api: { ...actual.default.api, trustProxy: true },
    },
    getMCPGatewayOauthAllowedPublicHosts: () =>
      new Set(["allowed.example.com"]),
  };
});

import { getPublicRequestOrigin } from "./request-origin";

function makeRequest(params: {
  host?: string;
  forwardedHost?: string;
  forwardedProto?: string;
  encrypted?: boolean;
}): FastifyRequest {
  const headers: Record<string, string> = {};
  if (params.host) headers.host = params.host;
  if (params.forwardedHost) headers["x-forwarded-host"] = params.forwardedHost;
  if (params.forwardedProto)
    headers["x-forwarded-proto"] = params.forwardedProto;
  return {
    headers,
    socket: { encrypted: params.encrypted ?? false },
  } as unknown as FastifyRequest;
}

describe("getPublicRequestOrigin", () => {
  test("uses the direct origin when nothing is forwarded", () => {
    expect(getPublicRequestOrigin(makeRequest({ host: "internal:9000" }))).toBe(
      "http://internal:9000",
    );
  });

  test("honors a forwarded host that is in the allowlist", () => {
    const origin = getPublicRequestOrigin(
      makeRequest({
        host: "internal:9000",
        forwardedHost: "allowed.example.com",
        forwardedProto: "https",
      }),
    );
    expect(origin).toBe("https://allowed.example.com");
  });

  // The regression this file exists for: before, any truthy trustProxy returned
  // the forwarded host unchecked, letting a caller choose the OAuth issuer
  // origin the platform advertises.
  test("rejects a forwarded host outside the allowlist even when trustProxy is on", () => {
    const origin = getPublicRequestOrigin(
      makeRequest({
        host: "internal:9000",
        forwardedHost: "attacker.example.com",
        forwardedProto: "https",
      }),
    );
    expect(origin).toBe("http://internal:9000");
  });

  test("ignores a malformed forwarded host", () => {
    const origin = getPublicRequestOrigin(
      makeRequest({
        host: "internal:9000",
        forwardedHost: "not a host",
        forwardedProto: "https",
      }),
    );
    expect(origin).toBe("http://internal:9000");
  });

  test("takes the first hop of a comma-joined forwarded host", () => {
    const origin = getPublicRequestOrigin(
      makeRequest({
        host: "internal:9000",
        forwardedHost: "allowed.example.com, attacker.example.com",
        forwardedProto: "https",
      }),
    );
    expect(origin).toBe("https://allowed.example.com");
  });

  test("derives https from an encrypted socket with no forwarded headers", () => {
    expect(
      getPublicRequestOrigin(
        makeRequest({ host: "internal:9000", encrypted: true }),
      ),
    ).toBe("https://internal:9000");
  });
});
