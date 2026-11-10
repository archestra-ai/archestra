import { GROK_HTTP } from "./grok-http";

export const GROK_MCP_SIGN_IN = `${GROK_HTTP}
${String.raw`
class GrokMcpSignIn {
  constructor(options) {
    this.options = options;
    this.fs = require("node:fs");
    this.path = require("node:path");
    this.crypto = require("node:crypto");
    this.controller = new AbortController();
    this.resource = this.url(options.url).href;
    this.issuer = this.url(options.issuer).href.replace(/\/$/, "");
    this.origins = new Set([new URL(this.resource).origin, new URL(this.issuer).origin]);
    this.home = this.path.resolve(options.home || process.env.GROK_HOME || this.path.join(require("node:os").homedir(), ".grok"));
    this.cache = this.path.join(this.home, "mcp_credentials.json");
    this.key = options.serverName + ":" + this.resource;
  }
  async run({ force = false } = {}) {
    const cancel = () => this.controller.abort();
    const timer = setTimeout(cancel, this.options.timeout || 120000);
    process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
    try {
      this.safe(this.cache);
      this.before = this.fs.existsSync(this.cache) ? this.fs.readFileSync(this.cache, "utf8") : null;
      let cache;
      try { cache = this.before === null ? {} : JSON.parse(this.before); }
      catch { throw new Error("Grok MCP credential cache is corrupt. It was not changed."); }
      if (!cache || typeof cache !== "object" || Array.isArray(cache)) throw new Error("Grok MCP credential cache is not a native object. It was not changed.");
      const previous = cache[this.key];
      if (previous && (!previous.client_id || previous.issuer !== this.issuer || !Array.isArray(previous.granted_scopes) || !Number.isSafeInteger(previous.token_received_at) || typeof previous.token_response?.access_token !== "string")) throw new Error("This gateway's native credential record has an unknown format or issuer. It was not changed.");
      const resourceUrl = new URL(this.resource);
      const protectedResource = await this.json(new URL("/.well-known/oauth-protected-resource" + resourceUrl.pathname, resourceUrl));
      if (protectedResource.resource !== this.resource || !protectedResource.authorization_servers?.includes(this.issuer) || !protectedResource.scopes_supported?.includes("mcp")) throw new Error("MCP resource or issuer discovery did not match the approved connection.");
      const issuerUrl = new URL(this.issuer);
      const metadataUrl = new URL("/.well-known/oauth-authorization-server" + (issuerUrl.pathname === "/" ? "" : issuerUrl.pathname), issuerUrl);
      const metadata = await this.json(metadataUrl);
      if (metadata.issuer !== this.issuer || !metadata.code_challenge_methods_supported?.includes("S256") || !metadata.token_endpoint_auth_methods_supported?.includes("none")) throw new Error("The approved MCP issuer does not support public-client PKCE S256.");
      for (const name of ["authorization_endpoint", "token_endpoint", "registration_endpoint"]) this.endpoint(metadata[name]);
      if (new URL(metadata.authorization_endpoint).origin !== issuerUrl.origin) throw new Error("MCP authorization endpoint did not match the approved issuer.");
      if (previous && !force) {
        const expires = previous.token_response.expires_at || previous.token_received_at + (previous.token_response.expires_in || 0);
        if (expires > Math.floor(Date.now() / 1000) + 60) {
          try {
            await this.verify(previous.token_response.access_token);
            console.log("MCP gateway authorization verified. Existing native Grok login kept.");
            return;
          } catch (error) { if (error.status !== 401) throw error; }
        }
        if (typeof previous.token_response.refresh_token === "string") {
          try {
            const token = await this.token(metadata.token_endpoint, { grant_type: "refresh_token", refresh_token: previous.token_response.refresh_token, client_id: previous.client_id, resource: this.resource });
            await this.verify(token.access_token);
            this.save(cache, { ...previous, token_response: { ...token, refresh_token: token.refresh_token || previous.token_response.refresh_token }, granted_scopes: token.scope.split(" "), token_received_at: Math.floor(Date.now() / 1000) });
            console.log("MCP gateway authorization refreshed and verified for native Grok.");
            return;
          } catch (error) { if (![400, 401].includes(error.status)) throw error; }
        }
      }
      const callback = await this.callback(metadata);
      const scope = "mcp" + (metadata.scopes_supported?.includes("offline_access") ? " offline_access" : "");
      const registration = await this.json(this.endpoint(metadata.registration_endpoint), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Grok Build connection installer", redirect_uris: [callback.redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope }) });
      if (typeof registration.client_id !== "string" || !registration.client_id || registration.client_id.length > 1024 || (registration.token_endpoint_auth_method && registration.token_endpoint_auth_method !== "none")) throw new Error("MCP client registration did not return a public client.");
      const verifier = this.crypto.randomBytes(32).toString("base64url");
      const authorize = this.endpoint(metadata.authorization_endpoint);
      authorize.search = new URLSearchParams({ response_type: "code", client_id: registration.client_id, redirect_uri: callback.redirect, scope, resource: this.resource, state: callback.state, code_challenge: this.crypto.createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString();
      console.log("Opening browser consent. Waiting for MCP authorization; Ctrl+C cancels without changing the credential cache.");
      console.log("Open " + authorize.href);
      await this.open(authorize.href);
      const code = await callback.code;
      const token = await this.token(metadata.token_endpoint, { grant_type: "authorization_code", code, client_id: registration.client_id, redirect_uri: callback.redirect, code_verifier: verifier, resource: this.resource });
      await this.verify(token.access_token);
      this.save(cache, { client_id: registration.client_id, issuer: this.issuer, token_response: token, granted_scopes: token.scope.split(" "), token_received_at: Math.floor(Date.now() / 1000) });
      console.log("MCP gateway authorization verified and saved for native Grok. Returning to the installer.");
    } catch (error) {
      if (this.controller.signal.aborted) throw new Error("MCP authorization timed out or was cancelled. The credential cache was not changed; rerun sign-in to retry.");
      throw error;
    } finally {
      clearTimeout(timer);
      process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
      this.controller.abort();
      if (this.server) { this.server.closeAllConnections(); await new Promise(resolve => this.server.close(resolve)); }
    }
  }
  url(value) {
    let url;
    try { url = new URL(value); } catch { throw new Error("Invalid approved MCP connection URL."); }
    if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.hostname.endsWith(".localhost"))))) throw new Error("MCP authorization requires approved HTTPS or explicit loopback development URLs.");
    return url;
  }
  endpoint(value) {
    const url = this.url(value);
    if (!this.origins.has(url.origin)) throw new Error("MCP discovery returned an endpoint outside the approved server and issuer origins.");
    return url;
  }
  safe(file) {
    let current = this.path.resolve(file);
    while (true) {
      const stat = this.fs.lstatSync(current, { throwIfNoEntry: false });
      if (stat && (stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid() && current !== this.path.parse(current).root && current.startsWith(this.home)))) throw new Error("MCP credentials will not follow linked or unowned paths.");
      const parent = this.path.dirname(current); if (parent === current) break; current = parent;
    }
    const stat = this.fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.nlink !== 1 || stat.size > 1048576)) throw new Error("MCP credential cache must be a bounded, private native file.");
  }
  async json(url, options = {}) {
    const controller = new AbortController(), abort = () => controller.abort();
    this.controller.signal.addEventListener("abort", abort, { once: true });
    if (this.controller.signal.aborted) abort();
    const timer = setTimeout(abort, 10000);
    try {
    let response;
    try { response = await grokFetch(url, { ...options, redirect: "error", signal: controller.signal }); }
    catch { throw new Error("MCP authorization request failed. Check the approved deployment connection; no response body or credential was logged."); }
    if (!response.ok) { await response.body?.cancel(); const error = new Error("MCP authorization request failed (HTTP " + response.status + "). The credential cache was not changed."); error.status = response.status; throw error; }
    let size = 0; const chunks = [];
    for await (const chunk of response.body) { size += chunk.length; if (size > 1048576) throw new Error("MCP authorization response exceeded its size limit."); chunks.push(chunk); }
    const text = Buffer.concat(chunks).toString("utf8");
    try {
      const value = response.headers.get("content-type")?.includes("text/event-stream") ? JSON.parse(text.split(/\r?\n/).find(line => line.startsWith("data: ")).slice(6)) : JSON.parse(text);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return value;
    } catch { throw new Error("MCP authorization returned an unsupported response. The credential cache was not changed."); }
    } finally { clearTimeout(timer); this.controller.signal.removeEventListener("abort", abort); }
  }
  async token(endpoint, parameters) {
    const token = await this.json(this.endpoint(endpoint), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(parameters).toString() });
    if (typeof token.access_token !== "string" || !token.access_token || token.access_token.length > 65536 || /[\r\n]/.test(token.access_token) || token.token_type?.toLowerCase() !== "bearer" || !Number.isSafeInteger(token.expires_in) || token.expires_in <= 0 || typeof token.scope !== "string" || !token.scope.split(" ").includes("mcp")) throw new Error("MCP token response did not contain the required bounded native bearer grant.");
    return { access_token: token.access_token, token_type: token.token_type, expires_in: token.expires_in, expires_at: Math.floor(Date.now() / 1000) + token.expires_in, scope: token.scope, ...(typeof token.refresh_token === "string" && token.refresh_token.length <= 65536 ? { refresh_token: token.refresh_token } : {}) };
  }
  async verify(token) {
    const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "X-Archestra-Agent-Id": "grok-build", "x-appa-session-id": this.crypto.randomUUID() };
    const initialize = await this.json(new URL(this.resource), { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "grok-installer", version: "1" } } }) });
    if (initialize.error || initialize.id !== 1 || !initialize.result?.protocolVersion) throw new Error("Authenticated MCP initialize failed. Native credentials were not changed.");
    const tools = await this.json(new URL(this.resource), { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) });
    if (tools.error || tools.id !== 2 || !Array.isArray(tools.result?.tools)) throw new Error("Authenticated MCP tool discovery failed. Native credentials were not changed.");
  }
  async callback(metadata) {
    const state = this.crypto.randomBytes(32).toString("base64url"), route = "/callback/" + this.crypto.randomBytes(24).toString("hex");
    let resolveCode, rejectCode, used = false;
    const code = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
    code.catch(() => {});
    this.controller.signal.addEventListener("abort", () => rejectCode(new Error("MCP authorization cancelled.")), { once: true });
    this.server = require("node:http").createServer((request, response) => {
      const expectedHost = "127.0.0.1:" + this.server.address().port;
      response.setHeader("Content-Type", "text/plain; charset=utf-8"); response.setHeader("Cache-Control", "no-store"); response.setHeader("Referrer-Policy", "no-referrer");
      let url;
      try { url = new URL(request.url, "http://" + expectedHost); }
      catch { response.writeHead(400); response.end("Invalid authorization callback."); return; }
      if (request.method !== "GET" || request.headers.host !== expectedHost || url.origin !== "http://" + expectedHost || url.pathname !== route) { response.writeHead(400); response.end("Invalid authorization callback."); return; }
      if (used) { response.writeHead(409); response.end("Authorization callback already received."); return; }
      const params = url.searchParams;
      if (["state", "code", "iss", "error"].some(name => params.getAll(name).length > 1) || params.get("state") !== state || (params.has("iss") && params.get("iss") !== this.issuer) || (metadata.authorization_response_iss_parameter_supported && !params.has("iss"))) { used = true; response.writeHead(400); response.end("Authorization callback rejected."); rejectCode(new Error("MCP callback state or issuer did not match. No token was exchanged.")); return; }
      used = true;
      const value = params.get("code");
      if (params.has("error") || !value || !/^[A-Za-z0-9._~-]{1,4096}$/.test(value)) { response.writeHead(400); response.end("Authorization was not completed. Return to the installer."); rejectCode(new Error("MCP browser consent was denied or returned an invalid code. No credential was changed.")); return; }
      response.end("Authorization received. Return to the installer while it verifies the gateway."); resolveCode(value);
    });
    this.server.requestTimeout = 5000; this.server.headersTimeout = 5000;
    await new Promise((resolve, reject) => { this.server.once("error", () => reject(new Error("MCP loopback callback could not start."))); this.server.listen(0, "127.0.0.1", resolve); });
    return { state, code, redirect: "http://127.0.0.1:" + this.server.address().port + route };
  }
  async open(url) {
    const browser = process.env.BROWSER;
    let command = browser || (process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open");
    let args = !browser && process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
    let interop = false;
    if (!browser && process.platform === "linux" && (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)) {
      const find = name => {
        const result = require("node:child_process").spawnSync("which", [name], { encoding: "utf8", shell: false });
        return result.status === 0 ? result.stdout.trim().split("\n")[0] : "";
      };
      const view = find("wslview");
      if (view) command = view;
      else if (process.env.WSL_INTEROP) {
        const windowsRundll = "/mnt/c/Windows/System32/rundll32.exe";
        const rundll = find("rundll32.exe") || (this.fs.existsSync(windowsRundll) ? windowsRundll : "");
        if (rundll) { command = rundll; args = ["url.dll,FileProtocolHandler", url]; interop = true; }
      }
    }
    await new Promise((resolve, reject) => {
      let child;
      const timer = setTimeout(() => { child?.kill(); reject(new Error("Browser launch timed out. No credential was changed; check your default browser and retry sign-in.")); }, 5000);
      const start = (executable, arguments_, bridged = false) => {
        child = require("node:child_process").spawn(executable, arguments_, { shell: false, windowsHide: true, stdio: "ignore" });
        child.once("error", error => {
          if (error.code === "ENOEXEC" && interop && !bridged && this.fs.existsSync("/init")) { start("/init", [executable, ...arguments_], true); return; }
          clearTimeout(timer); reject(new Error("Browser could not open. No credential was changed; configure your default browser and retry sign-in."));
        });
        child.once("exit", status => { clearTimeout(timer); if (status === 0) resolve(); else reject(new Error("Browser could not open. No credential was changed; retry sign-in.")); });
      };
      start(command, args);
    });
  }
  save(cache, entry) {
    this.safe(this.cache);
    const current = this.fs.existsSync(this.cache) ? this.fs.readFileSync(this.cache, "utf8") : null;
    if (current !== this.before) throw new Error("Native Grok credentials changed during authorization. No existing cache was overwritten; retry with other Grok sessions closed.");
    this.fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const temporary = this.cache + "." + this.crypto.randomUUID() + ".tmp";
    try {
      this.fs.writeFileSync(temporary, JSON.stringify({ ...cache, [this.key]: entry }, null, 2), { mode: 0o600, flag: "wx" });
      if (process.platform === "win32") {
        const child = require("node:child_process");
        const identity = child.execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
        const sid = identity.match(/S-1-(?:\d+-)+\d+/)?.[0];
        if (!sid) throw new Error();
        child.execFileSync("icacls.exe", [temporary, "/inheritance:r", "/grant:r", "*" + sid + ":F"], { stdio: "ignore", windowsHide: true, timeout: 10000 });
      }
      this.safe(this.cache);
      if ((this.fs.existsSync(this.cache) ? this.fs.readFileSync(this.cache, "utf8") : null) !== this.before) throw new Error();
      this.fs.renameSync(temporary, this.cache);
    } catch { throw new Error("Native MCP credentials could not be stored privately or changed concurrently. The existing cache was preserved."); }
    finally { if (this.fs.existsSync(temporary)) this.fs.unlinkSync(temporary); }
  }
}
`}`;
