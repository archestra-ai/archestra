import { VIRTUAL_KEY_HEADER } from "@archestra/shared/consts";
import type { OpenCodeFamilyClient } from "../opencode-family";
import type { SetupScriptContext } from "../types";
import { managedRuntimeManifest } from "./managed-runtime";
import {
  MANAGED_RUNTIME_BOOTSTRAP,
  MANAGED_TUI_BOOTSTRAP,
  managedPluginBootstrap,
} from "./managed-runtime-bootstrap";
import { publicManagedCatalog } from "./opencode-primary-config";

export function managedRuntimeInstall(params: {
  client: OpenCodeFamilyClient;
  context: SetupScriptContext;
  routes: Record<string, string>;
  headers: Record<string, string>;
  routeHeaders?: Record<string, Record<string, string>>;
}): { script: string; v1: string; v2: string } | null {
  const source = params.context.managedRuntimeSource;
  if (!source) return null;
  const catalog = installCatalog(params.context);
  const manifest = managedRuntimeManifest({
    installation: source.installation,
    clientId: params.client.clientId,
    catalog,
  });
  const privateParams = {
    clientId: params.client.clientId,
    installation: source.installation,
    source,
    origin: new URL(source.url).origin,
    appName: params.context.appName,
    routes: params.routes,
    headers: params.headers,
    routeHeaders: params.routeHeaders,
    // Stored apart from any route, so a passthrough route the deployment's
    // catalog lists after this setup can carry it too.
    ...(params.context.proxy?.passthroughVirtualKey
      ? {
          passthroughHeaders: {
            [VIRTUAL_KEY_HEADER]: params.context.proxy.passthroughVirtualKey,
          },
        }
      : {}),
    mcp: params.context.mcp,
    skipRelpath: `.archestra/${params.client.stateName}-startup-guard.skip`,
    ...(params.context.proxy?.virtualKey
      ? { managedKeyFile: `${params.client.stateName}-primary.key` }
      : {}),
  };
  return {
    v1: managedPluginBootstrap(1).replace(
      "CLIENT_RUNTIME_DIRECTORY",
      JSON.stringify(`${params.client.stateName}-runtime`),
    ),
    v2: managedPluginBootstrap(2).replace(
      "CLIENT_RUNTIME_DIRECTORY",
      JSON.stringify(`${params.client.stateName}-runtime`),
    ),
    script: `if (Number(process.versions.node.split(".")[0]) < 18) throw new Error("Node.js 18 or newer is required for managed launcher updates");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const root = path.join(os.homedir(), ".archestra", ${JSON.stringify(`${params.client.stateName}-runtime`)});
const manifest = ${JSON.stringify(manifest)};
const params = ${JSON.stringify(privateParams)};
params.apiMajor = params.clientId === "opencode" && Number(process.env.ARCHESTRA_OC_RUNTIME_API_MAJOR) >= 2 ? 2 : 1;
params.questionCards = false;
try {
  const version = require("node:child_process").execFileSync(${JSON.stringify(params.client.binary)}, ["--version"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).match(/(\\d+)\\.(\\d+)\\.(\\d+)/);
  if (version) {
    const [major, minor, patch] = version.slice(1).map(Number);
    params.questionCards = params.apiMajor === 1 && (params.clientId === "opencode"
      ? major === 1 && (minor > 19 || (minor === 19 && patch >= 3))
      : major === 7 && (minor > 8 || (minor === 8 && patch >= 15)));
  }
} catch { /* Unknown clients keep native questions. */ }
if (params.managedKeyFile) {
  params.managedKeyPath = path.join(os.homedir(), ".archestra", params.managedKeyFile);
  delete params.managedKeyFile;
}
const bootstrap = ${JSON.stringify(MANAGED_RUNTIME_BOOTSTRAP)};
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
const check = file => {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (process.platform !== "win32" && (stat.mode & 0o022))) throw new Error("Unsafe managed runtime ownership");
};
check(root);
check(path.dirname(root));
if (process.platform === "win32") {
  // The launcher refuses to start unless the user owns ~/.archestra and no one
  // but the user, SYSTEM and Administrators can write to it. Other tools leave
  // it otherwise (Codex's Windows sandbox grants CodexSandboxUsers Modify, and
  // an elevated process makes Administrators the owner), so take ownership and
  // drop those write grants, generic write rights included. An inherited grant
  // can only go with inheritance: Windows first turns the inherited rules into
  // explicit ones (rebuilding them by hand fails on generic rights), then the
  // foreign ones are removed. The runtime directory is then owned by the user
  // and locked to the user alone.
  // Not Set-Acl: once an earlier install has locked an item, Set-Acl needs
  // SeSecurityPrivilege, which a non-admin user does not have. SetAccessControl
  // on the item works because powershell.exe is Windows PowerShell 5.1.
  // One process for both, with room for a slow start and for Windows to apply
  // the new rules to everything under ~/.archestra.
  try {
  require("node:child_process").execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    '$ErrorActionPreference="Stop"; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $trusted=@($sid.Value,"S-1-5-18","S-1-5-32-544"); $genericWrite=0x40000000; $genericAll=0x10000000; $writes=([int64][Security.AccessControl.FileSystemRights]"Write,Delete,ChangePermissions,TakeOwnership") -bor $genericWrite -bor $genericAll; $foreign={param($rule) $rule.AccessControlType -eq "Allow" -and $rule.IdentityReference.Value -notin $trusted -and (([int64]$rule.FileSystemRights -band $writes) -ne 0)}; $parent=$env:ARCHESTRA_RUNTIME_ACL_PARENT; $acl=Get-Acl -LiteralPath $parent; if(@($acl.GetAccessRules($false,$true,[Security.Principal.SecurityIdentifier]) | Where-Object {& $foreign $_}).Count -gt 0){$acl.SetAccessRuleProtection($true,$true); (Get-Item -LiteralPath $parent).SetAccessControl($acl); $acl=Get-Acl -LiteralPath $parent}; $changed=$false; if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){$acl.SetOwner($sid); $changed=$true}; foreach($rule in @($acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]) | Where-Object {& $foreign $_})){[void]$acl.RemoveAccessRuleSpecific($rule); $changed=$true}; if($changed){(Get-Item -LiteralPath $parent).SetAccessControl($acl)}; $acl=Get-Acl -LiteralPath $env:ARCHESTRA_RUNTIME_ACL_PATH; if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){$acl.SetOwner($sid)}; $acl.SetAccessRuleProtection($true,$false); foreach($rule in @($acl.Access)){[void]$acl.RemoveAccessRuleSpecific($rule)}; $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,"FullControl","ContainerInherit,ObjectInherit","None","Allow"))); (Get-Item -LiteralPath $env:ARCHESTRA_RUNTIME_ACL_PATH).SetAccessControl($acl)'
  ], { env: { ...process.env, ARCHESTRA_RUNTIME_ACL_PARENT: path.dirname(root), ARCHESTRA_RUNTIME_ACL_PATH: root }, timeout: 15000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const detail = error.code === "ETIMEDOUT" ? "PowerShell timed out after 15000 ms" :
      (error.stderr && String(error.stderr).trim()) || error.code || "PowerShell exited with status " + error.status;
    throw new Error("Could not secure managed runtime " + root + " and parent " + path.dirname(root) + ": " + detail);
  }
}
if (process.platform !== "win32") fs.chmodSync(root, 0o700);
const fingerprint = crypto.createHash("sha256").update(bootstrap).digest("hex");
const ownerFile = path.join(root, "owner.json");
const lock = path.join(root, "lock");
const started = Date.now();
let acquired = false;
for (;;) {
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
    acquired = true;
    fs.writeFileSync(path.join(lock, "pid"), String(process.pid), { mode: 0o600 });
    break;
  } catch (error) {
    if (acquired) {
      fs.rmSync(lock, { recursive: true, force: true });
      throw error;
    }
    if (error.code !== "EEXIST") throw error;
    // A live owner may release the lock after mkdir observes EEXIST.
    try { check(lock); } catch (inspection) {
      if (inspection.code !== "ENOENT") throw inspection;
    }
    try {
      const pid = Number(fs.readFileSync(path.join(lock, "pid"), "utf8"));
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); } catch (probe) {
          if (probe.code === "ESRCH") fs.rmSync(lock, { recursive: true });
        }
      }
    } catch {}
    if (Date.now() - started > (process.platform === "win32" ? 30000 : 6000)) throw new Error("Managed runtime installation lock timed out");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}
try {
if (fs.existsSync(ownerFile)) {
  check(ownerFile);
  const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
  const oldBootstrap = path.join(root, "bootstrap.cjs");
  check(oldBootstrap);
  if (owner.clientId !== params.clientId || crypto.createHash("sha256").update(fs.readFileSync(oldBootstrap)).digest("hex") !== owner.bootstrapHash) throw new Error("Modified managed bootstrap; refusing overwrite");
} else if (fs.readdirSync(root).some(name => name !== "lock")) throw new Error("Runtime directory is not managed by this installer");
function atomic(file, bytes) {
  const temp = file + "." + crypto.randomUUID() + ".tmp";
  try { fs.writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
const revision = crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
const directory = path.join(root, revision);
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
check(directory);
for (const [name, artifact] of Object.entries(manifest.artifacts)) {
  const file = path.join(directory, name);
  if (fs.existsSync(file)) {
    check(file);
    if (crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== artifact.sha256) throw new Error("Modified managed artifact; refusing overwrite");
    if (process.platform !== "win32") fs.chmodSync(file, 0o600);
  } else atomic(file, artifact.source);
}
atomic(path.join(root, "bootstrap.cjs"), bootstrap);
atomic(path.join(root, "params.json"), JSON.stringify(params));
atomic(path.join(root, "current.json"), JSON.stringify(manifest));
atomic(ownerFile, JSON.stringify({ clientId: params.clientId, installation: params.installation, bootstrapHash: fingerprint }));
// Evaluate the installer-supplied verifier, never unchecked code from disk.
const verifier = { exports: {} };
new Function("module", "require", bootstrap)(verifier, require);
verifier.exports.verify(root);
// Register the TUI entry of this connection plugin separately: older server
// plugin loaders treat every export as a server hook. Never load UI there.
if (params.questionCards) {
  const configDir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), ${JSON.stringify(params.client.dir)});
  const tuiConfig = path.join(configDir, "tui.json");
  const tuiCommented = path.join(configDir, "tui.jsonc");
  const tuiEntry = path.join(root, "tui.mjs");
  try {
    if (fs.existsSync(tuiEntry)) check(tuiEntry);
    atomic(tuiEntry, ${JSON.stringify(MANAGED_TUI_BOOTSTRAP)});
    if (fs.existsSync(tuiCommented)) throw new Error("tui.jsonc needs manual plugin registration");
    fs.mkdirSync(configDir, { recursive: true });
    check(configDir);
    if (fs.existsSync(tuiConfig)) check(tuiConfig);
    const cfg = fs.existsSync(tuiConfig) ? JSON.parse(fs.readFileSync(tuiConfig, "utf8").replace(/^\\uFEFF/, "")) : {};
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg) ||
        (cfg.plugin !== undefined && !Array.isArray(cfg.plugin))) throw new Error("Unsupported TUI configuration");
    const spec = require("node:url").pathToFileURL(tuiEntry).href;
    cfg.plugin = [...(cfg.plugin || []).filter(item => item !== spec), spec];
    atomic(tuiConfig, JSON.stringify(cfg, null, 2) + "\\n");
  } catch (error) {
    console.error("Connection installed with native question fallback: " + error.message);
  }
}
} finally { fs.rmSync(lock, { recursive: true, force: true }); }
`,
  };
}

function installCatalog(context: SetupScriptContext) {
  const proxy = context.proxy;
  const agentId = proxy?.routingAgentId;
  if (!proxy || !agentId) return undefined;
  let ordinaryBaseUrl: string;
  try {
    ordinaryBaseUrl = `${new URL(proxy.baseUrl).origin}/v1`;
  } catch {
    return undefined;
  }
  return publicManagedCatalog({
    primaryProviders: proxy.primaryProviders,
    passthroughProviders: proxy.passthroughProviders,
    ordinaryBaseUrl,
    routingAgentId: agentId,
  });
}
