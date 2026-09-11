#!/usr/bin/env node
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";

const token = process.env.APPA_FIXTURE_TOKEN;
const adminToken = process.env.APPA_FIXTURE_ADMIN_TOKEN;
if (!token || !adminToken || token === adminToken) {
  throw new Error("Separate fixture and operator credentials are required");
}
const db = new DatabaseSync(process.env.APPA_FIXTURE_DB || "/data/fixture.sqlite");
db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    request_key TEXT PRIMARY KEY, id TEXT NOT NULL, value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS publications (
    request_key TEXT PRIMARY KEY, id TEXT NOT NULL, value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS invocations (
    id INTEGER PRIMARY KEY, request_key TEXT NOT NULL, tool TEXT NOT NULL,
    client_call_id TEXT, outcome TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS faults (
    request_key TEXT PRIMARY KEY, mode TEXT NOT NULL
  );
`);

const keyProperty = { type: "string", pattern: "^synthetic-[a-zA-Z0-9_-]{1,100}$" };
const readSchema = { type: "object", properties: { request_key: keyProperty }, required: ["request_key"], additionalProperties: false };
const writeSchema = {
  type: "object",
  properties: { request_key: keyProperty, value: { type: "string", pattern: "^SYNTHETIC_", maxLength: 2000 } },
  required: ["request_key", "value"], additionalProperties: false,
};
const tools = [
  { name: "read_public_status", description: "Read a synthetic public service status.", inputSchema: readSchema, annotations: { readOnlyHint: true } },
  { name: "read_private_note", description: "Read a synthetic private note and its public summary.", inputSchema: readSchema, annotations: { readOnlyHint: true } },
  { name: "create_job", description: "Create a durable synthetic job. No external service is affected.", inputSchema: writeSchema, annotations: { readOnlyHint: false } },
  { name: "get_job", description: "Inspect a durable synthetic job by its request key.", inputSchema: readSchema, annotations: { readOnlyHint: true } },
  { name: "publish_record", description: "Append a durable synthetic publication. No external publication occurs.", inputSchema: writeSchema, annotations: { readOnlyHint: false } },
];

function authorized(request, expected) {
  const received = Buffer.from(request.headers.authorization || "");
  const wanted = Buffer.from(`Bearer ${expected}`);
  return received.length === wanted.length && timingSafeEqual(received, wanted);
}

function send(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65_536) throw new Error("request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function validKey(value) {
  return typeof value === "string" && /^synthetic-[a-zA-Z0-9_-]{1,100}$/.test(value);
}

function callTool(params) {
  const tool = tools.find((entry) => entry.name === params?.name);
  const args = params?.arguments;
  if (!tool || !args || !validKey(args.request_key)) throw new Error("invalid synthetic tool request");
  const write = tool.name === "create_job" || tool.name === "publish_record";
  const allowed = write ? ["request_key", "value"] : ["request_key"];
  if (Object.keys(args).some((key) => !allowed.includes(key))) throw new Error("unexpected argument");
  if (write && (typeof args.value !== "string" || !args.value.startsWith("SYNTHETIC_") || args.value.length > 2000)) {
    throw new Error("only bounded synthetic values are accepted");
  }
  const callId = typeof params._meta?.callId === "string" ? params._meta.callId : null;
  const invocation = db.prepare("INSERT INTO invocations(request_key, tool, client_call_id, outcome) VALUES (?, ?, ?, 'started')").run(args.request_key, tool.name, callId);
  let value;
  if (tool.name === "read_public_status") value = { request_key: args.request_key, status: "SYNTHETIC_OK" };
  if (tool.name === "read_private_note") value = {
    request_key: args.request_key,
    private_note: "SYNTHETIC_PRIVATE_NOTE synthetic.person@example.test",
    public_summary: "SYNTHETIC_SERVICE_OK",
  };
  if (tool.name === "get_job") value = db.prepare("SELECT id, request_key, value FROM jobs WHERE request_key = ?").get(args.request_key) ?? null;
  if (write) {
    const table = tool.name === "create_job" ? "jobs" : "publications";
    // Idempotency does not hide repeated attempts: every invocation is recorded above.
    db.prepare(`INSERT INTO ${table}(request_key, id, value) VALUES (?, ?, ?) ON CONFLICT(request_key) DO NOTHING`).run(args.request_key, randomUUID(), args.value);
    value = db.prepare(`SELECT id, request_key, value FROM ${table} WHERE request_key = ?`).get(args.request_key);
  }
  const fault = db.prepare("SELECT mode FROM faults WHERE request_key = ?").get(args.request_key);
  if (write && fault?.mode === "drop_after_commit") {
    db.prepare("UPDATE invocations SET outcome = 'committed_reply_dropped' WHERE id = ?").run(invocation.lastInsertRowid);
    return { drop: true };
  }
  db.prepare("UPDATE invocations SET outcome = 'completed' WHERE id = ?").run(invocation.lastInsertRowid);
  return { result: { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: { value } } };
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://fixture.invalid");
  if (url.pathname === "/health" && request.method === "GET") return send(response, 200, { status: "ok" });
  const admin = url.pathname.startsWith("/admin/");
  if (!authorized(request, admin ? adminToken : token)) return send(response, 401, { error: "unauthorized" });
  try {
    if (admin) {
      if (url.pathname === "/admin/fault" && request.method === "POST") {
        const input = await body(request);
        if (!validKey(input.request_key) || input.mode !== "drop_after_commit") return send(response, 400, { error: "invalid fault" });
        db.prepare("INSERT INTO faults(request_key, mode) VALUES (?, ?) ON CONFLICT(request_key) DO UPDATE SET mode = excluded.mode").run(input.request_key, input.mode);
        return send(response, 200, { configured: true });
      }
      if (url.pathname === "/admin/state" && request.method === "GET") {
        const key = url.searchParams.get("request_key");
        if (!validKey(key)) return send(response, 400, { error: "one synthetic request key is required" });
        return send(response, 200, {
          jobs: db.prepare("SELECT * FROM jobs WHERE request_key = ?").all(key),
          publications: db.prepare("SELECT * FROM publications WHERE request_key = ?").all(key),
          invocations: db.prepare("SELECT * FROM invocations WHERE request_key = ? ORDER BY id LIMIT 100").all(key),
        });
      }
      return send(response, 404, { error: "not found" });
    }
    if (url.pathname !== "/mcp" || request.method !== "POST") return send(response, 405, { error: "POST /mcp required" });
    const rpc = await body(request);
    if (!Object.hasOwn(rpc, "id")) {
      response.writeHead(202).end();
      return;
    }
    if (rpc.method === "initialize") return send(response, 200, {
      jsonrpc: "2.0", id: rpc.id,
      result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "appa-native-fixture", version: "1" } },
    });
    if (rpc.method === "tools/list") return send(response, 200, { jsonrpc: "2.0", id: rpc.id, result: { tools } });
    if (rpc.method === "tools/call") {
      const result = callTool(rpc.params);
      if (result.drop) return request.socket.destroy();
      return send(response, 200, { jsonrpc: "2.0", id: rpc.id, result: result.result });
    }
    return send(response, 200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "method not found" } });
  } catch {
    return send(response, 400, { error: "invalid fixture request" });
  }
});

server.listen(Number(process.env.APPA_FIXTURE_PORT || 18880), process.env.APPA_FIXTURE_HOST || "127.0.0.1", () => {
  console.log(JSON.stringify({ fixture: "ready", port: server.address().port, businessServicesUsed: false }));
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  server.closeAllConnections();
  server.close(() => { db.close(); process.exit(0); });
});
