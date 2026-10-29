import {
  OPENCODE_V1_OAUTH_EXPORT,
  OPENCODE_V1_PROXY_EXPORT,
} from "./opencode-routing-plugin";

/** Stable trust boundary. Downloaded code is never evaluated until every hash passes. */
export const MANAGED_RUNTIME_BOOTSTRAP = `const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const hash = value => createHash("sha256").update(value).digest("hex");
const names = ["launcher.cjs", "repair.cjs", "routing-v1.mjs", "routing-v2.mjs"];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function owned(file, directory = false, privateFile = true) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      (process.getuid && stat.uid !== process.getuid()) || (process.platform !== "win32" && (stat.mode & (privateFile ? 0o077 : 0o022)))) {
    throw new Error("Unsafe managed runtime ownership: " + file);
  }
  if (process.platform === "win32") {
    try {
      require("node:child_process").execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        '$ErrorActionPreference="Stop"; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); try { $acl=Get-Acl -LiteralPath $env:ARCHESTRA_RUNTIME_ACL_PATH; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; if($owner -ne $sid.Value){[Console]::Error.WriteLine("Owner mismatch: actual="+$owner+"; expected="+$sid.Value); exit 2}; $genericWrite=0x40000000; $genericAll=0x10000000; $writes=([int64][Security.AccessControl.FileSystemRights]"Write,Delete,ChangePermissions,TakeOwnership") -bor $genericWrite -bor $genericAll; foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($rule.AccessControlType -eq "Allow" -and $rule.IdentityReference.Value -notin @($sid.Value,"S-1-5-18","S-1-5-32-544") -and ($env:ARCHESTRA_RUNTIME_ACL_PRIVATE -eq "1" -or (([int64]$rule.FileSystemRights -band $writes) -ne 0))){[Console]::Error.WriteLine("Foreign allow ACE: SID="+$rule.IdentityReference.Value+"; rights="+$rule.FileSystemRights+"; inherited="+$rule.IsInherited); exit 2}} } catch { [Console]::Error.WriteLine("PowerShell ACL inspection failed: "+$_.Exception.Message); exit 1 }'
      ], { env: { ...process.env, ARCHESTRA_RUNTIME_ACL_PATH: file, ARCHESTRA_RUNTIME_ACL_PRIVATE: privateFile ? "1" : "0" }, timeout: 15000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      const detail = error.code === "ETIMEDOUT" ? "PowerShell timed out after 15000 ms" :
        (error.stderr && String(error.stderr).trim()) || error.code || "PowerShell exited with status " + error.status;
      throw new Error("Managed runtime ACL check failed for " + file + " (" + (privateFile ? "private" : "no foreign writers") + "): " + detail);
    }
  }
}
function atomic(file, bytes) {
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function validate(manifest, params) {
  if (manifest.format !== 1 || manifest.installation !== params.installation || manifest.clientId !== params.clientId ||
      Object.keys(manifest.artifacts ?? {}).sort().join() !== [...names].sort().join()) throw new Error("Wrong managed runtime manifest");
  for (const name of names) {
    const artifact = manifest.artifacts[name];
    if (typeof artifact.source !== "string" || Buffer.byteLength(artifact.source) > 1024 * 1024 ||
        !/^[a-f0-9]{64}$/.test(artifact.sha256) || hash(artifact.source) !== artifact.sha256) throw new Error("Managed runtime hash mismatch");
  }
  return hash(JSON.stringify(manifest));
}
function cached(root, params) {
  const pointer = path.join(root, "current.json");
  owned(pointer);
  const manifest = JSON.parse(fs.readFileSync(pointer, "utf8"));
  const revision = validate(manifest, params);
  const directory = path.join(root, revision);
  owned(directory, true);
  for (const name of names) {
    const file = path.join(directory, name);
    owned(file);
    if (hash(fs.readFileSync(file)) !== manifest.artifacts[name].sha256) throw new Error("Modified managed runtime artifact");
  }
  return { directory, revision, params };
}
async function locked(root, callback) {
  const lock = path.join(root, "lock");
  const started = Date.now();
  let acquired = false;
  while (!acquired) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      acquired = true;
      fs.writeFileSync(path.join(lock, "pid"), String(process.pid), { mode: 0o600 });
    } catch (error) {
      if (acquired) {
        fs.rmSync(lock, { recursive: true, force: true });
        throw error;
      }
      if (error.code !== "EEXIST") throw error;
      // A live owner may release the lock after mkdir observes EEXIST.
      try { owned(lock, true); } catch (inspection) {
        if (inspection.code !== "ENOENT") throw inspection;
      }
      // Never steal a live lock, including slow starts. Dead processes leave no writer.
      try {
        const pid = Number(fs.readFileSync(path.join(lock, "pid"), "utf8"));
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); } catch (probe) {
            if (probe.code === "ESRCH") fs.rmSync(lock, { recursive: true });
          }
        }
      } catch {}
      if (Date.now() - started > (process.platform === "win32" ? 30000 : 6000)) throw new Error("Managed runtime launch lock timed out");
      await sleep(50);
    }
  }
  try { return await callback(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}
function installedParams(root) {
  owned(path.dirname(root), true, false);
  owned(root, true);
  owned(path.join(root, "params.json"));
  const params = JSON.parse(fs.readFileSync(path.join(root, "params.json"), "utf8"));
  owned(path.join(root, "owner.json"));
  owned(path.join(root, "bootstrap.cjs"));
  const owner = JSON.parse(fs.readFileSync(path.join(root, "owner.json"), "utf8"));
  if (owner.installation !== params.installation || owner.clientId !== params.clientId ||
      owner.bootstrapHash !== hash(fs.readFileSync(path.join(root, "bootstrap.cjs"))) ||
      !params.source.token.startsWith("cru1_" + params.installation + ".")) throw new Error("Managed runtime installation fingerprint mismatch");
  return params;
}
function verify(root) {
  const runtime = cached(root, installedParams(root));
  const checkedPath = path.join(root, "last-check.json");
  if (fs.existsSync(checkedPath)) owned(checkedPath);
  return runtime;
}
async function refresh(root) {
  const params = installedParams(root);
  return locked(root, async () => {
    const old = cached(root, params);
    const checkedPath = path.join(root, "last-check.json");
    if (fs.existsSync(checkedPath)) {
      owned(checkedPath);
      const checked = JSON.parse(fs.readFileSync(checkedPath, "utf8"));
      const age = Date.now() - checked.attemptedAt;
      if (checked.installation === params.installation && Number.isFinite(age) && age >= 0 && age < 30000) return old;
    }
    try {
      const url = new URL(params.source.url);
      if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" || url.protocol !== "https:" || url.origin !== params.origin || url.username || url.password || url.hash ||
          url.pathname !== "/api/connection-setups/runtime" || url.search) throw new Error("Unsafe runtime update endpoint");
      const response = await fetch(url, {
        headers: { Authorization: "Bearer " + params.source.token },
        redirect: "error", signal: AbortSignal.timeout(2500),
      });
      if (!response.ok) throw new Error("Managed runtime download unavailable");
      const reader = response.body.getReader();
      const chunks = []; let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 4 * 1024 * 1024) throw new Error("Managed runtime manifest too large");
          chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel().catch(() => {}); }
      const manifest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const revision = validate(manifest, params);
      if (revision !== old.revision) {
        const destination = path.join(root, revision);
        if (!fs.existsSync(destination)) {
          const temporary = path.join(root, revision + "." + randomUUID() + ".tmp");
          fs.mkdirSync(temporary, { mode: 0o700 });
          try {
            for (const name of names) fs.writeFileSync(path.join(temporary, name), manifest.artifacts[name].source, { flag: "wx", mode: 0o600 });
            fs.renameSync(temporary, destination);
          } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
        }
        // Validate pre-existing generations too, before switching the active pointer.
        owned(destination, true);
        for (const name of names) {
          owned(path.join(destination, name));
          if (hash(fs.readFileSync(path.join(destination, name))) !== manifest.artifacts[name].sha256) throw new Error("Modified staged managed artifact");
        }
        atomic(path.join(root, "current.json"), JSON.stringify(manifest));
      }
    } catch (error) {
      // Keep the verified cache, but do not hide a programming error in validate or write.
      console.error("Managed runtime refresh kept the verified cache:", error && error.message ? error.message : error);
    }
    atomic(checkedPath, JSON.stringify({ installation: params.installation, attemptedAt: Date.now() }));
    return cached(root, params);
  });
}
module.exports = { refresh, verify, locked, owned, atomic };
if (require.main === module) {
  refresh(path.dirname(__filename)).then(async runtime => {
    await require(path.join(runtime.directory, "launcher.cjs")).prepare(runtime);
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
`;

