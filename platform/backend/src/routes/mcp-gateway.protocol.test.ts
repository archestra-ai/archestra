/**
 * MCP protocol revision negotiation for the gateway.
 *
 * The contract these pin down is dual-revision coexistence: a 2025-11-25 client
 * that sends no version header and no routing headers must be treated exactly
 * as before, while a client that declares 2026-07-28 is held to that revision's
 * mandatory routing headers.
 */

import type { IncomingHttpHeaders } from "node:http";

import { describe, expect, test } from "@/test";
import {
  buildDiscoverResult,
  buildGatewayServerCapabilities,
  buildPrivateListCacheHint,
  deriveRequestTargetName,
  isDiscoverRequest,
  isResourceUnavailableError,
  LEGACY_MCP_PROTOCOL_REVISION,
  resolveProtocolRevision,
  STATELESS_MCP_PROTOCOL_REVISION,
  validateRoutingHeaders,
} from "./mcp-gateway.protocol";

const LEGACY_INITIALIZE = {
  jsonrpc: "2.0",
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "legacy-client", version: "1.0.0" },
  },
  id: 1,
};

function resolveOrThrow(params: {
  headers: IncomingHttpHeaders;
  body: unknown;
}) {
  const resolution = resolveProtocolRevision(params);
  if ("code" in resolution) {
    throw new Error(`expected a revision, got error: ${resolution.message}`);
  }
  return resolution;
}

describe("resolveProtocolRevision", () => {
  test("a legacy client sending no version header keeps the legacy revision", () => {
    const resolution = resolveOrThrow({
      headers: { "content-type": "application/json" },
      body: LEGACY_INITIALIZE,
    });

    expect(resolution.revision).toBe(LEGACY_MCP_PROTOCOL_REVISION);
    expect(resolution.declaredExplicitly).toBe(false);
  });

  test("an explicit version header selects that revision", () => {
    const resolution = resolveOrThrow({
      headers: { "mcp-protocol-version": STATELESS_MCP_PROTOCOL_REVISION },
      body: { jsonrpc: "2.0", method: "tools/list", id: 1 },
    });

    expect(resolution.revision).toBe(STATELESS_MCP_PROTOCOL_REVISION);
    expect(resolution.declaredExplicitly).toBe(true);
  });

  test("a client can explicitly pin the legacy revision", () => {
    const resolution = resolveOrThrow({
      headers: { "mcp-protocol-version": LEGACY_MCP_PROTOCOL_REVISION },
      body: LEGACY_INITIALIZE,
    });

    expect(resolution.revision).toBe(LEGACY_MCP_PROTOCOL_REVISION);
    expect(resolution.declaredExplicitly).toBe(true);
  });

  test("routing headers imply the stateless revision when none is declared", () => {
    const resolution = resolveOrThrow({
      headers: { "mcp-method": "tools/list" },
      body: { jsonrpc: "2.0", method: "tools/list", id: 1 },
    });

    expect(resolution.revision).toBe(STATELESS_MCP_PROTOCOL_REVISION);
    // Inferred, not declared — so the mandatory-header rule stays off.
    expect(resolution.declaredExplicitly).toBe(false);
  });

  test("a version declared in _meta counts as an explicit declaration", () => {
    // The revision moved per-request version carriage into _meta, so a
    // conforming client may send no version header at all.
    const resolution = resolveOrThrow({
      headers: {},
      body: {
        jsonrpc: "2.0",
        method: "tools/list",
        params: {
          _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
        },
        id: 1,
      },
    });

    expect(resolution.revision).toBe(STATELESS_MCP_PROTOCOL_REVISION);
    expect(resolution.declaredExplicitly).toBe(true);
  });

  test("per-request clientInfo _meta implies the stateless revision", () => {
    const resolution = resolveOrThrow({
      headers: {},
      body: {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "search",
          _meta: {
            "io.modelcontextprotocol/clientInfo": {
              name: "new-client",
              version: "2.0.0",
            },
          },
        },
        id: 1,
      },
    });

    expect(resolution.revision).toBe(STATELESS_MCP_PROTOCOL_REVISION);
  });

  test("an older SDK-supported revision resolves to the legacy behaviour", () => {
    const resolution = resolveOrThrow({
      headers: { "mcp-protocol-version": "2024-11-05" },
      body: LEGACY_INITIALIZE,
    });

    expect(resolution.revision).toBe(LEGACY_MCP_PROTOCOL_REVISION);
    // Preserved verbatim so the response cannot claim a newer version than the
    // client asked for.
    expect(resolution.declaredVersion).toBe("2024-11-05");
  });

  test("an unknown declared version is rejected and names what is supported", () => {
    const resolution = resolveProtocolRevision({
      headers: { "mcp-protocol-version": "2030-01-01" },
      body: LEGACY_INITIALIZE,
    });

    // The revision's allocated UnsupportedProtocolVersion code, not generic
    // Invalid Request.
    expect(resolution).toMatchObject({ code: -32022 });
    if (!("code" in resolution)) throw new Error("expected an error");
    expect(resolution.message).toContain("2030-01-01");
    expect(resolution.message).toContain(STATELESS_MCP_PROTOCOL_REVISION);
    expect(resolution.message).toContain(LEGACY_MCP_PROTOCOL_REVISION);
  });
});

