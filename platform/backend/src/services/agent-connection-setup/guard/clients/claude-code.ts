// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these files build bash/PowerShell source as JS strings, so `${VAR}` is shell
// parameter expansion for the emitted script, not a JS template placeholder

import {
  CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY,
  CLAUDE_CODE_PROXY_ENV_KEYS,
  EXTERNAL_AGENT_ID_HEADER,
  STARTUP_GUARD_INSTALL,
  VIRTUAL_KEY_HEADER,
} from "@archestra/shared";
import { renderPowerShellJsonWriter } from "../../steps/powershell-json";
import { psq, sh } from "../../steps/quoting";
import type { StartupGuardClient, StartupGuardContext } from "../startup-guard";
import { jsonMemberGoneVerify, windowsJsonMemberGoneVerify } from "./verify";

/**
 * Drop installer-owned Claude Code `permissions.allow` rules for the MCP server
 * being disconnected. The installer records only rules it newly added in
 * `~/.archestra/claude-appa-permissions.json` (`serverName` -> `string[]`);
 * preexisting user rules never enter that ledger. Settings honor
 * `CLAUDE_CONFIG_DIR` (else `~/.claude`). Custom profiles keep their ledger
 * under `$CLAUDE_CONFIG_DIR/.archestra`. Invalid JSON or types stay untouched.
 * Invoked from the
 * MCP disconnect arm only — not proxy disconnect — via `python3 -c` so the
 * guard engine's case-arm parser never sees an indented heredoc.
 */
const CLAUDE_APPA_PERMISSION_CLEANUP_PY = `import json, os, pathlib, tempfile

def load_json(path):
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return "missing", None
    except OSError:
        return "invalid", None
    if not raw.strip():
        return "empty", None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return "invalid", None
    if not isinstance(data, dict):
        return "invalid", None
    return "ok", data

def string_list(value):
    if not isinstance(value, list):
        return None
    if not all(isinstance(item, str) for item in value):
        return None
    return value

def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix="." + path.name + ".", suffix=".tmp")
    tmp = pathlib.Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\\n") as handle:
            json.dump(data, handle, indent=2, ensure_ascii=False)
            handle.write("\\n")
            handle.flush()
            os.fsync(handle.fileno())
        if path.exists():
            os.chmod(tmp, path.stat().st_mode & 0o777)
        os.replace(tmp, path)
    except Exception:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise

def drop_ledger_key(ledger_path, ledger, server):
    ledger.pop(server, None)
    if ledger:
        write_json(ledger_path, ledger)
        return
    try:
        ledger_path.unlink()
    except FileNotFoundError:
        pass

def main():
    server = os.environ.get("MCP_SERVER_NAME") or ""
    if not server:
        return
    home = pathlib.Path(os.path.expanduser("~"))
    state_root = pathlib.Path(os.environ["CLAUDE_CONFIG_DIR"]) if os.environ.get("CLAUDE_CONFIG_DIR") else home
    ledger_path = state_root / ".archestra" / "claude-appa-permissions.json"
    status, ledger = load_json(ledger_path)
    if status != "ok" or server not in ledger:
        return
    owned = string_list(ledger.get(server))
    if owned is None:
        return
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR") or str(home / ".claude")
    settings_path = pathlib.Path(config_dir) / "settings.json"
    settings_status, settings = load_json(settings_path)
    if settings_status == "invalid":
        return
    if settings_status == "ok":
        if "permissions" in settings and settings["permissions"] is not None:
            permissions = settings["permissions"]
            if not isinstance(permissions, dict):
                return
            if "allow" in permissions and permissions["allow"] is not None:
                allow = string_list(permissions["allow"])
                if allow is None:
                    return
                owned_set = set(owned)
                kept = [item for item in allow if item not in owned_set]
                if len(kept) != len(allow):
                    permissions["allow"] = kept
                    write_json(settings_path, settings)
    elif settings_status not in ("missing", "empty"):
        return
    drop_ledger_key(ledger_path, ledger, server)

try:
    main()
except Exception:
    pass
`;

/**
 * PowerShell 5.1 twin of {@link CLAUDE_APPA_PERMISSION_CLEANUP_PY}. Uses plain
 * JSON values to preserve arrays. Defined and called from the MCP arm only.
 */
