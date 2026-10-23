/** Private, ownership-aware state shared by setup and the native launcher. */
export const PI_INSTALLATION = String.raw`
const PiInstallation = (() => {
  const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const block = '\n# Managed Pi launcher PATH\nexport PATH="$HOME/.local/bin:$PATH"\n';
  return class PiInstallation {
    constructor() {
      this.home = os.homedir(); this.root = path.join(this.home, ".archestra/pi");
      this.stateFile = path.join(this.root, "install-state.json");
      this.safe(this.stateFile);
      this.state = this.readJson(this.stateFile);
    }
    safe(file) {
      const home = path.resolve(this.home); let current = path.resolve(file);
      if (!current.startsWith(home + path.sep)) throw new Error("Configuration must stay inside the home directory.");
      while (current !== home) {
        let stat; try { stat = fs.lstatSync(current); } catch (e) { if (e.code !== "ENOENT") throw e; }
        if (stat && (stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()))) throw new Error("Refusing linked or unowned Pi configuration.");
        current = path.dirname(current);
      }
    }
    read(file) { this.safe(file); return fs.existsSync(file) ? fs.readFileSync(file).toString("base64") : null; }
    readJson(file) { const bytes = this.read(file); return bytes === null ? null : JSON.parse(Buffer.from(bytes, "base64").toString("utf8")); }
    save(file, bytes) {
      this.safe(file); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      if (bytes === null) { fs.rmSync(file, { force: true }); return; }
      const temp = file + ".archestra-" + crypto.randomUUID(); this.safe(temp);
      try { fs.writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 }); fs.renameSync(temp, file); }
      finally { fs.rmSync(temp, { force: true }); }
    }
    persist() { this.save(this.stateFile, JSON.stringify(this.state, null, 2) + "\n"); }
    lock() {
      this.safe(path.join(this.root, "install.lock")); fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
      try { fs.mkdirSync(path.join(this.root, "install.lock"), { mode: 0o700 }); }
      catch { throw new Error("Pi setup or disconnect is already running. Keep its recovery snapshot and retry when it finishes."); }
      try { this.state = this.readJson(this.stateFile); }
      catch (error) { this.unlock(); throw error; }
    }
    unlock() { fs.rmdirSync(path.join(this.root, "install.lock")); }
    begin({ server, gateway, providers }) {
      if (this.state) {
        if (this.state.format !== 1 || this.state.server !== server || this.state.gateway !== gateway) throw new Error("Disconnect the previous Pi connection before changing its gateway.");
        this.validate();
        // Keep every provider introduced by this connection across reconnects.
        // A persisted /model choice may still reference an earlier catalog.
        this.state.providers = [...new Set([...this.state.providers, ...providers])];
        this.persist(); return;
      }
      const agent = path.join(this.home, ".pi/agent"), auth = this.readJson(path.join(agent, "mcp-auth.json")) || {};
      this.state = { format: 1, legacy: fs.existsSync(path.join(this.root, "connection.json")), files: {}, server, gateway, providers,
        authKey: "mcp__" + server.replace(/-/g, "_") + "|" + gateway, authBefore: auth["mcp__" + server.replace(/-/g, "_") + "|" + gateway] ?? null,
        settingsBefore: this.readJson(path.join(agent, "settings.json")), profiles: {} };
      this.persist(); // Durable BEFORE the first configuration change.
    }
    write(file, bytes, kind = "file") {
      const key = path.relative(this.home, file); const before = this.read(file);
      const entry = this.state.files[key] ||= { before, kind, beforeMode: before === null ? null : fs.statSync(file).mode & 0o777 };
      if (entry.expected !== undefined && before !== entry.expected && before !== entry.before) throw new Error("A managed Pi file changed. Preserve your edits and rerun setup after resolving the conflict.");
      entry.expected = Buffer.from(bytes).toString("base64"); this.persist(); this.save(file, bytes);
    }
    gateway(config) {
      const file = path.join(this.home, ".pi/agent/mcp.json"); const current = this.readJson(file) || {};
      current.mcpServers ||= {};
      if (!this.state.mcp) this.state.mcp = { beforeFile: this.read(file), beforeMode: fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : null, before: current.mcpServers[this.state.server] ?? null };
      const record = this.state.mcp;
      if (record.expected && !equal(current.mcpServers[this.state.server], record.expected) && !equal(current.mcpServers[this.state.server] ?? null, record.before)) throw new Error("The connected MCP entry changed. Preserve your edits before reconnecting.");
      record.expected = config; this.persist(); current.mcpServers[this.state.server] = config;
      this.save(file, JSON.stringify(current, null, 2) + "\n");
    }
    profile(file) {
      const text = Buffer.from(this.read(file) || "", "base64").toString("utf8");
      const key = path.relative(this.home, file);
      if (this.state.profiles[key]) return;
      // Do not claim a PATH entry that existed before this installation.
      if (text.includes("# Managed Pi launcher PATH") || text.includes('$HOME/.local/bin') || text.includes(path.join(this.home, ".local/bin"))) return;
      this.state.profiles[key] = { before: this.read(file), beforeMode: fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : null, block }; this.persist(); this.save(file, text + block);
      if (typeof this.state.profiles[key].beforeMode === "number") fs.chmodSync(file, this.state.profiles[key].beforeMode);
    }
    windowsPath(script) {
      const { execFileSync } = require("node:child_process");
      const run = action => execFileSync("powershell.exe", ["-NoProfile", "-File", script, action, path.join(this.home, ".local/bin")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000 }).trim();
      if (!this.state.windowsPath) {
        const before = JSON.parse(run("read")); const bin = path.join(this.home, ".local/bin");
        const present = before.split(";").some(value => value.replace(/[\\/]+$/, "").toLowerCase() === bin.toLowerCase());
        this.state.windowsPath = { added: !present, before, bin }; this.persist();
        if (!present) run("add");
      }
    }
    validate() {
      if (!this.state || this.state.format !== 1) throw new Error("Pi recovery snapshot is missing. Rerun connection setup; do not delete existing settings.");
      for (const [key, entry] of Object.entries(this.state.files)) {
        const current = this.read(path.join(this.home, key));
        if (current !== entry.expected && current !== entry.before) throw new Error("A managed Pi file changed. Disconnect stopped without overwriting it. Preserve your edits and retry.");
      }
      if (this.state.mcp) {
        const current = this.readJson(path.join(this.home, ".pi/agent/mcp.json")) || {};
        const value = current.mcpServers?.[this.state.server] ?? null;
        if (!equal(value, this.state.mcp.expected) && !equal(value, this.state.mcp.before)) throw new Error("The MCP entry was edited. Disconnect stopped without overwriting it.");
      }
      for (const [key, entry] of Object.entries(this.state.profiles)) {
        const current = this.read(path.join(this.home, key)); const text = Buffer.from(current || "", "base64").toString("utf8");
        if (current !== entry.before && text.split(entry.block).length !== 2) throw new Error("The managed PATH block was edited. Restore that block before disconnecting; other profile edits are preserved.");
      }
    }
    disconnect() {
      if (!this.state && !fs.existsSync(path.join(this.root, "connection.json"))) return;
      if (!this.state) throw new Error("Pi recovery snapshot is missing. Existing configuration was preserved. Recover pre-connection files from your backups before removing the connection.");
      if (this.state.legacy) throw new Error("This connection predates restoration snapshots. Existing configuration was preserved. Review .archestra-backup files and recover your original Pi configuration before removing the connection.");
      this.validate();
      const agent = path.join(this.home, ".pi/agent");
      const authFile = path.join(agent, "mcp-auth.json"), settingsFile = path.join(agent, "settings.json");
      const auth = this.readJson(authFile) || {}, settings = this.readJson(settingsFile);
      const entry = auth[this.state.authKey];
      // A previous disconnect may have restored OAuth before a later file write failed.
      if (entry && !equal(entry, this.state.authBefore) && (entry.serverUrl !== this.state.gateway || (this.state.authClient && entry.clientInformation?.client_id !== this.state.authClient))) throw new Error("The gateway sign-in record changed. No settings were removed.");
      // Validate every touched path before making changes, including the mutable native stores.
      this.safe(authFile); this.safe(settingsFile);
      if (this.state.windowsPath?.added) {
        const script = path.join(this.root, "path.ps1"); this.safe(script);
        require("node:child_process").execFileSync("powershell.exe", ["-NoProfile", "-File", script, "remove", this.state.windowsPath.bin], { stdio: "pipe", timeout: 10000 });
      }
      if (this.state.mcp) {
        const file = path.join(agent, "mcp.json"); const current = this.readJson(file) || {};
        current.mcpServers ||= {};
        if (this.state.mcp.before === null) delete current.mcpServers[this.state.server]; else current.mcpServers[this.state.server] = this.state.mcp.before;
        const original = this.state.mcp.beforeFile === null ? {} : JSON.parse(Buffer.from(this.state.mcp.beforeFile, "base64"));
        const normalized = structuredClone(current); if (!Object.keys(normalized.mcpServers).length && !Object.hasOwn(original, "mcpServers")) delete normalized.mcpServers;
        this.save(file, equal(normalized, original) ? (this.state.mcp.beforeFile === null ? null : Buffer.from(this.state.mcp.beforeFile, "base64")) : JSON.stringify(current, null, 2) + "\n");
        if (fs.existsSync(file) && typeof this.state.mcp.beforeMode === "number") fs.chmodSync(file, this.state.mcp.beforeMode);
      }
      // Only the exact connection's OAuth record; never revoke server-side or touch another gateway.
      if (entry && !equal(entry, this.state.authBefore)) {
        if (this.state.authBefore === null) delete auth[this.state.authKey]; else auth[this.state.authKey] = this.state.authBefore;
        this.save(authFile, JSON.stringify(auth, null, 2) + "\n");
      }
      // Pi may persist a /model choice. Restore only the connected provider's pair.
      if (settings && (settings.defaultProvider === "archestra" || this.state.providers.includes(settings.defaultProvider))) {
        for (const key of ["defaultProvider", "defaultModel"]) {
          if (this.state.settingsBefore && Object.hasOwn(this.state.settingsBefore, key)) settings[key] = this.state.settingsBefore[key]; else delete settings[key];
        }
        this.save(settingsFile, JSON.stringify(settings, null, 2) + "\n");
      }
      for (const [key, entry] of Object.entries(this.state.profiles)) {
        const file = path.join(this.home, key), bytes = this.read(file); if (bytes === entry.before) continue;
        const text = Buffer.from(bytes || "", "base64").toString("utf8").replace(entry.block, "");
        this.save(file, !text && entry.before === null ? null : text);
        if (fs.existsSync(file) && typeof entry.beforeMode === "number") fs.chmodSync(file, entry.beforeMode);
      }
      // Restore exact prior bytes only for unchanged owned files. No recursive removal.
      for (const [key, entry] of Object.entries(this.state.files)) {
        const file = path.join(this.home, key); this.save(file, entry.before === null ? null : Buffer.from(entry.before, "base64"));
        if (entry.before !== null && typeof entry.beforeMode === "number") fs.chmodSync(file, entry.beforeMode);
      }
      this.save(this.stateFile, null);
      this.state = null;
    }
  };
})();
`;

