import { GROK_HTTP } from "./grok-http";

/**
 * A child-scoped transport, not a credential provider. Grok owns its login file,
 * refresh locks and bearer. Only authenticated metadata and governed inference
 * can leave this listener; catalog URLs cannot select another upstream.
 */
export const GROK_NATIVE_TRANSPORT = `${GROK_HTTP}
${String.raw`
class GrokNativeTransport {
  constructor(connection) {
    this.connection = connection;
    this.prefix = "/" + require("node:crypto").randomBytes(24).toString("hex");
    this.outgoing = new Set();
  }
  async start() {
    const target = new URL(this.connection.url);
    if (!["https:", "http:"].includes(target.protocol) || target.username || target.password || target.search || target.hash) throw new Error("Invalid managed Grok transport.");
    this.target = target;
    const http = require("node:http");
    this.server = http.createServer((request, response) => {
      this.handle(request, response).catch(() => {
        if (response.destroyed) return;
        if (!response.headersSent) {
          response.writeHead(502, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: { message: "Native Grok transport failed. Verify your subscription login and the managed connection.", type: "connection_error" } }));
        } else response.destroy();
      });
    });
    this.server.on("connect", (_request, socket) => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
    this.server.headersTimeout = 10000;
    await new Promise((resolve, reject) => { this.server.once("error", reject); this.server.listen(0, "127.0.0.1", resolve); });
    this.base = "http://127.0.0.1:" + this.server.address().port + this.prefix;
    return this;
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.outgoing) request.destroy();
    this.server?.closeAllConnections();
    if (this.server) await new Promise(resolve => this.server.close(resolve));
  }
  async handle(request, response) {
    response.setHeader("Cache-Control", "no-store");
    const suffix = request.url?.slice(this.prefix.length);
    const metadata = request.method === "GET" && ["/models", "/settings", "/login-config"].includes(suffix);
    const privacy = request.method === "PUT" && suffix === "/privacy/coding-data-retention";
    const inference = request.method === "POST" && ["/responses", "/chat/completions"].includes(suffix);
    if (request.url !== this.prefix + suffix || (!metadata && !privacy && !inference) || request.headers.host !== new URL(this.base).host) {
      response.writeHead(403); response.end("This transport serves only the managed native Grok session."); return;
    }
    const authorization = request.headers.authorization;
    // A login-config probe before sign-in is optional in the native CLI. Do not
    // turn it into an authenticated inference or credential-discovery proxy.
    if (suffix === "/login-config" && !authorization) { response.writeHead(404); response.end(); return; }
    const headers = { ...request.headers, ...this.connection.headers, "x-archestra-grok-credential-mode": "native-session", "x-archestra-agent-id": "grok-build" };
    for (const name of ["cookie", "proxy-authorization", "proxy-connection", "connection", "host", "origin", "referer"]) delete headers[name];
    if (metadata || privacy) {
      let privacyBody;
      if (privacy) {
        const chunks = []; let bytes = 0;
        try {
          if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity") throw new Error("encoding");
          for await (const chunk of request) {
            bytes += chunk.length;
            if (bytes > 4096) throw new Error("size");
            chunks.push(chunk);
          }
          const body = JSON.parse(Buffer.concat(chunks).toString());
          if (!body || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.codingDataRetentionOptOut !== "boolean") throw new Error("body");
          privacyBody = JSON.stringify({ codingDataRetentionOptOut: body.codingDataRetentionOptOut });
        } catch {
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: "The native privacy update requires exactly one boolean preference." })); return;
        }
        delete headers["content-length"];
        headers["content-type"] = "application/json";
      }
      const upstream = await grokFetch(this.connection.url.replace(/\/+$/, "") + "/native" + suffix, {
        method: privacy ? "PUT" : "GET", ...(privacy ? { body: privacyBody } : {}),
        headers: { ...headers, "accept-encoding": "identity" }, redirect: "error", signal: AbortSignal.timeout(20000),
      });
      response.statusCode = upstream.status;
      response.setHeader("Content-Type", "application/json");
      if (!upstream.ok) { response.end(JSON.stringify({ error: privacy ? "Native Grok rejected the privacy update. The local preference was not changed." : "Native Grok metadata was rejected. Use /login to renew your subscription session or retry the connection." })); await upstream.body?.cancel(); return; }
      const reader = upstream.body?.getReader(), chunks = [];
      let bytes = 0;
      if (!reader) throw new Error("Empty native metadata.");
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.length;
          if (bytes > 2 * 1024 * 1024) throw new Error("Native metadata exceeds its limit.");
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const text = Buffer.concat(chunks).toString();
      const value = JSON.parse(text);
      if (suffix === "/settings") {
        try { assertGrokNativeRouting(value); }
        catch (error) { this.routingConflict = true; throw error; }
        // These are capabilities of the serving transport, not account policy.
        // The governed JSON endpoints do not accept compressed request bodies.
        value.accept_request_encodings = [];
      }
      response.end(JSON.stringify(suffix === "/models" ? this.catalog(value) : value));
      return;
    }
    if (this.routingConflict) throw new Error("Native settings conflict with protected routing.");
    // Streaming goes through the existing governed route without parsing,
    // buffering, translating, or logging native messages or bearer tokens.
    const target = new URL(this.connection.url.replace(/\/+$/, "") + suffix);
    const outgoing = require(target.protocol === "https:" ? "node:https" : "node:http").request(target, {
      method: "POST", headers: { ...headers, host: target.host },
      ...(target.protocol === "http:" && target.hostname.endsWith(".localhost") ? { hostname: "127.0.0.1" } : {}),
    }, received => {
      if (received.statusCode >= 300 && received.statusCode < 400) {
        received.destroy(); response.writeHead(502); response.end("The protected inference endpoint redirected; no redirect was followed."); return;
      }
      const returned = { ...received.headers, "cache-control": "no-store" };
      for (const name of ["set-cookie", "connection"]) delete returned[name];
      response.writeHead(received.statusCode, returned);
      received.once("error", () => response.destroy());
      received.pipe(response);
    });
    this.outgoing.add(outgoing);
    outgoing.once("close", () => this.outgoing.delete(outgoing));
    outgoing.once("error", () => { if (!response.headersSent) response.writeHead(502); response.end("The protected inference endpoint could not be reached."); });
    request.once("aborted", () => outgoing.destroy());
    response.once("close", () => outgoing.destroy());
    request.pipe(outgoing);
  }
  catalog(value) {
    if (!value || !Array.isArray(value.data) || !value.data.length || value.data.length > 2048) throw new Error("Native catalog is unavailable.");
    const data = value.data.map(entry => {
      if (!entry || typeof entry !== "object" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(entry.id || "")) throw new Error("Invalid native catalog model.");
      const backend = entry.apiBackend ?? entry.api_backend ?? "chat_completions";
      if (!["responses", "chat_completions"].includes(backend)) return null;
      // Preserve native display names, IDs, variants, reasoning menus, context
      // windows and capabilities. Replace every routing/credential spelling.
      const protectedEntry = { ...entry, baseUrl: this.base, base_url: this.base };
      for (const key of ["apiKey", "api_key", "envKey", "env_key", "apiBaseUrl", "api_base_url", "extraHeaders", "extra_headers", "auth_provider", "model_provider", "auth_scheme"]) delete protectedEntry[key];
      return protectedEntry;
    }).filter(Boolean);
    if (!data.length) throw new Error("No supported native inference protocol is available.");
    return { ...value, data };
  }
}
function assertGrokNativeRouting(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if ((["model", "model_providers"].includes(key) && child && typeof child === "object" && Object.keys(child).length) ||
        (key === "endpoints" && child && ["cli_chat_proxy_base_url", "xai_api_base_url", "models_base_url", "models_list_url", "models_endpoint"].some(name => Object.hasOwn(child, name)))) {
      throw new Error("Native model routing conflicts with the protected connection. Preserve the native policy and reconcile its endpoint settings before launching.");
    }
    assertGrokNativeRouting(child);
  }
}
`}`;
