/** Preserve OAuth resource URLs while routing reserved .localhost hosts locally. */
export const GROK_LOOPBACK_PROXY = String.raw`
async function startGrokLoopbackProxy(state, env) {
  const document = readGrokToml(state.block);
  const urls = [
    state.nativeSession?.url,
    ...Object.values(document.model || {}).map(model => model.base_url),
    ...Object.values(document.mcp_servers || {}).map(server => server.url),
    state.oauthIssuer,
  ].filter(Boolean).map(value => new URL(value));
  if (!urls.some(url => url.protocol === "http:" && url.hostname.endsWith(".localhost"))) return null;
  const origins = new Set(urls.filter(url => url.protocol === "http:").map(url => url.origin));
  const http = require("node:http");
  const outgoing = new Set();
  const server = http.createServer((request, response) => {
    let target;
    try { target = new URL(request.url); } catch {}
    if (!target || target.username || target.password || !origins.has(target.origin)) {
      response.writeHead(403); response.end("This development transport only serves the approved loopback connection."); return;
    }
    const headers = { ...request.headers, host: target.host };
    for (const name of ["proxy-authorization", "proxy-connection", "connection"]) delete headers[name];
    const upstream = http.request(target, { ...(target.hostname.endsWith(".localhost") ? { hostname: "127.0.0.1" } : {}), method: request.method, headers }, received => {
      response.writeHead(received.statusCode, received.headers);
      received.pipe(response);
      received.once("error", () => response.destroy());
    });
    outgoing.add(upstream);
    upstream.once("close", () => outgoing.delete(upstream));
    upstream.once("error", () => {
      if (response.destroyed) return;
      if (!response.headersSent) response.writeHead(502);
      response.end("The approved local deployment could not be reached.");
    });
    request.once("aborted", () => upstream.destroy());
    response.once("close", () => upstream.destroy());
    request.pipe(upstream);
  });
  server.on("connect", (_request, socket) => { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); });
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = "http://127.0.0.1:" + server.address().port;
  env.HTTP_PROXY = address; env.http_proxy = address;
  // Retain unrelated bypass rules. A blanket bypass previously meant HTTPS
  // was direct, so keep it direct when making the local HTTP exception.
  const bypass = (env.NO_PROXY || env.no_proxy || "").split(",").map(value => value.trim()).filter(Boolean);
  if (bypass.includes("*")) for (const name of ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) delete env[name];
  const retained = bypass.filter(value => {
    if (value === "*") return false;
    const host = value.toLowerCase().replace(/^\*?\./, "").split(":")[0];
    return !urls.some(url => url.hostname === host || url.hostname.endsWith("." + host));
  }).join(",");
  env.NO_PROXY = retained; env.no_proxy = retained;
  let closed = false;
  return {
    close: async () => {
      if (closed) return;
      closed = true;
      for (const request of outgoing) request.destroy();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
`;