/** The PATH helper uses a file to avoid PowerShell 5.1 native argument quoting. */
export const PI_WINDOWS_PATH = String.raw`# Managed Pi launcher PATH
$ErrorActionPreference = 'Stop'
$action = $args[0]
$entry = $args[1]
$value = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($null -eq $value) { $value = '' }
if ($action -eq 'read') { ConvertTo-Json -Compress -InputObject $value; exit 0 }
$parts = @($value -split ';')
$matches = @($parts | Where-Object { $_.TrimEnd('\', '/') -ieq $entry })
if ($action -eq 'add') {
  if ($matches.Count -eq 0) { [Environment]::SetEnvironmentVariable('Path', ($value + $(if ($value) { ';' } else { '' }) + $entry), 'User') }
} elseif ($action -eq 'remove') {
  if ($matches.Count -gt 1 -or ($matches.Count -eq 1 -and $matches[0] -cne $entry)) { throw 'The managed PATH entry changed. Preserve it and resolve the duplicate before disconnecting.' }
  if ($matches.Count -eq 1) { [Environment]::SetEnvironmentVariable('Path', (($parts | Where-Object { $_ -cne $entry }) -join ';'), 'User') }
} else { throw 'Unknown PATH operation.' }
`;

export const PI_LIFECYCLE = String.raw`// Managed Pi launcher lifecycle.
${PI_INSTALLATION}
module.exports = { PiInstallation };
if (require.main === module) {
  const install = new PiInstallation();
  try {
    if (process.argv[2] === "disconnect") {
      install.lock();
      try { install.disconnect(); } finally { install.unlock(); }
      console.log("Disconnected Pi. Open a new terminal and run pi. Shared marketplace files and other clients were preserved.");
    } else if (process.argv[2] === "verify-disconnected") {
      if (require("node:fs").existsSync(require("node:path").join(install.root, "connection.json"))) throw new Error("Pi remains connected. Run arcpi --disconnect to see the recovery details.");
    } else if (process.argv[2] === "check") {
      checkPiConnection(install).then(report => {
        console.log(JSON.stringify(report));
      }).catch(() => { console.log(JSON.stringify({ llm: "down", llmCheck: "proxy-catalog", upstreamInference: "not-tested", mcp: "down", skills: "down" })); process.exitCode = 1; });
    } else throw new Error("Unknown Pi connection action.");
  } catch (error) { console.error(error instanceof SyntaxError ? "Pi configuration could not be read. Preserve it and repair the JSON before retrying." : error.message); process.exitCode = 1; }
}
async function checkPiConnection(install) {
  const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
  // "llm" is the shared loader's reachability marker, not an inference/auth test.
  const report = { llm: "down", llmCheck: "proxy-catalog", upstreamInference: "not-tested", mcp: "down", skills: "down", checkedAt: Date.now(), reasons: [] };
  let config;
  try {
    install.validate();
    config = install.readJson(path.join(install.root, "connection.json"));
    const source = fs.readFileSync(path.join(install.home, ".pi/agent/extensions/archestra-pi.js"));
    if (crypto.createHash("sha256").update(source).digest("hex") !== config.extensionSha256) throw new Error();
  } catch { report.reasons.push("Pi configuration changed or its recovery snapshot is missing. Rerun setup or resolve local edits."); return report; }
  const request = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)))) throw new Error();
    return fetch(parsed, { ...options, redirect: "error", signal: AbortSignal.timeout(5000) });
  };
  await Promise.all([
    (async () => {
      try {
        const headers = { Authorization: "Bearer " + (config.apiKey || process.env.OPENAI_API_KEY || "") };
        if (config.attributionKey) headers["x-archestra-virtual-key"] = config.attributionKey;
        const response = await request(config.url.replace(/\/$/, "") + "/models", { headers });
        if (!response.ok) { await response.body?.cancel(); report.reasons.push("LLM proxy check failed (HTTP " + response.status + "). Check the provider route on the connection page."); return; }
        const data = await response.json();
        if (!Array.isArray(data.data) || !data.data.some(model => model.id === (config.modelRouter ? config.provider + ":" + config.model : config.model))) throw new Error();
        report.llm = "ok";
      } catch { report.reasons.push("LLM proxy or selected model is unavailable. Check the connection page and retry."); }
    })(),
    (async () => {
      try {
        const auth = install.readJson(path.join(install.home, ".pi/agent/mcp-auth.json")) || {};
        const entry = auth[install.state.authKey];
        if (!entry || entry.serverUrl !== install.state.gateway || !entry.tokens?.access_token) throw new Error();
        const response = await request(install.state.gateway, { method: "POST", headers: { Authorization: "Bearer " + entry.tokens.access_token, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: "pi-startup", method: "tools/list", params: {} }) });
        if (!response.ok) { await response.body?.cancel(); throw new Error(); }
        const text = await response.text(); const payload = response.headers.get("content-type")?.includes("text/event-stream") ? JSON.parse(text.split("\n").find(line => line.startsWith("data: "))?.slice(6) || "null") : JSON.parse(text);
        if (!Array.isArray(payload?.result?.tools)) throw new Error();
        if (!install.state.authClient && entry.clientInformation?.client_id) {
          install.lock();
          try {
            if (!install.state || install.state.gateway !== entry.serverUrl) throw new Error();
            if (!install.state.authClient) { install.state.authClient = entry.clientInformation.client_id; install.persist(); }
            else if (install.state.authClient !== entry.clientInformation.client_id) throw new Error();
          } finally { install.unlock(); }
        }
        report.mcp = "ok";
      } catch { report.reasons.push("MCP sign-in or gateway check failed. Run arcpi --reconnect to sign in, or disconnect from the startup menu."); }
    })(),
    (async () => {
      try {
        if (config.skills) {
          const owner = install.readJson(path.join(install.home, ".archestra/skills", config.skills.marketplaceName, ".git/archestra-skills.json"));
          if (owner?.sourceFingerprint !== crypto.createHash("sha256").update(config.skills.cloneUrl).digest("hex")) throw new Error();
          const directory = path.join(install.home, ".archestra/skills", config.skills.marketplaceName);
          const git = (...args) => require("node:child_process").execFileSync("git", ["-c", "core.fsmonitor=false", "-C", directory, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 2000 });
          if (git("rev-parse", "HEAD").trim() !== owner.revision) throw new Error();
          git("diff", "--quiet"); git("diff", "--cached", "--quiet");
        }
        report.skills = "ok";
      } catch { report.reasons.push("Shared skills ownership changed. Rerun setup; unmanaged skills were preserved."); }
    })(),
  ]);
  return report;
}
`;
