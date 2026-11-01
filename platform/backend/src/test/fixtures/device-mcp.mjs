// Deterministic stdio MCP fixture: no filesystem tools or external effects.
import { createInterface } from "node:readline";

const tool = {
  name: "echo",
  description: "Return the supplied text",
  inputSchema: { type: "object", properties: { text: { type: "string" }, delayMs: { type: "integer", minimum: 0, maximum: 5000 } }, required: ["text"], additionalProperties: false },
};
const toolCount = Number(process.argv.find((value) => value.startsWith("--tool-count="))?.split("=")[1] ?? 1);
const repeatedCursor = process.argv.includes("--pagination-cycle");
const tooManyPages = process.argv.includes("--pagination-unbounded");
const tools = Array.from({ length: toolCount }, (_, index) => ({ ...tool, name: toolCount === 1 ? "echo" : `echo-${index}` }));

const input = createInterface({ input: process.stdin });
let executionCount = 0;
input.on("line", async (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  switch (request.method) {
    case "initialize":
      result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "device-fixture", version: "1.0.0" } };
      break;
    case "tools/list":
      result = repeatedCursor || tooManyPages
        ? { tools: [], nextCursor: repeatedCursor ? "same-cursor" : String(Number(request.params?.cursor ?? 0) + 1) }
        : { tools };
      break;
    case "tools/call":
      executionCount++;
      if (request.params.arguments.text === "__stop_fixture__") process.exit(0);
      if (request.params.arguments.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, request.params.arguments.delayMs));
      }
      result = request.params.name === "echo"
        ? { content: [{ type: "text", text: request.params.arguments.text }], structuredContent: { executionCount } }
        : { isError: true, content: [{ type: "text", text: "Unknown fixture tool" }] };
      break;
    case "ping":
      result = {};
      break;
    default:
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } })}\n`);
      return;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
});
