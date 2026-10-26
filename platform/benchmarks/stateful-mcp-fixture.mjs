import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

export function fixtureTools({ namespace, count = 128 }) {
  assert.ok(/^[a-z0-9-]{1,64}$/i.test(namespace));
  assert.ok(Number.isInteger(count) && count >= 128 && count <= 256);
  return Array.from({ length: count }, (_, index) => ({
    name: `fixture_${String(index).padStart(3, "0")}`,
    description: `Benchmark namespace: ${namespace}. Operate on deterministic synthetic records; no filesystem, external network or real data. Fixture ${index}.`,
    inputSchema: {
      type: "object",
      properties: {
        step: { type: "integer", minimum: 0, maximum: 10000 },
        operation: { type: "string", enum: ["read", "publish"] },
        text: { type: "string", maxLength: 4096 },
      },
      required: ["step", "operation"],
      additionalProperties: false,
    },
  }));
}

export function createStatefulFixture({ namespace, count = 128 }) {
  const tools = fixtureTools({ namespace, count });
  const names = new Set(tools.map((tool) => tool.name));
  const calls = [];
  let mode = "approve";
  const dispatch = (method, params) => {
    if (method === "initialize")
      return {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "stateful-benchmark-fixture", version: "1" },
      };
    if (method === "ping") return {};
    if (method === "tools/list") return { tools };
    assert.equal(method, "tools/call", "unsupported_method");
    assert.ok(names.has(params?.name), "unknown_fixture_tool");
    const args = params.arguments;
    assert.ok(
      args &&
        Number.isInteger(args.step) &&
        args.step >= 0 &&
        args.step <= 10000,
    );
    assert.ok(["read", "publish"].includes(args.operation));
    assert.ok(
      args.text === undefined ||
        (typeof args.text === "string" && args.text.length <= 4096),
    );
    const source = `synthetic-record-${params.name}-${args.step}`;
    const digest = createHash("sha256")
      .update(args.text ?? source)
      .digest("hex");
    const text =
      args.operation === "read"
        ? `STEP ${args.step}: SYNTHETIC-RECORD-${params.name}. ${"Neutral deterministic benchmark content. ".repeat(16)} Digest ${digest}.`
        : `PUBLISHED STEP ${args.step}: synthetic digest ${digest}.`;
    calls.push({
      kind: "tool_execution",
      index: calls.length,
      name: params.name,
      step: args.step,
      operation: args.operation,
      resultDigest: createHash("sha256").update(text).digest("hex"),
      ok: true,
    });
    return { content: [{ type: "text", text }], isError: false };
  };
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    const url = new URL(req.url, "http://127.0.0.1");
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        res.end(
          JSON.stringify({
            ok: true,
            tools: tools.length,
            executions: calls.length,
          }),
        );
        return;
      }
      if (req.method === "GET" && url.pathname === "/calls") {
        res.end(JSON.stringify({ calls }));
        return;
      }
      const pieces = [];
      let bytes = 0;
      for await (const part of req) {
        bytes += part.length;
        assert.ok(bytes <= 1024 * 1024);
        pieces.push(part);
      }
      const value = JSON.parse(Buffer.concat(pieces).toString("utf8") || "{}");
      if (req.method === "POST" && url.pathname === "/authority/mode") {
        assert.ok(["approve", "deny"].includes(value.mode));
        mode = value.mode;
        res.end(JSON.stringify({ mode }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/authority") {
        calls.push({
          kind: "authority_consult",
          index: calls.length,
          ruling: mode,
        });
        res.end(JSON.stringify({ version: 1, answer: { ruling: mode } }));
        return;
      }
      assert.ok(
        req.method === "POST" && url.pathname === "/mcp",
        "unsupported_path",
      );
      if (value.method === "notifications/initialized") {
        res.statusCode = 202;
        res.end();
        return;
      }
      assert.ok(
        value.jsonrpc === "2.0" &&
          (typeof value.id === "number" || typeof value.id === "string"),
      );
      const result = dispatch(value.method, value.params);
      res.end(JSON.stringify({ jsonrpc: "2.0", id: value.id, result }));
    } catch {
      res.statusCode = 400;
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32602,
            message: "Invalid bounded synthetic fixture request.",
          },
        }),
      );
    }
  });
  return { server, tools, calls, dispatch };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const namespace =
    process.env.ARCHESTRA_BENCHMARK_FIXTURE_NAMESPACE ?? "stateful-cache-1605";
  const port = Number(process.env.ARCHESTRA_BENCHMARK_FIXTURE_PORT ?? 19101);
  assert.ok(Number.isInteger(port) && port > 1024 && port < 65536);
  const { server } = createStatefulFixture({ namespace });
  server.listen(port, "127.0.0.1", () =>
    console.info(
      JSON.stringify({ ready: true, port, tools: 128, syntheticOnly: true }),
    ),
  );
}
