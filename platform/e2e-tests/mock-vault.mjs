#!/usr/bin/env node
/**
 * Minimal Vault API mock for E2E (credentials-with-vault). Listens on 8200.
 * Use when Docker isn't available so Vault tests still run.
 */
import http from "http";

const PORT = 8200;
const store = new Map();

const routes = [
  [
    "GET",
    "/v1/sys/health",
    () => ({ status: 200, body: JSON.stringify({ initialized: true }) }),
  ],
  [
    "PUT",
    "/v1/sys/mounts/secret",
    () => ({ status: 204, body: "" }),
  ],
  [
    "POST",
    "/v1/secret/data/teams/default-team",
    (req, body) => {
      try {
        const data = typeof body === "string" ? JSON.parse(body) : body;
        store.set("secret/data/teams/default-team", data.data || data);
        return { status: 200, body: JSON.stringify({ data: { data: store.get("secret/data/teams/default-team") } }) };
      } catch {
        return { status: 400, body: "{}" };
      }
    },
  ],
  [
    "GET",
    "/v1/secret/data/teams/default-team",
    () => {
      const data = store.get("secret/data/teams/default-team") || {};
      return { status: 200, body: JSON.stringify({ data: { data } }) };
    },
  ],
  [
    "LIST",
    "/v1/secret/metadata/teams",
    () => ({ status: 200, body: JSON.stringify({ data: { keys: ["default-team"] } }) }),
  ],
  [
    "GET",
    "/v1/secret/metadata/teams",
    () => ({ status: 200, body: JSON.stringify({ data: { keys: ["default-team"] } }) }),
  ],
  [
    "LIST",
    "/v1/secret/metadata/teams/",
    () => ({ status: 200, body: JSON.stringify({ data: { keys: ["default-team"] } }) }),
  ],
  [
    "GET",
    "/v1/secret/metadata/teams/",
    () => ({ status: 200, body: JSON.stringify({ data: { keys: ["default-team"] } }) }),
  ],
  // KV v1 or path used as-is for list
  ["LIST", "/v1/secret/data/teams", () => ({ status: 200, body: JSON.stringify({ data: { keys: ["default-team"] } }) })],
  ["GET", "/v1/secret/data/teams", () => ({ status: 200, body: JSON.stringify({ data: { keys: ["default-team"] } }) })],
];

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (ch) => (buf += ch));
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = (req.url?.split("?")[0] || "").replace(/\/+$/, "") || "/";
  const method = req.method;
  let body = "";
  try {
    body = await parseBody(req);
  } catch (_) {}

  for (const [m, path, handler] of routes) {
    const pathNorm = path.replace(/\/+$/, "") || "/";
    if (m === method && pathNorm === url) {
      try {
        const result = handler(req, body);
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(result.body || "");
        return;
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: String(e.message) }));
        return;
      }
    }
  }
  // LIST to any secret path: return keys so backend checkConnectivity succeeds
  if ((method === "LIST" || method === "GET") && url.startsWith("/v1/secret")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: { keys: ["default-team"] } }));
    return;
  }
  // Fallback for other Vault paths (e.g. backend read) so tests don't 404
  if (url.startsWith("/v1/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: {} }));
    return;
  }
  res.writeHead(404);
  res.end("{}");
});

server.listen(PORT, "0.0.0.0", () => {
  process.stderr.write(`Mock Vault listening on http://127.0.0.1:${PORT}\n`);
});
