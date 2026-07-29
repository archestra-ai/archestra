/**
 * x-mcp-header validation, extraction, and encoding (SEP-2243).
 *
 * Validation is most of the surface because the spec makes every violation
 * invalidate the whole tool definition — each constraint here is one row of
 * that contract. Encoding matters because a header is an injection vector:
 * the base64 wrapper is what keeps CR/LF and non-ASCII out of the wire.
 */

import { describe, expect, test } from "@/test";
import {
  buildMcpParamHeaders,
  collectMcpHeaderAnnotations,
  mcpParamHeadersForCall,
} from "./mcp-param-headers";

const VALID_SCHEMA = {
  type: "object",
  properties: {
    region: { type: "string", "x-mcp-header": "Region" },
    depth: {
      type: "object",
      properties: {
        tenant: { type: "string", "x-mcp-header": "Tenant" },
      },
    },
    count: { type: "integer", "x-mcp-header": "Count" },
    dryRun: { type: "boolean", "x-mcp-header": "Dry-Run" },
    query: { type: "string" },
  },
};

describe("collectMcpHeaderAnnotations", () => {
  test("collects annotations along properties chains, including nested ones", () => {
    const scan = collectMcpHeaderAnnotations(VALID_SCHEMA);
    if (!scan.ok) throw new Error(scan.reason);

    expect(scan.annotations).toEqual(
      expect.arrayContaining([
        { path: ["region"], name: "Region", type: "string" },
        { path: ["depth", "tenant"], name: "Tenant", type: "string" },
        { path: ["count"], name: "Count", type: "integer" },
        { path: ["dryRun"], name: "Dry-Run", type: "boolean" },
      ]),
    );
  });

  test("a schema with no annotations is valid and empty", () => {
    expect(
      collectMcpHeaderAnnotations({
        type: "object",
        properties: { q: { type: "string" } },
      }),
    ).toEqual({ ok: true, annotations: [] });
  });

  test.each([
    ["empty value", { type: "string", "x-mcp-header": "" }],
    ["non-string value", { type: "string", "x-mcp-header": 7 }],
    ["whitespace in name", { type: "string", "x-mcp-header": "Bad Name" }],
    ["CR/LF smuggling", { type: "string", "x-mcp-header": "X\r\nEvil" }],
    ["type number", { type: "number", "x-mcp-header": "N" }],
    ["no type", { "x-mcp-header": "N" }],
    ["type object", { type: "object", "x-mcp-header": "N", properties: {} }],
  ])("rejects the whole definition for %s", (_label, property) => {
    const scan = collectMcpHeaderAnnotations({
      type: "object",
      properties: { p: property },
    });
    expect(scan.ok).toBe(false);
  });

  test.each([
    [
      "items",
      { type: "array", items: { type: "string", "x-mcp-header": "A" } },
    ],
    ["oneOf", { oneOf: [{ type: "string", "x-mcp-header": "A" }] }],
    ["allOf", { allOf: [{ type: "string", "x-mcp-header": "A" }] }],
    ["not", { not: { type: "string", "x-mcp-header": "A" } }],
    ["if", { if: { type: "string", "x-mcp-header": "A" } }],
  ])("an annotation reached through %s is not statically reachable, so invalid", (_label, property) => {
    const scan = collectMcpHeaderAnnotations({
      type: "object",
      properties: { p: property },
    });
    expect(scan.ok).toBe(false);
    if (scan.ok) return;
    expect(scan.reason).toContain("statically reachable");
  });

  test("properties nested under a composition branch are also unreachable", () => {
    // The chain must consist solely of `properties` keys from the root; one
    // composition step anywhere poisons everything below it.
    const scan = collectMcpHeaderAnnotations({
      type: "object",
      properties: {
        p: {
          anyOf: [
            {
              type: "object",
              properties: { q: { type: "string", "x-mcp-header": "Q" } },
            },
          ],
        },
      },
    });
    expect(scan.ok).toBe(false);
  });

  test("case-insensitively colliding names invalidate the definition", () => {
    const scan = collectMcpHeaderAnnotations({
      type: "object",
      properties: {
        a: { type: "string", "x-mcp-header": "Region" },
        b: { type: "string", "x-mcp-header": "region" },
      },
    });
    expect(scan.ok).toBe(false);
    if (scan.ok) return;
    expect(scan.reason).toContain("collide");
  });

  test("a property literally named x-mcp-header is not an annotation", () => {
    // `properties` keys are parameter names; only the extension keyword on a
    // schema object is an annotation.
    const scan = collectMcpHeaderAnnotations({
      type: "object",
      properties: { "x-mcp-header": { type: "string" } },
    });
    expect(scan).toEqual({ ok: true, annotations: [] });
  });
});