const CLAUDE_APPA_PERMISSION_CLEANUP_PS = `function Remove-ArchClaudeAppaPermissions {
  function ConvertFrom-ArchClaudeJson([string]$Raw) {
    $parsed = $null
    $ok = $false
    try {
      if ($PSVersionTable.PSVersion.Major -ge 6) {
        $jsonParams = @{ InputObject = $Raw; AsHashtable = $true; Depth = 100; ErrorAction = 'Stop' }
        if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { $jsonParams.DateKind = 'String' }
        $parsed = ConvertFrom-Json @jsonParams
      } else {
        Add-Type -AssemblyName System.Web.Extensions -ErrorAction Stop
        $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
        $serializer.MaxJsonLength = 67108864
        $serializer.RecursionLimit = 256
        $parsed = $serializer.DeserializeObject($Raw)
      }
      if ($null -ne $parsed) { $ok = $true }
    } catch {
      $ok = $false
      $parsed = $null
    }
    return @{ Ok = $ok; Value = $parsed }
  }
  function ConvertTo-ArchClaudeStringArray($Value) {
    if ($null -eq $Value -or $Value -is [string] -or $Value -isnot [System.Collections.IList]) {
      return @{ Ok = $false; Items = @() }
    }
    $items = New-Object System.Collections.Generic.List[string]
    foreach ($item in @($Value)) {
      if ($item -isnot [string]) { return @{ Ok = $false; Items = @() } }
      [void]$items.Add($item)
    }
    return @{ Ok = $true; Items = $items.ToArray() }
  }
  function Find-ArchClaudeKey($Map, [string]$Wanted) {
    if ($Map -isnot [System.Collections.IDictionary]) { return $null }
    foreach ($key in @($Map.Keys)) {
      if ([string]$key -ceq $Wanted) { return [string]$key }
    }
    return $null
  }
  ${renderPowerShellJsonWriter("ConvertTo-ArchClaudeJson")}
  function Write-ArchClaudeJsonAtomic([string]$Path, $Value) {
    $json = [string](ConvertTo-ArchClaudeJson $Value)
    if (-not $json) { throw 'empty json' }
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
      New-Item -ItemType Directory -Path $dir | Out-Null
    }
    $tmp = $Path + '.' + [guid]::NewGuid().ToString('n') + '.tmp'
    try {
      $utf8 = New-Object System.Text.UTF8Encoding $false
      [IO.File]::WriteAllText($tmp, $json.TrimEnd() + [Environment]::NewLine, $utf8)
      Move-Item -LiteralPath $tmp -Destination $Path -Force
    } catch {
      if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
      throw
    }
  }
  $ErrorActionPreference = 'Stop'
  try {
    if (-not $env:USERPROFILE) { return }
    if ([string]::IsNullOrEmpty($McpServerName)) { return }
    $stateRoot = $env:USERPROFILE
    if ($env:CLAUDE_CONFIG_DIR) { $stateRoot = $env:CLAUDE_CONFIG_DIR }
    $ledgerPath = Join-Path (Join-Path $stateRoot '.archestra') 'claude-appa-permissions.json'
    if (-not (Test-Path -LiteralPath $ledgerPath)) { return }
    $ledgerRaw = Get-Content -Raw -LiteralPath $ledgerPath -Encoding UTF8
    if (-not ($ledgerRaw -and $ledgerRaw.Trim())) { return }
    $ledgerParsed = ConvertFrom-ArchClaudeJson $ledgerRaw
    if (-not $ledgerParsed.Ok) { return }
    $ledger = $ledgerParsed.Value
    if ($ledger -isnot [System.Collections.IDictionary]) { return }
    $matchedKey = Find-ArchClaudeKey $ledger $McpServerName
    if ($null -eq $matchedKey) { return }
    $ownedParsed = ConvertTo-ArchClaudeStringArray $ledger[$matchedKey]
    if (-not $ownedParsed.Ok) { return }
    $configDir = Join-Path $env:USERPROFILE '.claude'
    if ($env:CLAUDE_CONFIG_DIR) { $configDir = $env:CLAUDE_CONFIG_DIR }
    $settingsPath = Join-Path $configDir 'settings.json'
    if (Test-Path -LiteralPath $settingsPath) {
      $settingsRaw = Get-Content -Raw -LiteralPath $settingsPath -Encoding UTF8
      if ($settingsRaw -and $settingsRaw.Trim()) {
        $settingsParsed = ConvertFrom-ArchClaudeJson $settingsRaw
        if (-not $settingsParsed.Ok) { return }
        $settings = $settingsParsed.Value
        if ($settings -isnot [System.Collections.IDictionary]) { return }
        $permKey = Find-ArchClaudeKey $settings 'permissions'
        if ($null -ne $permKey -and $null -ne $settings[$permKey]) {
          $permissions = $settings[$permKey]
          if ($permissions -isnot [System.Collections.IDictionary]) { return }
          $allowKey = Find-ArchClaudeKey $permissions 'allow'
          if ($null -ne $allowKey -and $null -ne $permissions[$allowKey]) {
            $allowParsed = ConvertTo-ArchClaudeStringArray $permissions[$allowKey]
            if (-not $allowParsed.Ok) { return }
            $ownedSet = New-Object 'System.Collections.Generic.HashSet[string]'
            foreach ($rule in @($ownedParsed.Items)) { [void]$ownedSet.Add([string]$rule) }
            $kept = New-Object System.Collections.ArrayList
            $removed = 0
            foreach ($rule in @($allowParsed.Items)) {
              if ($ownedSet.Contains([string]$rule)) { $removed = $removed + 1 }
              else { [void]$kept.Add([string]$rule) }
            }
            if ($removed -gt 0) {
              # Index into a real array so a single remaining rule stays a JSON
              # array. A bare one-element list is unwrapped by Windows PowerShell 5.1.
              $allowValue = New-Object object[] $kept.Count
              for ($i = 0; $i -lt $kept.Count; $i++) { $allowValue[$i] = [string]$kept[$i] }
              $permissions[$allowKey] = $allowValue
              Write-ArchClaudeJsonAtomic $settingsPath $settings
            }
          }
        }
      }
    }
    $ledger.Remove($matchedKey) | Out-Null
    if (@($ledger.Keys).Count -eq 0) {
      Remove-Item -LiteralPath $ledgerPath -Force
    } else {
      Write-ArchClaudeJsonAtomic $ledgerPath $ledger
    }
  } catch { }
}`;