describe("deriveRequestTargetName", () => {
  test("reads the tool name from tools/call", () => {
    expect(
      deriveRequestTargetName({
        method: "tools/call",
        params: { name: "search" },
      }),
    ).toBe("search");
  });

  test("reads the uri from resources/read", () => {
    expect(
      deriveRequestTargetName({
        method: "resources/read",
        params: { uri: "ui://app/main" },
      }),
    ).toBe("ui://app/main");
  });

  test("methods addressing no single target have no name", () => {
    expect(deriveRequestTargetName({ method: "tools/list" })).toBeUndefined();
  });
});

describe("validateRoutingHeaders", () => {
  const declaredStateless = {
    revision: STATELESS_MCP_PROTOCOL_REVISION,
    declaredExplicitly: true,
  } as const;
  const legacy = {
    revision: LEGACY_MCP_PROTOCOL_REVISION,
    declaredExplicitly: false,
  } as const;

  test("a legacy request with no routing headers is accepted unchanged", () => {
    expect(
      validateRoutingHeaders({
        headers: {},
        body: LEGACY_INITIALIZE,
        resolution: legacy,
      }),
    ).toBeNull();
  });

  test("a header naming a different method than the body is rejected", () => {
    const error = validateRoutingHeaders({
      headers: { "mcp-method": "tools/list" },
      body: { jsonrpc: "2.0", method: "tools/call", params: {}, id: 1 },
      resolution: declaredStateless,
    });

    expect(error).toMatchObject({ code: -32020 });
    expect(error?.message).toContain("does not match request method");
  });

  test("a header naming a different tool than the body is rejected", () => {
    const error = validateRoutingHeaders({
      headers: { "mcp-method": "tools/call", "mcp-name": "harmless_tool" },
      body: {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "dangerous_tool" },
        id: 1,
      },
      resolution: declaredStateless,
    });

    expect(error).toMatchObject({ code: -32020 });
    expect(error?.message).toContain("does not match request target");
  });

  test("mismatched headers are rejected even on an undeclared legacy request", () => {
    // The headers exist so intermediaries can dispatch without reading the
    // body, so a disagreeing pair is rejected regardless of revision.
    const error = validateRoutingHeaders({
      headers: { "mcp-method": "tools/list" },
      body: { jsonrpc: "2.0", method: "tools/call", params: {}, id: 1 },
      resolution: legacy,
    });

    expect(error).toMatchObject({ code: -32020 });
  });

  test("a name header on a method with no named target is rejected", () => {
    const error = validateRoutingHeaders({
      headers: { "mcp-method": "tools/list", "mcp-name": "search" },
      body: { jsonrpc: "2.0", method: "tools/list", id: 1 },
      resolution: declaredStateless,
    });

    expect(error).toMatchObject({ code: -32020 });
    expect(error?.message).toContain("addresses no named target");
  });

  test("a declared stateless request missing the method header is rejected", () => {
    const error = validateRoutingHeaders({
      headers: {},
      body: { jsonrpc: "2.0", method: "tools/list", id: 1 },
      resolution: declaredStateless,
    });

    expect(error).toMatchObject({ code: -32020 });
    expect(error?.message).toContain("Missing required mcp-method");
  });

  test("a declared stateless tools/call missing the name header is rejected", () => {
    const error = validateRoutingHeaders({
      headers: { "mcp-method": "tools/call" },
      body: {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "search" },
        id: 1,
      },
      resolution: declaredStateless,
    });

    expect(error).toMatchObject({ code: -32020 });
    expect(error?.message).toContain("Missing required mcp-name");
  });

  test("a declared stateless request with agreeing headers is accepted", () => {
    expect(
      validateRoutingHeaders({
        headers: { "mcp-method": "tools/call", "mcp-name": "search" },
        body: {
          jsonrpc: "2.0",
          method: "tools/call",
          params: { name: "search" },
          id: 1,
        },
        resolution: declaredStateless,
      }),
    ).toBeNull();
  });

  test("notifications are exempt from the mandatory headers", () => {
    expect(
      validateRoutingHeaders({
        headers: {},
        body: { jsonrpc: "2.0", method: "notifications/cancelled" },
        resolution: declaredStateless,
      }),
    ).toBeNull();
  });

  test("an inferred stateless request is not held to the mandatory headers", () => {
    expect(
      validateRoutingHeaders({
        headers: {},
        body: {
          jsonrpc: "2.0",
          method: "tools/list",
          params: {
            _meta: { "io.modelcontextprotocol/clientInfo": { name: "c" } },
          },
          id: 1,
        },
        resolution: {
          revision: STATELESS_MCP_PROTOCOL_REVISION,
          declaredExplicitly: false,
        },
      }),
    ).toBeNull();
  });
});

