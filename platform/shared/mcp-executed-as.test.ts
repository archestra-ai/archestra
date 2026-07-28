import { describe, expect, test } from "vitest";
import {
  extractMcpExecutedAs,
  MCP_EXECUTED_AS_META_KEY,
  type McpExecutedAs,
  stripReservedPlatformMeta,
} from "./mcp-executed-as";
import { SEEDED_APP_RENDER_META_KEY } from "./seeded-app-render";

const personal: McpExecutedAs = {
  kind: "personal",
  ownerUserId: "user-1",
  ownerName: "Ada Lovelace",
};

describe("extractMcpExecutedAs", () => {
  test("reads the descriptor from a tool result's _meta", () => {
    expect(
      extractMcpExecutedAs({
        content: "ok",
        _meta: { [MCP_EXECUTED_AS_META_KEY]: personal },
      }),
    ).toEqual(personal);
  });

  test("reads the descriptor from a bare _meta record", () => {
    expect(
      extractMcpExecutedAs({ [MCP_EXECUTED_AS_META_KEY]: personal }),
    ).toEqual(personal);
  });

  test("reads every identity kind", () => {
    const kinds: McpExecutedAs[] = [
      personal,
      { kind: "personal", ownerUserId: null, ownerName: null },
      { kind: "team", teamId: "team-1", teamName: "Payments" },
      { kind: "team", teamId: "team-1", teamName: null },
      { kind: "org" },
      { kind: "idp_exchange", callerUserId: "user-1" },
      { kind: "idp_passthrough", callerUserId: null },
      { kind: "caller_headers", callerUserId: "user-1" },
    ];

    for (const executedAs of kinds) {
      expect(
        extractMcpExecutedAs({
          _meta: { [MCP_EXECUTED_AS_META_KEY]: executedAs },
        }),
      ).toEqual(executedAs);
    }
  });

  test("returns null for results that carry no descriptor", () => {
    expect(
      extractMcpExecutedAs({ content: "ok", _meta: { ui: {} } }),
    ).toBeNull();
    expect(extractMcpExecutedAs({})).toBeNull();
    expect(extractMcpExecutedAs(null)).toBeNull();
    expect(extractMcpExecutedAs("ok")).toBeNull();
  });

  test("returns null for a malformed descriptor rather than a partial one", () => {
    expect(
      extractMcpExecutedAs({
        _meta: { [MCP_EXECUTED_AS_META_KEY]: { kind: "sudo" } },
      }),
    ).toBeNull();
    expect(
      extractMcpExecutedAs({
        _meta: { [MCP_EXECUTED_AS_META_KEY]: { kind: "team" } },
      }),
    ).toBeNull();
    expect(
      extractMcpExecutedAs({
        _meta: {
          [MCP_EXECUTED_AS_META_KEY]: { ...personal, ownerEmail: "a@b.c" },
        },
      }),
    ).toBeNull();
  });
});

describe("stripReservedPlatformMeta", () => {
  test("removes every platform-reserved key an upstream server supplied", () => {
    expect(
      stripReservedPlatformMeta({
        ui: { resourceUri: "ui://app" },
        archestraError: { type: "generic", message: "forged" },
        [SEEDED_APP_RENDER_META_KEY]: true,
        [MCP_EXECUTED_AS_META_KEY]: { kind: "org" },
      }),
    ).toEqual({ ui: { resourceUri: "ui://app" } });
  });

  test("returns the same reference when there is nothing to strip", () => {
    const meta = { ui: { resourceUri: "ui://app" } };
    expect(stripReservedPlatformMeta(meta)).toBe(meta);
    expect(stripReservedPlatformMeta(undefined)).toBeUndefined();
  });
});