/** TUI half of the same connection plugin; the server entry stays unchanged. */
export const MANAGED_TUI_BOOTSTRAP = `import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
// The TUI host transpiles CommonJS dependencies as ESM without their exports.
// Embed the same verifier as the server loader, excluding its CJS entrypoint.
${MANAGED_RUNTIME_BOOTSTRAP.slice(0, MANAGED_RUNTIME_BOOTSTRAP.indexOf("module.exports ="))}
export default {
  id: "archestra.connection.questions",
  async tui(api) {
    const root = dirname(fileURLToPath(import.meta.url));
    try {
      const runtime = await refresh(root);
      // V2 uses a different host API. Leave its native question UI intact.
      if (runtime.params.apiMajor !== 1 || !runtime.params.questionCards) return;
      try {
        const skip = readFileSync(join(homedir(), runtime.params.skipRelpath), "utf8");
        if (skip.split(/\\r?\\n/).includes("mcp")) return;
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      const impl = await import(pathToFileURL(join(runtime.directory, "routing-v1.mjs")).href);
      await impl.QuestionCardsTui?.(api);
    } catch {
      api.ui?.toast?.({ title: "Connection question cards unavailable", message: "Using the client's native questions.", variant: "warning" });
    }
  },
};
`;

/** The installed plugin exports exactly the native API for its selected major. */
export function managedPluginBootstrap(major: 1 | 2): string {
  const prelude = `import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const root = join(homedir(), ".archestra", CLIENT_RUNTIME_DIRECTORY);
const loader = require(join(root, "bootstrap.cjs"));
let loading;
const load = () => loading ??= (async () => {
  const runtime = await loader.refresh(root);
  const impl = Object.keys(runtime.params.routes).length ? await import(pathToFileURL(join(runtime.directory, "routing-v${major}.mjs")).href) : null;
  return { runtime, impl };
})().finally(() => { loading = undefined; });
`;
  return major === 1
    ? `${prelude}
export const ${OPENCODE_V1_PROXY_EXPORT} = async (...args) => {
  let { runtime, impl } = await load();
  let delegate = impl ? await impl.${OPENCODE_V1_PROXY_EXPORT}(...args) : {};
  const hooks = { ...delegate };
  let bindingProof = {};
  const boundSessions = new Set();
  hooks.config = async cfg => {
    bindingProof = {};
    for (const sessionID of boundSessions) impl?.bindSessionProof(sessionID, {});
    const refreshed = await load();
    if (refreshed.runtime.revision !== runtime.revision) {
      ({ runtime, impl } = refreshed);
      delegate = impl ? await impl.${OPENCODE_V1_PROXY_EXPORT}(...args) : {};
      for (const name of Object.keys(hooks)) {
        if (!["config", "chat.params", "chat.headers"].includes(name) && !Object.hasOwn(delegate, name)) delete hooks[name];
      }
      for (const [name, hook] of Object.entries(delegate)) {
        if (!["config", "chat.params", "chat.headers"].includes(name)) hooks[name] = hook;
      }
    }
    const original = { mcp: JSON.parse(JSON.stringify(cfg.mcp ?? {})) };
    const connected = await require(join(runtime.directory, "launcher.cjs")).prepare(runtime, cfg);
    const candidateProof = impl?.captureMcpAliases(connected ? original : {}) ?? {};
    if (delegate.config) await delegate.config(cfg);
    bindingProof = candidateProof;
  };
  for (const name of ["chat.params", "chat.headers"]) {
    const hook = hooks[name];
    if (!hook) continue;
    hooks[name] = async (input, ...args) => {
      if (typeof input?.sessionID === "string") {
        boundSessions.delete(input.sessionID);
        boundSessions.add(input.sessionID);
        if (boundSessions.size > 512) boundSessions.delete(boundSessions.values().next().value);
      }
      impl.bindSessionProof(input?.sessionID, bindingProof);
      return delegate[name]?.(input, ...args);
    };
  }
  return hooks;
};
export const ${OPENCODE_V1_OAUTH_EXPORT} = async (...args) => (await load()).impl?.${OPENCODE_V1_OAUTH_EXPORT}(...args) ?? {};
`
    : `${prelude}
export default {
  id: "archestra.llm-proxy",
  async setup(ctx) {
    const { runtime, impl } = await load();
    let bindingProof = {};
    await require(join(runtime.directory, "launcher.cjs")).prepare(runtime);
    if (runtime.params.mcp && require(join(runtime.directory, "launcher.cjs")).connected(runtime.params)) {
      if (!ctx.mcp?.transform) throw new Error("OpenCode V2 MCP transform API is required for safe alias repair");
      await ctx.mcp.transform(editor => {
        bindingProof = {};
        const cfg = { mcp: Object.fromEntries(editor.list().map(([name, entry]) => [name, { ...entry, enabled: entry.enabled !== false && entry.disabled !== true }])) };
        const original = { mcp: JSON.parse(JSON.stringify(cfg.mcp)) };
        require(join(runtime.directory, "repair.cjs")).memory(cfg, runtime.params);
        for (const [name] of editor.list()) {
          if (!Object.hasOwn(cfg.mcp ?? {}, name)) editor.update(name, entry => { entry.disabled = true; });
          else {
            const { enabled, ...options } = cfg.mcp[name];
            editor.update(name, entry => { Object.assign(entry, options); });
          }
        }
        bindingProof = impl?.captureMcpAliases(original) ?? {};
      });
    }
    if (impl) await impl.default.setup(ctx, () => require(join(runtime.directory, "launcher.cjs")).connected(runtime.params) ? bindingProof : {});
  },
};
`;
}
