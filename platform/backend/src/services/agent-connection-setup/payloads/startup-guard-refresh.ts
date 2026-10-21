/** Installed once by approved setup; updates only an unchanged generated guard. */
export const STARTUP_GUARD_REFRESH = String.raw`const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const hash = value => createHash("sha256").update(value).digest("hex");
function windowsAcl(file, privateFile, set = false) {
  if (process.platform !== "win32") return;
  const script = set
    ? '$ErrorActionPreference="Stop"; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object Security.AccessControl.FileSecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,"FullControl","Allow"))); Set-Acl -LiteralPath $env:ARCHESTRA_GUARD_ACL_PATH -AclObject $acl'
    : '$ErrorActionPreference="Stop"; $acl=Get-Acl -LiteralPath $env:ARCHESTRA_GUARD_ACL_PATH; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){exit 1}; $writes=[Security.AccessControl.FileSystemRights]"Write,Delete,ChangePermissions,TakeOwnership"; foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($rule.AccessControlType -eq "Allow" -and $rule.IdentityReference.Value -notin @($sid.Value,"S-1-5-18","S-1-5-32-544") -and ($env:ARCHESTRA_GUARD_ACL_PRIVATE -eq "1" -or ($rule.FileSystemRights -band $writes))){exit 1}}';
  require("node:child_process").execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, ARCHESTRA_GUARD_ACL_PATH: file, ARCHESTRA_GUARD_ACL_PRIVATE: privateFile ? "1" : "0" }, timeout: 1500, stdio: "ignore" });
}
function owned(file, directory = false, privateFile = false) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      (process.getuid && stat.uid !== process.getuid()) ||
      (process.platform !== "win32" && (stat.mode & (privateFile ? 0o077 : 0o022)))) throw new Error("Unsafe launch check ownership");
  windowsAcl(file, privateFile);
  return stat;
}
function atomic(file, bytes, mode) {
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temp, bytes, { flag: "wx", mode });
    windowsAcl(temp, true, true);
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}
async function refresh(guard, expectedVersion) {
  const statePath = guard + ".update.json";
  const lock = guard + ".update-lock";
  let acquired = false;
  try {
    owned(path.dirname(guard), true);
    owned(guard); owned(statePath, false, true); owned(__filename, false, true);
    try { fs.mkdirSync(lock, { mode: 0o700 }); acquired = true; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      // A crashed writer must not prevent later launches from retrying.
      owned(lock, true);
      let dead = false;
      try {
        const pid = Number(fs.readFileSync(path.join(lock, "pid"), "utf8"));
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); } catch (probe) { dead = probe.code === "ESRCH"; }
        }
      } catch { dead = Date.now() - fs.statSync(lock).mtimeMs > 30000; }
      if (dead) fs.rmSync(lock, { recursive: true });
      return;
    }
    fs.writeFileSync(path.join(lock, "pid"), String(process.pid), { mode: 0o600 });
    const stateText = fs.readFileSync(statePath, "utf8");
    const state = JSON.parse(stateText);
    if (state.updaterHash !== hash(fs.readFileSync(__filename))) throw new Error("Edited launch check updater");
    const before = fs.readFileSync(guard);
    if (!state.hashes.includes(hash(before))) throw new Error("Customized launch check was preserved");
    const match = before.toString("utf8").match(state.platform === "windows" ? /^\$GuardFormatVersion = (\d+)$/m : /^GUARD_FORMAT_VERSION=(\d+)$/m);
    const installed = Number(match?.[1]);
    if (!Number.isSafeInteger(expectedVersion) || !Number.isSafeInteger(installed) || expectedVersion <= installed) return;
    const url = new URL(state.url);
    const local = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ||
        (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
        url.username || url.password || url.search || url.hash || url.pathname !== "/api/connection-setups/startup-guard") throw new Error("Unsafe launch check update endpoint");
    const context = structuredClone(state.context);
    // The public renderer receives no credentials. Restore these only locally,
    // using the same quoting as the generated shell/PowerShell string literals.
    if (context.skills) context.skills.cloneUrl = "ARCH_GUARD_PRIVATE_CLONE_URL";
    if (context.proxy?.passthroughVirtualKey) context.proxy.passthroughVirtualKey = "ARCH_GUARD_PRIVATE_KEY";
    const response = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: state.clientId, platform: state.platform, context }),
      redirect: "error", signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) throw new Error("Launch check download unavailable");
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.length; if (size > 1024 * 1024) throw new Error("Launch check download too large");
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    const artifact = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (artifact.format !== 1 || artifact.clientId !== state.clientId || artifact.platform !== state.platform ||
        artifact.version !== expectedVersion || typeof artifact.source !== "string" ||
        artifact.sha256 !== hash(artifact.source)) throw new Error("Wrong launch check artifact");
    const quote = text => state.platform === "windows" ? "'" + text.replaceAll("'", "''") + "'" : "'" + text.replaceAll("'", "'\\''") + "'";
    let source = artifact.source;
    if (state.context.skills) source = source.replaceAll(quote("ARCH_GUARD_PRIVATE_CLONE_URL"), quote(state.context.skills.cloneUrl));
    if (state.context.proxy?.passthroughVirtualKey) {
      const encoded = JSON.stringify(state.context.proxy.passthroughVirtualKey).slice(1, -1);
      source = source.replaceAll("ARCH_GUARD_PRIVATE_KEY", quote(encoded).slice(1, -1));
    }
    const stamp = source.match(state.platform === "windows" ? /^\$GuardFormatVersion = (\d+)$/m : /^GUARD_FORMAT_VERSION=(\d+)$/m);
    if (Number(stamp?.[1]) !== expectedVersion) throw new Error("Wrong launch check version");
    // Recheck after the download so concurrent setup, disconnect or user edits win.
    owned(guard); owned(statePath);
    if (!fs.readFileSync(guard).equals(before) || fs.readFileSync(statePath, "utf8") !== stateText) throw new Error("Launch check changed during update");
    const bytes = Buffer.from((state.platform === "windows" ? "\ufeff" : "") + source);
    // Publish both accepted hashes first: a crash between the two renames leaves
    // either complete generation recoverable. Keep a private previous copy.
    atomic(guard + ".previous", before, 0o600);
    atomic(statePath, JSON.stringify({ ...state, hashes: [hash(before), hash(bytes)] }), 0o600);
    atomic(guard, bytes, owned(guard).mode & 0o777);
    console.error("Updated " + state.context.appName + " launch check automatically; applies next launch.");
  } catch (error) {
    const reasons = new Set(["Unsafe launch check ownership", "Edited launch check updater", "Customized launch check was preserved", "Unsafe launch check update endpoint", "Launch check download unavailable", "Launch check download too large", "Wrong launch check artifact", "Wrong launch check version", "Launch check changed during update"]);
    console.error("Could not update launch check automatically; kept the installed config and will retry next launch. " + (reasons.has(error.message) ? error.message : "Update unavailable."));
  } finally { if (acquired) fs.rmSync(lock, { recursive: true, force: true }); }
}
if (require.main === module) refresh(process.argv[2], Number(process.argv[3]));
`;
