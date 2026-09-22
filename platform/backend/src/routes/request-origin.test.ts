import type { FastifyRequest } from "fastify";
import { describe, expect, test, vi } from "vitest";

// trustProxy is deliberately ON for every case here: the allowlist must hold
// regardless of it. This module reads the raw X-Forwarded-Host header rather
// than request.hostname, so Fastify's trusted-proxy gating never filters the
// value — honoring trustProxy would accept a forwarded host from any client.
// Stands in for the hosts an operator names in ARCHESTRA_API_BASE_URL and
// ARCHESTRA_FRONTEND_URL, with the scheme each one was configured under.
const { CONFIGURED_HOST_SCHEMES } = vi.hoisted(() => ({
  CONFIGURED_HOST_SCHEMES: new Map([
    ["allowed.example.com", "https"],
    ["plain.example.com", "http"],
  ]),
}));

vi.mock("@/config", async () => {
  const actual = await vi.importActual<typeof import("@/config")>("@/config");
  return {
    ...actual,
    default: {
      ...actual.default,
      api: { ...actual.default.api, trustProxy: true },
    },
    getMCPGatewayOauthAllowedPublicHosts: () =>
      new Set(CONFIGURED_HOST_SCHEMES.keys()),
    getMCPGatewayOauthPublicHostSchemes: () => CONFIGURED_HOST_SCHEMES,
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

  // The regression these cases exist for: a layer-4 route (Gateway API
  // TLSRoute, for example) cannot set X-Forwarded-Proto, so the backend sees
  // plain http and advertised an http OAuth metadata URL for a host the
  // operator had published over https. Clients then fail the handshake.
  test("advertises https for a configured https host when no proto is forwarded", () => {
    expect(
      getPublicRequestOrigin(makeRequest({ host: "allowed.example.com" })),
    ).toBe("https://allowed.example.com");
  });

  test("advertises https for a configured https host forwarded without a proto", () => {
    const origin = getPublicRequestOrigin(
      makeRequest({
        host: "internal:9000",
        forwardedHost: "allowed.example.com",
      }),
    );
    expect(origin).toBe("https://allowed.example.com");
  });

  test("keeps http for a host the operator configured over http", () => {
    expect(
      getPublicRequestOrigin(makeRequest({ host: "plain.example.com" })),
    ).toBe("http://plain.example.com");
  });

  test("keeps http for a host that is in no configured public URL", () => {
    expect(
      getPublicRequestOrigin(makeRequest({ host: "unknown.example.com" })),
    ).toBe("http://unknown.example.com");
  });

  test("does not upgrade a rejected forwarded host to https", () => {
    const origin = getPublicRequestOrigin(
      makeRequest({
        host: "internal:9000",
        forwardedHost: "attacker.example.com",
        forwardedProto: "https",
      }),
    );
    expect(origin).toBe("http://internal:9000");
  });
});
