export const GROK_SHELL = String.raw`
function grokShellProfiles() {
  const os = require("node:os"), home = os.homedir();
  if (process.platform !== "win32") return [
    ...[".bash_profile", ".bash_login", ".profile", ".bashrc"].map(name => path.join(home, name)),
    path.join(process.env?.ZDOTDIR ? path.resolve(process.env.ZDOTDIR) : home, ".zshrc")
  ];
  const result = require("node:child_process").spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Environment]::GetFolderPath('MyDocuments') | ConvertTo-Json -Compress"], { encoding: "utf8", shell: false, windowsHide: true, timeout: 10000 });
  let documents;
  try { documents = result.status === 0 ? JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim()) : null; } catch {}
  if (typeof documents !== "string" || !path.isAbsolute(documents)) throw new Error("PowerShell profile directory could not be resolved. No shell profile was changed.");
  return ["WindowsPowerShell", "PowerShell"].map(edition => path.join(documents, edition, "profile.ps1"));
}
function grokShellChanges(state, install) {
  const start = "# BEGIN ARCHESTRA MANAGED GROK", end = "# END ARCHESTRA MANAGED GROK";
  const sh = value => "'" + value.replace(/'/g, "'\\''") + "'";
  const ps = value => "'" + value.replace(/'/g, "''") + "'";
  const launcher = path.join(require("node:os").homedir(), ".archestra", "grok", "launch.cjs");
  const connection = path.join(path.dirname(launcher), "connection.json");
  const managed = "& " + ps(process.execPath) + " " + ps(launcher) + " @args";
  // Windows installers may copy the executable rather than link it. Compare
  // content on both lookup and invocation, without caching a stale identity.
  const windowsAgentIdentity = (agent, grok) =>
    "(Split-Path " + agent + " -Leaf) -ieq 'agent.exe' -and (& { param($candidate, $native) try { $a = (Microsoft.PowerShell.Utility\\Get-FileHash -LiteralPath $candidate -Algorithm SHA256 -ErrorAction Stop).Hash; $g = (Microsoft.PowerShell.Utility\\Get-FileHash -LiteralPath $native -Algorithm SHA256 -ErrorAction Stop).Hash; return ($a -and $g -and ($a -eq $g)) } catch { return $false } } " + agent + " " + grok + ")";
  const windowsBody = [
    "function global:grok { if (Test-Path -LiteralPath " + ps(connection) + ") { " + managed + " } else { $archGrok = Get-Command grok -CommandType Application -ErrorAction Stop | Select-Object -First 1; & $archGrok.Source @args } }",
    "$archGrokNative = Get-Command grok -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1",
    "$archAgentNative = Get-Command agent -ErrorAction SilentlyContinue",
    "if ($archGrokNative -and $archAgentNative -and $archAgentNative.CommandType -eq 'Application' -and (" + windowsAgentIdentity("$archAgentNative.Source", "$archGrokNative.Source") + ")) {",
    "  function global:agent { $archAgent = Get-Command agent -CommandType Application,ExternalScript -ErrorAction Stop | Select-Object -First 1; $archGrok = Get-Command grok -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1; if ($archGrok -and (" + windowsAgentIdentity("$archAgent.Source", "$archGrok.Source") + ") -and (Test-Path -LiteralPath " + ps(connection) + ")) { " + managed + " } else { & $archAgent.Source @args } }",
    "}",
    "Remove-Variable archGrokNative,archAgentNative -ErrorAction SilentlyContinue"
  ].join("\r\n");
  // Grok installs agent as a link to the same executable. Check file identity
  // as well as command lookup: a shared bin directory can hold another agent.
  // Preserve aliases/functions and recheck at invocation in case PATH changed.
  // Subshells keep command lookup and temporary variables out of the profile.
  const unixAgentCheck = 'archGrok=$(command -v grok) && archAgent=$(command -v agent) && [ -f "$archGrok" ] && [ -x "$archGrok" ] && [ -f "$archAgent" ] && [ -x "$archAgent" ] && [ "$archAgent" -ef "$archGrok" ]';
  const unixAgentFunction = 'agent() ( unalias agent grok 2>/dev/null || :; unset -f agent grok; if ' + unixAgentCheck + ' && [ -f ' + sh(connection) + ' ]; then ' + sh(process.execPath) + " " + sh(launcher) + ' "$@"; else command agent "$@"; fi )';
  const unixBody = [
    // Keep the original alias declaration in the profile for disconnect, but
    // make the connected command use the launcher even if that alias bypassed
    // functions with an absolute path or "command grok".
    'unalias grok 2>/dev/null || :',
    'grok() { if [ -f ' + sh(connection) + ' ]; then ' + sh(process.execPath) + " " + sh(launcher) + ' "$@"; else command grok "$@"; fi; }',
    'if (unset -f grok; ! alias agent >/dev/null 2>&1 && ' + unixAgentCheck + '); then',
    // Do not parse an agent function declaration when an unrelated alias won
    // command lookup. The evaluated source contains only our quoted template.
    '  eval ' + sh(unixAgentFunction),
    'fi'
  ].join("\n");
  const body = process.platform === "win32"
    ? start + "\r\n" + windowsBody + "\r\n" + end
    : start + "\n" + unixBody + "\n" + end;
  const newline = process.platform === "win32" ? "\r\n" : "\n";
  const changes = [], profiles = [], locations = grokShellProfiles();
  if (state?.shellProfiles?.some(entry => !locations.includes(entry.file))) throw new Error("Shell profile locations changed. Restore the previous ZDOTDIR before reconnecting or disconnecting Grok.");
  const unix = process.platform !== "win32", home = require("node:os").homedir();
  const loginProfiles = unix ? [".bash_profile", ".bash_login", ".profile"].map(name => path.join(home, name)) : [];
  const onlyManaged = (file, bytes) => {
    const previous = state?.shellProfiles?.find(entry => entry.file === file);
    return bytes !== null && previous?.before === null && typeof previous.block === "string" &&
      bytes.toString().replace(/\r\n/g, "\n") === previous.block.replace(/\r\n/g, "\n");
  };
  // A profile created by an earlier installer must not hide the user's
  // original login profile. Preserve profiles with later user edits.
  const loginProfile = loginProfiles.find(file => {
    const bytes = grokFile(file);
    return bytes !== null && !onlyManaged(file, bytes);
  }) || path.join(home, ".bash_profile");
  const createdProfiles = new Set(unix ? [path.join(home, ".bashrc"), locations[locations.length - 1], loginProfile] : locations);
  for (const file of locations) {
    const before = grokFile(file), previous = state?.shellProfiles?.find(entry => entry.file === file);
    if (install && before === null && !previous && !createdProfiles.has(file)) continue;
    const keep = install && !(unix && loginProfiles.includes(file) && file !== loginProfile && onlyManaged(file, before));
    const utf16 = before?.[0] === 255 && before?.[1] === 254;
    const encoding = utf16 ? "utf16le" : "utf8";
    const text = before?.toString(encoding) || "";
    if (before && !Buffer.from(text, encoding).equals(before)) throw new Error("The shell profile is not UTF-8 or UTF-16LE. Preserve its encoding and add the managed launcher manually.");
    let content, block = (text && !text.endsWith("\n") ? newline : "") + body + newline;
    if (previous) {
      if (typeof previous.block !== "string" || !previous.block.includes(start) || !previous.block.includes(end)) throw new Error("Managed Grok shell ownership is invalid.");
      // Editors may normalize line endings without changing the owned command.
      // Match only that difference; splice the original surrounding text intact.
      const pattern = previous.block.split(/\r?\n/).map(line => line.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&")).join("\\r?\\n");
      const matches = [...text.matchAll(new RegExp(pattern, "g"))];
      if (matches.length !== 1 || text.split(start).length !== 2 || text.split(end).length !== 2) throw new Error("The managed grok shell function changed. Preserve your edits and restore its marked block before reconnecting or disconnecting.");
      const match = matches[0], owned = match[0], from = owned.indexOf(start), to = owned.indexOf(end) + end.length;
      const ownedNewline = /\r?\n/.exec(owned.slice(from))?.[0] || newline;
      block = owned.slice(0, from) + body.replace(/\r?\n/g, ownedNewline) + owned.slice(to);
      content = text.slice(0, match.index) + (keep ? block : "") + text.slice(match.index + owned.length);
      const original = Buffer.from(previous.before || "", "base64");
      if (!keep && (content === original.toString(encoding) || process.platform === "win32" && content.replace(/^\uFEFF/, "") === original.toString(encoding))) content = previous.before === null ? null : original;
    } else {
      if (!install) continue;
      if (text.includes(start) || text.includes(end)) throw new Error("An unrecognized managed Grok profile block exists. Preserve the profile before reconnecting.");
      const prefix = process.platform === "win32" && !text.startsWith("\uFEFF") ? "\uFEFF" : "";
      content = prefix + text + block;
    }
    if (keep) profiles.push({ file, block, before: previous ? previous.before : before?.toString("base64") ?? null });
    if (typeof content === "string") content = Buffer.from(content, encoding);
    if (install) fs.mkdirSync(path.dirname(file), { recursive: true });
    changes.push({ file, expected: before, content });
  }
  return { changes, profiles };
}
`;