export const CLAUDE_CODE_GUARD_CLIENT: StartupGuardClient = {
  clientId: "claude-code",
  binary: "claude",
  label: "Claude Code",
  promptName: "Claude",
  disableEnvVar: "ARCHESTRA_CLAUDE_GUARD",
  ...STARTUP_GUARD_INSTALL["claude-code"],
  // Claude Code's non-interactive one-shot mode.
  nonInteractiveArgPatterns: ["-p", "--print"],
  utilitySubcommands: [
    "auth",
    "mcp",
    "plugin",
    "plugins",
    "install",
    "uninstall",
    "update",
    "upgrade",
    "doctor",
    "setup-token",
    "completion",
    "completions",
    "config",
    "login",
    "logout",
    "stop",
    "help",
  ],
  mcpDisconnectCommands: `      command claude mcp remove --scope user "$MCP_SERVER_NAME" </dev/null >/dev/null 2>&1 || true
      command claude mcp remove --scope local "$MCP_SERVER_NAME" </dev/null >/dev/null 2>&1 || true
      if command -v python3 >/dev/null 2>&1; then
        export MCP_SERVER_NAME
        command python3 -c ${sh(CLAUDE_APPA_PERMISSION_CLEANUP_PY)} >/dev/null 2>&1 || true
      fi`,
  skillsDisconnectCommands: `      printf '%s\n' "$PLUGIN_NAMES" | while IFS= read -r arch_plugin; do
        [ -n "$arch_plugin" ] || continue
        command claude plugin uninstall "$arch_plugin@$SKILLS_MARKETPLACE_NAME" </dev/null >/dev/null 2>&1 || true
      done
      command claude plugin marketplace remove "$SKILLS_MARKETPLACE_NAME" </dev/null >/dev/null 2>&1 || true`,
  skillsRefreshCommands: `  command claude plugin marketplace update "$arch_refresh_marketplace" </dev/null >/dev/null 2>&1 || return 1
  printf '%s\n' "$arch_refresh_plugin_names" | while IFS= read -r arch_plugin; do
    [ -n "$arch_plugin" ] || continue
    command claude plugin update -y "$arch_plugin@$arch_refresh_marketplace" </dev/null >/dev/null 2>&1 || exit 1
  done || return 1`,
  // Connect registers the gateway at user scope, which lives in
  // `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`) under `mcpServers`;
  // marketplaces are indexed in `plugins/known_marketplaces.json` by name. A
  // local-scope entry the user added themselves is deliberately not checked.
  mcpDisconnectVerify: jsonMemberGoneVerify({
    configPath: '"${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json"',
    member: "mcpServers",
    nameVar: "$MCP_SERVER_NAME",
    manualCommand: "claude mcp remove --scope user",
  }),
  skillsDisconnectVerify: jsonMemberGoneVerify({
    configPath:
      '"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/known_marketplaces.json"',
    member: "",
    nameVar: "$SKILLS_MARKETPLACE_NAME",
    manualCommand: "claude plugin marketplace remove",
  }),
  renderProxyDisconnect: claudeProxyDisconnect,
  windows: {
    mcpDisconnect: `      if ($archRealExe) {
        try { & $archRealExe.Source mcp remove --scope user $McpServerName 2>$null | Out-Null } catch { }
        try { & $archRealExe.Source mcp remove --scope local $McpServerName 2>$null | Out-Null } catch { }
      }
${CLAUDE_APPA_PERMISSION_CLEANUP_PS}
      try { Remove-ArchClaudeAppaPermissions } catch { }`,
    skillsDisconnect: `      if ($archRealExe) {
        foreach ($archPlugin in $PluginNames) {
          try { & $archRealExe.Source plugin uninstall ($archPlugin + '@' + $SkillsMarketplaceName) 2>$null | Out-Null } catch { }
        }
        try { & $archRealExe.Source plugin marketplace remove $SkillsMarketplaceName 2>$null | Out-Null } catch { }
      }`,
    skillsRefreshCommands: `  & $archRefreshReal.Source plugin marketplace update $ArchRefreshMarketplace 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { return $false }
  foreach ($archPlugin in $ArchRefreshPluginNames) {
    & $archRefreshReal.Source plugin update -y ($archPlugin + '@' + $ArchRefreshMarketplace) 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { return $false }
  }`,
    mcpDisconnectVerify: windowsJsonMemberGoneVerify({
      configPath:
        "Join-Path $(if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { $env:USERPROFILE }) '.claude.json'",
      member: "mcpServers",
      nameVar: "$McpServerName",
      manualCommand: "claude mcp remove --scope user",
    }),
    skillsDisconnectVerify: windowsJsonMemberGoneVerify({
      configPath:
        "Join-Path $(if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.claude' }) 'plugins\\known_marketplaces.json'",
      member: "",
      nameVar: "$SkillsMarketplaceName",
      manualCommand: "claude plugin marketplace remove",
    }),
    renderProxyDisconnect: claudeWindowsProxyDisconnect,
    proxyDisconnectNote: (ctx) =>
      ctx.proxy?.provider === "bedrock"
        ? "If you set AWS_BEARER_TOKEN_BEDROCK in your environment, remove it there too."
        : "",
  },
};