describe("server/discover", () => {
  test("recognises the discover method", () => {
    expect(isDiscoverRequest({ method: "server/discover" })).toBe(true);
    expect(isDiscoverRequest({ method: "initialize" })).toBe(false);
  });

  test("advertises the same capabilities the handshake does", () => {
    const result = buildDiscoverResult({
      agentId: "agent-1",
      version: "1.2.3",
      revision: STATELESS_MCP_PROTOCOL_REVISION,
    });

    expect(result.protocolVersion).toBe(STATELESS_MCP_PROTOCOL_REVISION);
    expect(result.serverInfo).toEqual({
      name: "archestra-agent-agent-1",
      version: "1.2.3",
    });
    expect(result.capabilities).toEqual(buildGatewayServerCapabilities());
  });

  test("advertises every supported version, not only the negotiated one", () => {
    const result = buildDiscoverResult({
      agentId: "agent-1",
      version: "1.2.3",
      revision: STATELESS_MCP_PROTOCOL_REVISION,
    });

    expect(result.protocolVersions).toEqual([
      STATELESS_MCP_PROTOCOL_REVISION,
      LEGACY_MCP_PROTOCOL_REVISION,
    ]);
    expect(result.resultType).toBe("complete");
  });

  test("capabilities carry the MCP Apps extension", () => {
    const capabilities = buildGatewayServerCapabilities();
    expect(capabilities.extensions).toHaveProperty(
      "io.modelcontextprotocol/ui",
    );
  });
});

describe("list cache hints", () => {
  test("a per-caller list is never advertised as shareable", () => {
    const hint = buildPrivateListCacheHint();

    expect(hint.cacheScope).toBe("private");
    expect(hint.ttlMs).toBeGreaterThan(0);
  });
});

describe("isResourceUnavailableError", () => {
  test("treats method-not-found as an upstream gap", () => {
    expect(isResourceUnavailableError({ code: -32601 })).toBe(true);
  });

  test("still treats the legacy resource-not-found code as an upstream gap", () => {
    expect(isResourceUnavailableError({ code: -32002 })).toBe(true);
  });

  test("treats the migrated code as an upstream gap when the message says not found", () => {
    expect(
      isResourceUnavailableError({
        code: -32602,
        message: "Resource not found: ui://app/main",
      }),
    ).toBe(true);
  });

  test("does not swallow a genuine invalid-params error", () => {
    // -32602 is also plain Invalid Params. Classifying it as an upstream gap on
    // the code alone would hide real argument bugs behind a debug-level log.
    expect(
      isResourceUnavailableError({
        code: -32602,
        message: "uri must be a string",
      }),
    ).toBe(false);
    expect(isResourceUnavailableError({ code: -32602 })).toBe(false);
  });

  test("an unrelated error is not an upstream gap", () => {
    expect(isResourceUnavailableError({ code: -32603, message: "boom" })).toBe(
      false,
    );
  });
});
