import type { OpenCodeFamilyClient } from "../opencode-family";
import type { SetupScriptContext } from "../types";
import { managedRuntimeManifest } from "./managed-runtime";
import {
  MANAGED_RUNTIME_BOOTSTRAP,
  managedPluginBootstrap,
} from "./managed-runtime-bootstrap";

export function managedRuntimeInstall(params: {
  client: OpenCodeFamilyClient;
  context: SetupScriptContext;
  routes: Record<string, string>;
  headers: Record<string, string>;
  routeHeaders?: Record<string, Record<string, string>>;
  providerTwins?: Record<string, string>;
}): { script: string; v1: string; v2: string } | null {
  const source = params.context.managedRuntimeSource;
  if (!source) return null;
  const manifest = managedRuntimeManifest({
    installation: source.installation,
    clientId: params.client.clientId,
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
    providerTwins: params.providerTwins,
    mcp: params.context.mcp,
    skipRelpath: `.archestra/${params.client.stateName}-startup-guard.skip`,
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
const bootstrap = ${JSON.stringify(MANAGED_RUNTIME_BOOTSTRAP)};
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
if (process.platform === "win32") {
  require("node:child_process").execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    '$ErrorActionPreference="Stop"; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=Get-Acl -LiteralPath $env:ARCHESTRA_RUNTIME_ACL_PATH; if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){exit 1}; $acl.SetAccessRuleProtection($true,$false); foreach($rule in @($acl.Access)){[void]$acl.RemoveAccessRuleSpecific($rule)}; $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,"FullControl","ContainerInherit,ObjectInherit","None","Allow"); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $env:ARCHESTRA_RUNTIME_ACL_PATH -AclObject $acl'
  ], { env: { ...process.env, ARCHESTRA_RUNTIME_ACL_PATH: root }, timeout: 3000, stdio: "ignore" });
}
const check = file => {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (process.platform !== "win32" && (stat.mode & 0o022))) throw new Error("Unsafe managed runtime ownership");
};
check(root);
check(path.dirname(root));
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
    check(lock);
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
} finally { fs.rmSync(lock, { recursive: true, force: true }); }
`,
  };
}