/**
 * Claude Code's proxy disconnect: strip exactly the env keys connect set (per
 * provider, from the shared {@link CLAUDE_CODE_PROXY_ENV_KEYS} list) from
 * ~/.claude/settings.json, keeping the user's own custom-header lines. Falls
 * back to printed manual steps when python3 is missing, mirroring the connect
 * script's merge fallback.
 */
function claudeProxyDisconnect(ctx: StartupGuardContext): string {
  const provider = ctx.proxy?.provider === "bedrock" ? "bedrock" : "anthropic";
  const envKeys = CLAUDE_CODE_PROXY_ENV_KEYS[provider];
  const ourHeaderNames = [EXTERNAL_AGENT_ID_HEADER, VIRTUAL_KEY_HEADER]
    .map((name) => `"${name.toLowerCase()}"`)
    .join(", ");
  const bedrockNote =
    provider === "bedrock"
      ? `
  line_reset
  printf '%s  If you exported AWS_BEARER_TOKEN_BEDROCK in your shell profile, remove it there too.%s\\n' "$C_DIM" "$C_RESET"`
      : "";

  const strippedKeysList = envKeys.map((key) => `"${key}"`).join(", ");

  return `disconnect_proxy() {
  command -v python3 >/dev/null 2>&1 || return 0
  python3 - <<'ARCHESTRA_GUARD_PY'
import json, os, pathlib
path = pathlib.Path(os.path.expanduser("~/.claude/settings.json"))
if not path.exists():
    raise SystemExit(0)
raw = path.read_text().strip()
if not raw:
    raise SystemExit(0)
settings = json.loads(raw)
env = settings.get("env")
if not isinstance(env, dict):
    raise SystemExit(0)
backup = path.with_name(path.name + ".archestra-guard-backup")
if not backup.exists():
    backup.write_text(json.dumps(settings, indent=2) + "\\n")
for key in [${strippedKeysList}]:
    env.pop(key, None)
# Drop only our header lines; the user's other custom headers survive.
ours = {${ourHeaderNames}}
existing = env.get("${CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY}", "") or ""
lines = [
    ln for ln in existing.splitlines()
    if ln.strip() and ln.split(":", 1)[0].strip().lower() not in ours
]
if lines:
    env["${CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY}"] = "\\n".join(lines)
else:
    env.pop("${CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY}", None)
if not env:
    settings.pop("env", None)
path.write_text(json.dumps(settings, indent=2) + "\\n")
ARCHESTRA_GUARD_PY
}

# Printed after the Disconnected line — the strip itself runs silenced in
# the background while the spinner plays.
proxy_disconnect_notes() {
  if ! command -v python3 >/dev/null 2>&1; then
    line_reset
    printf '%s  python3 not found — remove these keys from the env block of ~/.claude/settings.json manually: ${envKeys.join(", ")} (and our lines in ${CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY}).%s\\n' "$C_WARN" "$C_RESET"
  fi${bedrockNote}
  return 0
}`;
}

