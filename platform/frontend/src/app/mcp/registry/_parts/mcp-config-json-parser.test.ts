import { describe, expect, it } from "vitest";
import { parseMcpServerConfigJson } from "./mcp-config-json-parser";

describe("parseMcpServerConfigJson", () => {
  it("parses a bare single-server stdio config", () => {
    const result = parseMcpServerConfigJson(
      JSON.stringify({
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
      }),
    );
    expect(result).toEqual({
      command: "npx",
      arguments: ["-y", "@modelcontextprotocol/server-everything"],
      serverType: "local",
      transportType: "stdio",
    });
  });

  it("unwraps the mcpServers wrapper and takes the first server", () => {
    const result = parseMcpServerConfigJson(
      JSON.stringify({
        mcpServers: {
          everything: {
            command: "npx",
            args: ["-y", "pkg"],
            env: { API_KEY: "abc123" },
          },
        },
      }),
    );
    expect(result?.command).toBe("npx");
    expect(result?.arguments).toEqual(["-y", "pkg"]);
    expect(result?.environment).toEqual([
      { key: "API_KEY", value: "abc123", isPlaceholder: false },
    ]);
    expect(result?.serverType).toBe("local");
  });

  it("also unwraps the alternate `servers` wrapper key", () => {
    const result = parseMcpServerConfigJson(
      JSON.stringify({ servers: { foo: { command: "node", args: ["x.js"] } } }),
    );
    expect(result?.command).toBe("node");
    expect(result?.arguments).toEqual(["x.js"]);
  });

  it("flags placeholder env values so they can be prompted as secrets", () => {
    const result = parseMcpServerConfigJson(
      JSON.stringify({
        command: "npx",
        args: ["-y", "pkg"],
        env: {
          TOKEN: "<token>",
          OTHER: "YOUR_API_KEY_HERE",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional ${...} placeholder fixture
          INTERP: "${SOME_ENV}",
          REAL: "literal-value",
          EMPTY: "",
        },
      }),
    );
    const env = Object.fromEntries(
      (result?.environment ?? []).map((e) => [e.key, e.isPlaceholder]),
    );
    expect(env).toEqual({
      TOKEN: true,
      OTHER: true,
      INTERP: true,
      REAL: false,
      EMPTY: true,
    });
  });

  it("parses a remote http server config", () => {
    const result = parseMcpServerConfigJson(
      JSON.stringify({ url: "https://example.com/mcp", type: "http" }),
    );
    expect(result).toEqual({
      serverUrl: "https://example.com/mcp",
      serverType: "remote",
    });
  });

  it("maps a streamable-http local server to the streamable-http transport", () => {
    const result = parseMcpServerConfigJson(
      JSON.stringify({ command: "my-server", type: "streamable-http" }),
    );
    expect(result?.serverType).toBe("local");
    expect(result?.transportType).toBe("streamable-http");
  });

  it("returns null for non-JSON input (falls back to line-by-line paste)", () => {
    expect(parseMcpServerConfigJson("--verbose\n--port 3000")).toBeNull();
    expect(parseMcpServerConfigJson("/path/to/server.js")).toBeNull();
  });

  it("returns null for a bare JSON arguments array (not a config)", () => {
    expect(parseMcpServerConfigJson('["-y", "pkg"]')).toBeNull();
  });

  it("returns null for a JSON object that is not an MCP config", () => {
    expect(parseMcpServerConfigJson(JSON.stringify({ foo: "bar" }))).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseMcpServerConfigJson('{ "command": "npx", }')).toBeNull();
    expect(parseMcpServerConfigJson("{ broken")).toBeNull();
  });

  it("coerces non-string arg/env values to strings", () => {
    const result = parseMcpServerConfigJson(
      JSON.stringify({ command: "x", args: ["--port", 3000], env: { N: 5 } }),
    );
    expect(result?.arguments).toEqual(["--port", "3000"]);
    expect(result?.environment).toEqual([
      { key: "N", value: "5", isPlaceholder: false },
    ]);
  });

  // --- security hardening ---

  it("drops prototype-polluting env keys", () => {
    // Raw JSON string so the literal "__proto__" key survives as an own
    // property (an object literal would treat it as the prototype setter).
    const result = parseMcpServerConfigJson(
      '{"command":"npx","env":{"__proto__":"x","constructor":"y","prototype":"z","OK":"1"}}',
    );
    expect(result?.environment).toEqual([
      { key: "OK", value: "1", isPlaceholder: false },
    ]);
    // And no actual prototype pollution occurred.
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it("drops non-scalar env values instead of stringifying to junk", () => {
    const result = parseMcpServerConfigJson(
      JSON.stringify({
        command: "npx",
        env: { OBJ: { a: 1 }, ARR: [1, 2], OK: "v" },
      }),
    );
    expect(result?.environment).toEqual([
      { key: "OK", value: "v", isPlaceholder: false },
    ]);
  });

  it("rejects non-http(s) server URLs (javascript:, data:)", () => {
    expect(
      parseMcpServerConfigJson(JSON.stringify({ url: "javascript:alert(1)" })),
    ).toBeNull();
    expect(
      parseMcpServerConfigJson(JSON.stringify({ url: "data:text/html,x" })),
    ).toBeNull();
    expect(
      parseMcpServerConfigJson(JSON.stringify({ url: "https://ok.com/mcp" }))
        ?.serverUrl,
    ).toBe("https://ok.com/mcp");
  });

  it("rejects absurdly large input", () => {
    const huge = `{"command":"npx","args":["${"a".repeat(70_000)}"]}`;
    expect(parseMcpServerConfigJson(huge)).toBeNull();
  });

  it("caps the number of arguments", () => {
    const args = Array.from({ length: 500 }, (_, i) => `a${i}`);
    const result = parseMcpServerConfigJson(
      JSON.stringify({ command: "npx", args }),
    );
    expect(result?.arguments?.length).toBe(100);
  });
});