describe("buildMcpParamHeaders", () => {
  const annotations = (() => {
    const scan = collectMcpHeaderAnnotations(VALID_SCHEMA);
    if (!scan.ok) throw new Error(scan.reason);
    return scan.annotations;
  })();

  test("mirrors values at the exact property paths", () => {
    expect(
      buildMcpParamHeaders({
        annotations,
        args: {
          region: "us-west1",
          depth: { tenant: "acme" },
          count: -7,
          dryRun: false,
          query: "SELECT 1",
        },
      }),
    ).toEqual({
      "Mcp-Param-Region": "us-west1",
      "Mcp-Param-Tenant": "acme",
      "Mcp-Param-Count": "-7",
      "Mcp-Param-Dry-Run": "false",
    });
  });

  test("an absent value omits the header", () => {
    expect(
      buildMcpParamHeaders({ annotations, args: { query: "SELECT 1" } }),
    ).toEqual({});
  });

  test("a value of the wrong type is omitted, not coerced", () => {
    // A coerced header could disagree with the body it summarizes — the exact
    // mismatch routing headers exist to prevent.
    expect(
      buildMcpParamHeaders({
        annotations,
        args: { region: 42, count: "many", dryRun: "yes" },
      }),
    ).toEqual({});
  });

  test("unsafe integers are omitted", () => {
    expect(
      buildMcpParamHeaders({
        annotations,
        args: { count: Number.MAX_SAFE_INTEGER + 2 },
      }),
    ).toEqual({});
    expect(buildMcpParamHeaders({ annotations, args: { count: 3.5 } })).toEqual(
      {},
    );
  });

  test.each([
    ["non-ASCII", "münchen"],
    ["newline", "a\nb"],
    ["carriage return", "a\rb"],
    ["leading whitespace", " padded"],
    ["trailing whitespace", "padded "],
  ])("%s values ride in the base64 wrapper", (_label, value) => {
    const headers = buildMcpParamHeaders({
      annotations,
      args: { region: value },
    });
    const encoded = headers["Mcp-Param-Region"];
    expect(encoded).toMatch(/^=\?base64\?[A-Za-z0-9+/=]+\?=$/);
    const inner = encoded.slice("=?base64?".length, -"?=".length);
    expect(Buffer.from(inner, "base64").toString("utf8")).toBe(value);
  });

  test("interior spaces are plain-ASCII safe and stay unencoded", () => {
    expect(
      buildMcpParamHeaders({ annotations, args: { region: "us west 1" } }),
    ).toEqual({ "Mcp-Param-Region": "us west 1" });
  });
});

describe("mcpParamHeadersForCall", () => {
  test("an invalid schema mirrors nothing", () => {
    // Acting on annotations from a definition the spec says to reject would
    // be worse than losing the optimization.
    expect(
      mcpParamHeadersForCall({
        inputSchema: {
          type: "object",
          properties: { p: { type: "number", "x-mcp-header": "N" } },
        },
        args: { p: 1 },
      }),
    ).toBeUndefined();
  });

  test("a schema without annotations mirrors nothing", () => {
    expect(
      mcpParamHeadersForCall({
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
        args: { q: "x" },
      }),
    ).toBeUndefined();
  });
});