/**
 * Claude Code's proxy disconnect on Windows: strip exactly the env keys connect
 * set (per provider, from {@link CLAUDE_CODE_PROXY_ENV_KEYS}) from
 * ~/.claude/settings.json, keeping the user's own custom-header lines and taking
 * a one-time backup. Pure PowerShell — no python dependency on Windows.
 */
function claudeWindowsProxyDisconnect(ctx: StartupGuardContext): string {
  // Claude Code's proxy providers are only anthropic/bedrock; the guard context
  // carries the widened SupportedProvider, so narrow back for the key list.
  const provider = ctx.proxy?.provider === "bedrock" ? "bedrock" : "anthropic";
  const envKeys = CLAUDE_CODE_PROXY_ENV_KEYS[provider];
  const keysArray = envKeys.map((key) => psq(key)).join(", ");
  const oursArray = [EXTERNAL_AGENT_ID_HEADER, VIRTUAL_KEY_HEADER]
    .map((name) => psq(name.toLowerCase()))
    .join(", ");

  return `function Disconnect-ArchProxy {
  $path = Join-Path $env:USERPROFILE '.claude/settings.json'
  if (-not (Test-Path $path)) { return }
  $raw = Get-Content -Raw -Path $path
  if (-not ($raw -and $raw.Trim())) { return }
  try { $settings = $raw | ConvertFrom-Json } catch { return }
  if (-not $settings.PSObject.Properties['env']) { return }
  $backup = $path + '.archestra-guard-backup'
  if (-not (Test-Path $backup)) { Set-Content -Path $backup -Value $raw }
  $envBlock = $settings.env
  foreach ($k in @(${keysArray})) { $envBlock.PSObject.Properties.Remove($k) }
  # Drop only our header lines; the user's other custom headers survive.
  $ours = @(${oursArray})
  $existing = ''
  if ($envBlock.PSObject.Properties['${CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY}']) { $existing = [string]$envBlock.${CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY} }
  $kept = @()
  foreach ($ln in ($existing -split "\`r?\`n")) {
    if ($ln.Trim() -and ($ours -notcontains ($ln -split ':', 2)[0].Trim().ToLower())) { $kept += $ln }
  }
  if ($kept.Count -gt 0) {
    $joined = ($kept -join "\`n")
    if ($envBlock.PSObject.Properties['${CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY}']) { $envBlock.${CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY} = $joined }
  } else {
    $envBlock.PSObject.Properties.Remove('${CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY}')
  }
  if (@($envBlock.PSObject.Properties).Count -eq 0) { $settings.PSObject.Properties.Remove('env') }
  $settings | ConvertTo-Json -Depth 32 | Set-Content -Path $path -Encoding utf8
}`;
}
