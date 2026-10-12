import {
  ALL_ARCHESTRA_TOKEN_PREFIXES,
  CLAUDE_CODE_CLIENT_ID,
  CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY,
  CLAUDE_CODE_PROXY_ENV_KEYS,
  EXTERNAL_AGENT_ID_HEADER,
  VIRTUAL_KEY_HEADER,
} from "@archestra/shared";
import {
  REQUIRED_OPENAPPA_TOOL_SHORT_NAMES,
  TOOL_ASK_USER_SHORT_NAME,
} from "@archestra/shared/archestra-mcp-server";
import { CLAUDE_CODE_GUARD_CLIENT } from "../guard/clients";
import { starterPrompt } from "../steps/ending";
import {
  mergeJsonFileBash,
  mergeJsonFilePowerShell,
} from "../steps/json-merge";
import { legacyServerNames } from "../steps/mcp";
import { renderPowerShellJsonWriter } from "../steps/powershell-json";
import { psq, sh } from "../steps/quoting";
import {
  withStartupGuardBash,
  withStartupGuardPowerShell,
} from "../steps/startup-guard";
import type {
  AgentEnding,
  SetupScriptContext,
  SetupScriptMcpSection,
  SetupScriptProxySection,
  ShellAgentSetup,
} from "../types";

// Claude Code setup. Bash and PowerShell versions of each step sit side by side,
// grouped by feature: MCP gateway helper permissions, LLM proxy, skills
// marketplace. Each language's section list and next steps follow, then the
// agent module the dispatcher in ../index.ts uses.

// One shared source for the proxy env keys connect writes into
// ~/.claude/settings.json — the Disconnect panel and the startup guard strip
// exactly the same lists.
const [ANTHROPIC_BASE_URL_KEY, ANTHROPIC_AUTH_TOKEN_KEY] =
  CLAUDE_CODE_PROXY_ENV_KEYS.anthropic;

const [
  CLAUDE_USE_BEDROCK_KEY,
  AWS_REGION_KEY,
  BEDROCK_BASE_URL_KEY,
  AWS_BEARER_TOKEN_KEY,
] = CLAUDE_CODE_PROXY_ENV_KEYS.bedrock;

/**
 * Claude Code's post-install OAuth step, shared by the bash and PowerShell
 * renderers. Registering the gateway is not enough: it authorizes each user
 * individually, so its tools unlock only after a one-time browser sign-in.
 * The running session never picks the server up — only a new one reads the
 * updated config — so the step must send the user to a NEW session; naming
 * `/mcp` alone strands them in a session where the gateway does not exist.
 */
/** @public — asserted by the setup script unit tests, which knip --production ignores. */
export const CLAUDE_APPA_PERMISSIONS_SKIPPED_WARNING =
  "Skipped Claude Code helper allow rules. The gateway name or tool prefix cannot be used in an exact permission rule. MCP setup continues without pre-approving those calls.";

/**
 * True when both names can be embedded as exact Claude allow rules.
 *
 * @public — asserted by the setup script unit tests, which knip --production ignores.
 */
export function claudeCodeAppaPermissionsAreLiteral(
  mcp: SetupScriptMcpSection,
): boolean {
  return (
    /^[a-zA-Z0-9_.-]+$/.test(mcp.serverName) &&
    /^[a-zA-Z0-9_]+__$/.test(mcp.toolPrefix)
  );
}

/** @public — asserted by the setup script unit tests, which knip --production ignores. */
export function claudeCodeAppaPermissionRules(
  mcp: SetupScriptMcpSection,
): string[] {
  if (!claudeCodeAppaPermissionsAreLiteral(mcp)) {
    throw new Error(
      "Claude MCP permission rules require literal server and tool names",
    );
  }
  return [...REQUIRED_OPENAPPA_TOOL_SHORT_NAMES, TOOL_ASK_USER_SHORT_NAME].map(
    (name) => `mcp__${mcp.serverName}__${mcp.toolPrefix}${name}`,
  );
}

// Runs before the gateway is registered so a missing interpreter leaves the client untouched.
function claudeAppaPermissionsPreflightBash(
  mcp: SetupScriptMcpSection,
): string | null {
  if (!claudeCodeAppaPermissionsAreLiteral(mcp)) return null;
  return `if ! command -v python3 >/dev/null 2>&1; then
  err 'python3 is required to configure Claude Code APPA tool permissions. Install it and re-run connection setup.'
  exit 1
fi`;
}

function claudeAppaPermissionsBash(mcp: SetupScriptMcpSection): string {
  if (!claudeCodeAppaPermissionsAreLiteral(mcp)) {
    return `warn ${sh(CLAUDE_APPA_PERMISSIONS_SKIPPED_WARNING)}`;
  }
  return `say 'Allowing the guardrail (APPA) helpers in Claude Code'
ARCHESTRA_MCP_NAME=${sh(mcp.serverName)} \\
ARCHESTRA_MCP_LEGACY_NAMES=${sh(JSON.stringify(legacyServerNames(mcp)))} \\
ARCHESTRA_APPA_PERMISSION_RULES=${sh(JSON.stringify(claudeCodeAppaPermissionRules(mcp)))} \\
python3 - <<'ARCHESTRA_APPA_PERMISSIONS_PY'
${CLAUDE_APPA_PERMISSIONS_MERGE_PY}
ARCHESTRA_APPA_PERMISSIONS_PY
ok 'Claude Code can call the guardrail helpers without asking each time. Gateway sign-in and required human reviews still apply.'`;
}

const CLAUDE_APPA_PERMISSIONS_MERGE_PY = `import json, os, pathlib, shutil
home = pathlib.Path.home()
path = pathlib.Path(os.environ.get("CLAUDE_CONFIG_DIR") or home / ".claude") / "settings.json"
state_root = pathlib.Path(os.environ["CLAUDE_CONFIG_DIR"]) if os.environ.get("CLAUDE_CONFIG_DIR") else home
state_path = state_root / ".archestra" / "claude-appa-permissions.json"
settings_raw = path.read_text() if path.exists() else ""
settings = json.loads(settings_raw) if settings_raw.strip() else {}
state = json.loads(state_path.read_text()) if state_path.exists() else {}
if not isinstance(settings, dict) or not isinstance(state, dict):
    raise ValueError("Claude settings and APPA permission state must be JSON objects")
permissions = settings.setdefault("permissions", {})
if not isinstance(permissions, dict):
    raise ValueError(f"Claude permissions must be a JSON object in {path}")
allowed = permissions.get("allow", [])
if not isinstance(allowed, list) or not all(isinstance(rule, str) for rule in allowed):
    raise ValueError(f"Claude permissions.allow must be an array of strings in {path}")
for owned in state.values():
    if not isinstance(owned, list) or not all(isinstance(rule, str) for rule in owned):
        raise ValueError("Invalid APPA permission ownership state")
server = os.environ["ARCHESTRA_MCP_NAME"]
desired = json.loads(os.environ["ARCHESTRA_APPA_PERMISSION_RULES"])
names = [server] + json.loads(os.environ["ARCHESTRA_MCP_LEGACY_NAMES"])
previously_owned = {rule for name in names for rule in state.pop(name, [])}
allowed = [rule for rule in allowed if rule not in previously_owned or rule in desired]
owned = [rule for rule in desired if rule in previously_owned or rule not in allowed]
for rule in desired:
    if rule not in allowed:
        allowed.append(rule)
permissions["allow"] = allowed
if owned:
    state[server] = owned
path.parent.mkdir(parents=True, exist_ok=True)
state_path.parent.mkdir(parents=True, exist_ok=True)
backup = path.with_name(path.name + ".archestra-backup")
if path.exists() and not backup.exists():
    shutil.copy2(path, backup)
# Record ownership first so a failed settings write remains recoverable.
state_path.write_text(json.dumps(state, indent=2) + "\\n")
path.write_text(json.dumps(settings, indent=2) + "\\n")
print(f"Updated {path}")`;

/**
 * MCP connect allowlists the four APPA helpers in Claude Code settings, with
 * or without a proxy. Ownership lives in ~/.archestra/claude-appa-permissions.json,
 * or CLAUDE_CONFIG_DIR/.archestra when that profile is selected, and only covers
 * rules this installer added. Invalid JSON or types abort
 * before any write. JSON uses ConvertFrom-Json -AsHashtable on PowerShell 6+
 * and JavaScriptSerializer on Windows PowerShell 5.1, so one-element arrays
 * stay arrays.
 */
function claudeAppaPermissionsPowerShell(mcp: SetupScriptMcpSection): string {
  if (!claudeCodeAppaPermissionsAreLiteral(mcp)) {
    return `# >>> archestra:claude-appa-permissions >>>
Warn ${psq(CLAUDE_APPA_PERMISSIONS_SKIPPED_WARNING)}
# <<< archestra:claude-appa-permissions <<<`;
  }
  const rulesJson = JSON.stringify(claudeCodeAppaPermissionRules(mcp));
  const legacyJson = JSON.stringify(legacyServerNames(mcp));
  return `# >>> archestra:claude-appa-permissions >>>
Say 'Allowing the guardrail (APPA) helpers in Claude Code'
${claudeAppaPermissionsSnippet({ serverName: mcp.serverName, rulesJson, legacyJson })}
Write-Host ('Updated ' + $archAppaSettingsPath)
Ok 'Claude Code can call the guardrail helpers without asking each time. Gateway sign-in and required human reviews still apply.'
# <<< archestra:claude-appa-permissions <<<`;
}

function claudeAppaPermissionsSnippet(params: {
  serverName: string;
  rulesJson: string;
  legacyJson: string;
}): string {
  const { serverName, rulesJson, legacyJson } = params;
  return `$archAppaServer = ${psq(serverName)}
$archAppaDesiredJson = ${psq(rulesJson)}
$archAppaLegacyJson = ${psq(legacyJson)}
function New-ArchAppaObject {
  return ,(New-Object System.Collections.Hashtable ([StringComparer]::Ordinal))
}
function ConvertFrom-ArchAppaJson([string]$Raw) {
  if ($PSVersionTable.PSVersion.Major -ge 6) {
    $archAppaParse = @{ InputObject = $Raw; AsHashtable = $true; Depth = 100; ErrorAction = 'Stop' }
    $archAppaParameters = (Get-Command ConvertFrom-Json).Parameters
    if ($archAppaParameters.ContainsKey('NoEnumerate')) { $archAppaParse['NoEnumerate'] = $true }
    if ($archAppaParameters.ContainsKey('DateKind')) { $archAppaParse['DateKind'] = 'String' }
    $archAppaParsed = ConvertFrom-Json @archAppaParse
    if (-not $archAppaParse.ContainsKey('NoEnumerate') -and $Raw.TrimStart().StartsWith('[')) {
      if ($Raw -match '^\\[\\s*\\]$') { return ,(New-Object object[] 0) }
      return ,@($archAppaParsed)
    }
    return ,$archAppaParsed
  }
  Add-Type -AssemblyName System.Web.Extensions -ErrorAction Stop
  $archAppaSerializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
  $archAppaSerializer.MaxJsonLength = 67108864
  $archAppaSerializer.RecursionLimit = 256
  return ,($archAppaSerializer.DeserializeObject($Raw))
}
${renderPowerShellJsonWriter("ConvertTo-ArchAppaJson")}
function Test-ArchAppaObject($Value) { return $Value -is [System.Collections.IDictionary] }
function Test-ArchAppaStringList($Value) {
  if ($null -eq $Value -or $Value -is [string] -or $Value -is [System.Collections.IDictionary]) { return $false }
  if ($Value -isnot [System.Collections.IList]) { return $false }
  foreach ($item in @($Value)) { if ($item -isnot [string]) { return $false } }
  return $true
}
function ConvertTo-ArchAppaExactArray($Items) {
  $archAppaItems = @($Items)
  $archAppaArray = New-Object object[] $archAppaItems.Count
  for ($archAppaIndex = 0; $archAppaIndex -lt $archAppaItems.Count; $archAppaIndex++) { $archAppaArray[$archAppaIndex] = $archAppaItems[$archAppaIndex] }
  return ,$archAppaArray
}
function Find-ArchAppaKey($Map, [string]$Wanted) {
  if ($Map -isnot [System.Collections.IDictionary]) { return $null }
  foreach ($key in @($Map.Keys)) { if ([string]$key -ceq $Wanted) { return [string]$key } }
  return $null
}
function Read-ArchAppaJsonFile([string]$Path, [bool]$MissingIsEmpty, [bool]$BlankIsEmpty) {
  if (-not (Test-Path -LiteralPath $Path)) {
    if ($MissingIsEmpty) { return ,(New-ArchAppaObject) }
    throw 'invalid JSON'
  }
  $text = [System.IO.File]::ReadAllText($Path)
  if ($text.Length -gt 0 -and [int][char]$text[0] -eq 65279) { $text = $text.Substring(1) }
  if ([string]::IsNullOrWhiteSpace($text)) {
    if ($BlankIsEmpty) { return ,(New-ArchAppaObject) }
    throw 'invalid JSON'
  }
  return ,(ConvertFrom-ArchAppaJson $text)
}
function Write-ArchAppaJsonAtomic([string]$Path, [string]$Json) {
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $tmp = $Path + '.' + [guid]::NewGuid().ToString('n') + '.tmp'
  $utf8 = New-Object System.Text.UTF8Encoding $false
  try {
    [System.IO.File]::WriteAllText($tmp, $Json.TrimEnd() + [Environment]::NewLine, $utf8)
    Move-Item -LiteralPath $tmp -Destination $Path -Force
  } catch {
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
    throw
  }
}
if ([string]::IsNullOrEmpty($env:USERPROFILE)) { throw 'USERPROFILE is not set' }
if ([string]::IsNullOrEmpty($env:CLAUDE_CONFIG_DIR)) {
  $archAppaConfigDir = Join-Path $env:USERPROFILE '.claude'
  $archAppaStateRoot = $env:USERPROFILE
} else {
  $archAppaConfigDir = $env:CLAUDE_CONFIG_DIR
  $archAppaStateRoot = $env:CLAUDE_CONFIG_DIR
}
$archAppaSettingsPath = Join-Path $archAppaConfigDir 'settings.json'
$archAppaStatePath = Join-Path (Join-Path $archAppaStateRoot '.archestra') 'claude-appa-permissions.json'
$archAppaDesired = ConvertFrom-ArchAppaJson $archAppaDesiredJson
$archAppaLegacy = ConvertFrom-ArchAppaJson $archAppaLegacyJson
if (-not (Test-ArchAppaStringList $archAppaDesired) -or -not (Test-ArchAppaStringList $archAppaLegacy)) { throw 'invalid JSON' }
try { $archAppaSettings = Read-ArchAppaJsonFile $archAppaSettingsPath $true $true } catch { throw 'Claude settings and APPA permission state must be JSON objects' }
try { $archAppaState = Read-ArchAppaJsonFile $archAppaStatePath $true $false } catch { throw 'Claude settings and APPA permission state must be JSON objects' }
if (-not (Test-ArchAppaObject $archAppaSettings) -or -not (Test-ArchAppaObject $archAppaState)) { throw 'Claude settings and APPA permission state must be JSON objects' }
foreach ($archAppaKey in @($archAppaState.Keys)) {
  if (-not (Test-ArchAppaStringList $archAppaState[$archAppaKey])) { throw 'Invalid APPA permission ownership state' }
}
$archAppaPermKey = Find-ArchAppaKey $archAppaSettings 'permissions'
if ($null -eq $archAppaPermKey) {
  $archAppaPermissions = New-ArchAppaObject
  $archAppaSettings['permissions'] = $archAppaPermissions
  $archAppaPermKey = 'permissions'
} else {
  $archAppaPermissions = $archAppaSettings[$archAppaPermKey]
  if (-not (Test-ArchAppaObject $archAppaPermissions)) { throw 'Claude permissions must be a JSON object' }
}
$archAppaAllowKey = Find-ArchAppaKey $archAppaPermissions 'allow'
if ($null -eq $archAppaAllowKey) {
  $archAppaAllowed = New-Object object[] 0
  $archAppaAllowKey = 'allow'
} else {
  $archAppaAllowed = $archAppaPermissions[$archAppaAllowKey]
  if (-not (Test-ArchAppaStringList $archAppaAllowed)) { throw 'Claude permissions.allow must be an array of strings' }
}
$archAppaNames = New-Object System.Collections.Generic.List[string]
[void]$archAppaNames.Add($archAppaServer)
foreach ($archAppaLegacyName in $archAppaLegacy) { [void]$archAppaNames.Add([string]$archAppaLegacyName) }
$archAppaPrevious = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($archAppaName in $archAppaNames) {
  $archAppaMatched = Find-ArchAppaKey $archAppaState ([string]$archAppaName)
  if ($null -ne $archAppaMatched) {
    foreach ($archAppaRule in @($archAppaState[$archAppaMatched])) { [void]$archAppaPrevious.Add([string]$archAppaRule) }
    [void]$archAppaState.Remove($archAppaMatched)
  }
}
$archAppaDesiredSet = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($archAppaRule in $archAppaDesired) { [void]$archAppaDesiredSet.Add([string]$archAppaRule) }
$archAppaFiltered = New-Object System.Collections.ArrayList
foreach ($archAppaRule in @($archAppaAllowed)) {
  if ((-not $archAppaPrevious.Contains([string]$archAppaRule)) -or $archAppaDesiredSet.Contains([string]$archAppaRule)) {
    [void]$archAppaFiltered.Add($archAppaRule)
  }
}
$archAppaFilteredSet = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($archAppaRule in $archAppaFiltered) { [void]$archAppaFilteredSet.Add([string]$archAppaRule) }
$archAppaOwned = New-Object System.Collections.ArrayList
foreach ($archAppaRule in $archAppaDesired) {
  if ($archAppaPrevious.Contains([string]$archAppaRule) -or -not $archAppaFilteredSet.Contains([string]$archAppaRule)) {
    [void]$archAppaOwned.Add([string]$archAppaRule)
  }
}
foreach ($archAppaRule in $archAppaDesired) {
  if (-not $archAppaFilteredSet.Contains([string]$archAppaRule)) {
    [void]$archAppaFiltered.Add([string]$archAppaRule)
    [void]$archAppaFilteredSet.Add([string]$archAppaRule)
  }
}
$archAppaPermissions[$archAppaAllowKey] = ConvertTo-ArchAppaExactArray $archAppaFiltered
if ($archAppaOwned.Count -gt 0) { $archAppaState[$archAppaServer] = ConvertTo-ArchAppaExactArray $archAppaOwned }
$archAppaSettingsJson = [string](ConvertTo-ArchAppaJson $archAppaSettings)
$archAppaStateJson = [string](ConvertTo-ArchAppaJson $archAppaState)
if (-not $archAppaSettingsJson -or -not $archAppaStateJson) { throw 'empty json' }
$archAppaBackup = $archAppaSettingsPath + '.archestra-backup'
if ((Test-Path -LiteralPath $archAppaSettingsPath) -and -not (Test-Path -LiteralPath $archAppaBackup)) {
  Copy-Item -LiteralPath $archAppaSettingsPath -Destination $archAppaBackup
}
# Record ownership first so a failed settings write remains recoverable.
Write-ArchAppaJsonAtomic $archAppaStatePath $archAppaStateJson
Write-ArchAppaJsonAtomic $archAppaSettingsPath $archAppaSettingsJson`;
}

const CLAUDE_SETTINGS_MERGE_PY = `import json, os, pathlib
path = pathlib.Path(os.path.expanduser("~/.claude/settings.json"))
settings = {}
if path.exists():
    raw = path.read_text().strip()
    if raw:
        settings = json.loads(raw)
env = settings.setdefault("env", {})
for key in os.environ.get("ARCHESTRA_REMOVE_VIRTUAL_KEY_ENV", "").split(","):
    value = env.get(key)
    if isinstance(value, str) and any(value.startswith(prefix) for prefix in ${JSON.stringify(ALL_ARCHESTRA_TOKEN_PREFIXES)}):
        env.pop(key)
for key in os.environ:
    if key.startswith("ARCHESTRA_SET_ENV_"):
        env[key.removeprefix("ARCHESTRA_SET_ENV_")] = os.environ[key]
# Replace both attribution headers so switching auth modes also removes a
# passthrough key that the new configuration no longer uses.
append_headers = os.environ.get("ARCHESTRA_APPEND_${CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY}")
if append_headers:
    # strip each line: the script's env-assignment block is indented, which
    # indents the continuation lines of this multi-line value too.
    new_lines = [ln.strip() for ln in append_headers.splitlines() if ln.strip()]
    managed_names = {"${EXTERNAL_AGENT_ID_HEADER.toLowerCase()}", "${VIRTUAL_KEY_HEADER.toLowerCase()}"}
    existing = env.get("${CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY}", "") or ""
    lines = [
        ln for ln in existing.splitlines()
        if ln.strip() and ln.split(":", 1)[0].strip().lower() not in managed_names
    ]
    lines.extend(new_lines)
    env["${CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY}"] = "\\n".join(lines)
path.write_text(json.dumps(settings, indent=2) + "\\n")
print(f"Updated {path}")`;

/**
 * Custom headers Claude Code sends on every proxied request (Anthropic and
 * Bedrock alike — ANTHROPIC_CUSTOM_HEADERS applies to both), one "Name: Value"
 * per line:
 *  - X-Archestra-Agent-Id attributes the request to the Claude Code client.
 *  - X-Archestra-Virtual-Key (passthrough) attributes it to the user.
 */
function claudeCustomHeaders(proxy: SetupScriptProxySection): string {
  const headerLines = [`${EXTERNAL_AGENT_ID_HEADER}: ${CLAUDE_CODE_CLIENT_ID}`];
  if (proxy.passthroughVirtualKey) {
    headerLines.push(`${VIRTUAL_KEY_HEADER}: ${proxy.passthroughVirtualKey}`);
  }
  return headerLines.join("\n");
}

function claudeAnthropicProxyBash(proxy: SetupScriptProxySection): string {
  const removeVirtualKeyEnv = proxy.virtualKey
    ? ["ANTHROPIC_API_KEY"]
    : [ANTHROPIC_AUTH_TOKEN_KEY, "ANTHROPIC_API_KEY"];
  const env: Record<string, string> = {
    [`ARCHESTRA_SET_ENV_${ANTHROPIC_BASE_URL_KEY}`]: proxy.url,
    ARCHESTRA_REMOVE_VIRTUAL_KEY_ENV: removeVirtualKeyEnv.join(","),
  };
  const manualEnv: Record<string, string> = {
    [ANTHROPIC_BASE_URL_KEY]: proxy.url,
  };
  if (proxy.virtualKey) {
    env[`ARCHESTRA_SET_ENV_${ANTHROPIC_AUTH_TOKEN_KEY}`] = proxy.virtualKey;
    manualEnv[ANTHROPIC_AUTH_TOKEN_KEY] = proxy.virtualKey;
  }
  const customHeaders = claudeCustomHeaders(proxy);
  env[`ARCHESTRA_APPEND_${CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY}`] = customHeaders;
  manualEnv[CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY] = customHeaders;
  const passthroughNote = proxy.virtualKey
    ? ""
    : `
echo "Your existing ${proxy.providerLabel} credentials keep working — only the base URL changed."`;

  return `say ${sh(`Routing Claude Code through the ${proxy.providerLabel} proxy`)}
${mergeJsonFileBash({
  file: "$HOME/.claude/settings.json",
  env,
  python: CLAUDE_SETTINGS_MERGE_PY,
  fallbackMessage: claudeManualMergeMessage(removeVirtualKeyEnv),
  fallbackSnippet: JSON.stringify({ env: manualEnv }, null, 2),
})}${passthroughNote}`;
}

function claudeBedrockProxyBash(proxy: SetupScriptProxySection): string {
  const removeVirtualKeyEnv = proxy.virtualKey ? [] : [AWS_BEARER_TOKEN_KEY];
  const customHeaders = claudeCustomHeaders(proxy);
  const env: Record<string, string> = {
    [`ARCHESTRA_SET_ENV_${CLAUDE_USE_BEDROCK_KEY}`]: "1",
    [`ARCHESTRA_SET_ENV_${AWS_REGION_KEY}`]: "us-east-1",
    [`ARCHESTRA_SET_ENV_${BEDROCK_BASE_URL_KEY}`]: proxy.url,
    ARCHESTRA_REMOVE_VIRTUAL_KEY_ENV: removeVirtualKeyEnv.join(","),
  };
  const manualEnv: Record<string, string> = {
    [CLAUDE_USE_BEDROCK_KEY]: "1",
    [AWS_REGION_KEY]: "us-east-1",
    [BEDROCK_BASE_URL_KEY]: proxy.url,
  };
  if (proxy.virtualKey) {
    // The virtual key authenticates against the proxy as a Bedrock bearer
    // token. Merged into settings.json env exactly like ANTHROPIC_AUTH_TOKEN
    // on the Anthropic path, so the setup needs no manual paste step.
    env[`ARCHESTRA_SET_ENV_${AWS_BEARER_TOKEN_KEY}`] = proxy.virtualKey;
    manualEnv[AWS_BEARER_TOKEN_KEY] = proxy.virtualKey;
  }
  env[`ARCHESTRA_APPEND_${CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY}`] = customHeaders;
  manualEnv[CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY] = customHeaders;

  return `say ${sh("Routing Claude Code through the Bedrock proxy")}
${mergeJsonFileBash({
  file: "$HOME/.claude/settings.json",
  env,
  python: CLAUDE_SETTINGS_MERGE_PY,
  fallbackMessage: claudeManualMergeMessage(removeVirtualKeyEnv),
  fallbackSnippet: JSON.stringify({ env: manualEnv }, null, 2),
})}
echo "Update AWS_REGION in ~/.claude/settings.json if you use a different region."${
    proxy.virtualKey
      ? ""
      : `
echo "Your existing AWS credentials keep working — only the base URL changed."`
  }`;
}

function claudeManualMergeMessage(removeVirtualKeyEnv: string[]): string {
  const credentialCleanup = removeVirtualKeyEnv.length
    ? ` Remove ${removeVirtualKeyEnv.join(" and ")} from env if their values start with ${ALL_ARCHESTRA_TOKEN_PREFIXES.join(" or ")}; keep your provider credentials.`
    : "";
  return `python3 not found — remove existing ${EXTERNAL_AGENT_ID_HEADER.toLowerCase()} and ${VIRTUAL_KEY_HEADER.toLowerCase()} lines from env.${CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY}.${credentialCleanup} Then merge this into ~/.claude/settings.json manually:`;
}

const CLAUDE_SETTINGS_PATH =
  "(Join-Path $env:USERPROFILE '.claude\\settings.json')";

/**
 * Custom headers Claude Code sends on every proxied request (Anthropic and
 * Bedrock alike — ANTHROPIC_CUSTOM_HEADERS applies to both), one "Name: Value"
 * per line: X-Archestra-Agent-Id (Claude Code attribution, always) and the
 * X-Archestra-Virtual-Key passthrough header (user attribution, when present).
 */
function claudeCustomHeaderLines(proxy: SetupScriptProxySection): string[] {
  const headerLines = [`${EXTERNAL_AGENT_ID_HEADER}: ${CLAUDE_CODE_CLIENT_ID}`];
  if (proxy.passthroughVirtualKey) {
    headerLines.push(`${VIRTUAL_KEY_HEADER}: ${proxy.passthroughVirtualKey}`);
  }
  return headerLines;
}

function claudeAnthropicProxyPowerShell(
  proxy: SetupScriptProxySection,
): string {
  const values: Record<string, string> = {
    [ANTHROPIC_BASE_URL_KEY]: proxy.url,
  };
  if (proxy.virtualKey) {
    values[ANTHROPIC_AUTH_TOKEN_KEY] = proxy.virtualKey;
  }
  // Append our custom headers after the base-URL merge, preserving any the user
  // already set.
  const headerAppend = `\n${claudeCustomHeaderAppendSnippet(claudeCustomHeaderLines(proxy))}`;
  const passthroughNote = proxy.virtualKey
    ? ""
    : `
Write-Host ${psq(`Your existing ${proxy.providerLabel} credentials keep working — only the base URL changed.`)}`;

  return `Say ${psq(`Routing Claude Code through the ${proxy.providerLabel} proxy`)}
${mergeJsonFilePowerShell({
  pathExpr: CLAUDE_SETTINGS_PATH,
  nestedKey: "env",
  values,
  removeManagedTokenKeys: proxy.virtualKey
    ? ["ANTHROPIC_API_KEY"]
    : [ANTHROPIC_AUTH_TOKEN_KEY, "ANTHROPIC_API_KEY"],
})}${headerAppend}${passthroughNote}`;
}

/**
 * Append-merge our headers into env.ANTHROPIC_CUSTOM_HEADERS in settings.json:
 * keep the user's other headers, replace only our lines (matched
 * case-insensitively by header name) so re-runs / key rotation never duplicate
 * or leave a stale token. Runs right after the base-URL merge created the file,
 * so it neither re-creates the dir nor re-takes the backup.
 */
function claudeCustomHeaderAppendSnippet(headerLines: string[]): string {
  const psArray = headerLines.map(psq).join(", ");
  const ownedNames = [EXTERNAL_AGENT_ID_HEADER, VIRTUAL_KEY_HEADER]
    .map((name) => psq(name.toLowerCase()))
    .join(", ");
  return `$arch_hpath = ${CLAUDE_SETTINGS_PATH}
$arch_hconfig = [pscustomobject]@{}
if (Test-Path $arch_hpath) {
  $arch_hraw = Get-Content -Raw -Path $arch_hpath
  if ($arch_hraw -and $arch_hraw.Trim()) { $arch_hconfig = $arch_hraw | ConvertFrom-Json }
}
if (-not $arch_hconfig.PSObject.Properties['env']) { $arch_hconfig | Add-Member -NotePropertyName 'env' -NotePropertyValue ([pscustomobject]@{}) }
$arch_henv = $arch_hconfig.env
$arch_hnew = @(${psArray})
$arch_hnames = @(${ownedNames})
$arch_hexisting = ''
if ($arch_henv.PSObject.Properties['${CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY}']) { $arch_hexisting = [string]$arch_henv.${CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY} }
$arch_hkept = @()
foreach ($arch_hl in ($arch_hexisting -split "\\r?\\n")) {
  if ($arch_hl.Trim() -and ($arch_hnames -notcontains ($arch_hl -split ':',2)[0].Trim().ToLower())) { $arch_hkept += $arch_hl }
}
$arch_hkept += $arch_hnew
$arch_hjoined = ($arch_hkept -join "\`n")
if ($arch_henv.PSObject.Properties['${CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY}']) { $arch_henv.${CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY} = $arch_hjoined } else { $arch_henv | Add-Member -NotePropertyName '${CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY}' -NotePropertyValue $arch_hjoined }
$arch_hconfig | ConvertTo-Json -Depth 32 | Set-Content -Path $arch_hpath -Encoding utf8
Write-Host ('Updated ' + $arch_hpath)`;
}

function claudeBedrockProxyPowerShell(proxy: SetupScriptProxySection): string {
  const values: Record<string, string> = {
    [CLAUDE_USE_BEDROCK_KEY]: "1",
    [AWS_REGION_KEY]: "us-east-1",
    [BEDROCK_BASE_URL_KEY]: proxy.url,
  };
  if (proxy.virtualKey) {
    // The virtual key authenticates against the proxy as a Bedrock bearer
    // token. Merged into settings.json env exactly like ANTHROPIC_AUTH_TOKEN
    // on the Anthropic path, so the setup needs no manual step.
    values[AWS_BEARER_TOKEN_KEY] = proxy.virtualKey;
  }
  return `Say ${psq("Routing Claude Code through the Bedrock proxy")}
${mergeJsonFilePowerShell({
  pathExpr: CLAUDE_SETTINGS_PATH,
  nestedKey: "env",
  values,
  removeManagedTokenKeys: proxy.virtualKey ? [] : [AWS_BEARER_TOKEN_KEY],
})}
${claudeCustomHeaderAppendSnippet(claudeCustomHeaderLines(proxy))}
Write-Host 'Update AWS_REGION in the settings.json env block if you use a different region.'${
    proxy.virtualKey
      ? ""
      : `
Write-Host 'Your existing AWS credentials keep working — only the base URL changed.'`
  }`;
}

/**
 * Claude Code declares user marketplaces in settings.json as a structured
 * source. Re-adding an identical marketplace is not always idempotent when
 * the declared fetch identity differs. Compare the declaration first so
 * matching registrations avoid that error and source or credential changes
 * are reconciled deliberately. Both URL userinfo and an equivalent Basic
 * Authorization header are supported representations of the same identity.
 */
function claudeMarketplaceRegistrationBash(
  marketplaceName: string,
  cloneUrl: string,
): string {
  const add = `cli claude plugin marketplace add --scope user ${sh(cloneUrl)}`;
  const remove = `cli claude plugin marketplace remove --scope user ${sh(marketplaceName)}`;
  const registrationFailure = sh(
    `Could not register the "${marketplaceName}" marketplace. Shared skills were not installed.`,
  );

  return `claude_marketplace_state() {
  if ! command -v python3 >/dev/null 2>&1; then
    printf '%s' unknown
    return
  fi
  ARCHESTRA_MARKETPLACE_NAME=${sh(marketplaceName)} \\
    ARCHESTRA_MARKETPLACE_URL=${sh(cloneUrl)} \\
    python3 - <<'ARCHESTRA_MARKETPLACE_PY'
import base64, json, os
from pathlib import Path
from urllib.parse import unquote, urlsplit

name = os.environ["ARCHESTRA_MARKETPLACE_NAME"]
clone_url = os.environ["ARCHESTRA_MARKETPLACE_URL"]
config_dir = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
settings_path = config_dir / "settings.json"

try:
    settings = json.loads(settings_path.read_text()) if settings_path.exists() else {}
except Exception:
    print("unknown")
    raise SystemExit

source = settings.get("extraKnownMarketplaces", {}).get(name, {}).get("source")
if not isinstance(source, dict):
    print("add")
    raise SystemExit

def target(url):
    parsed = urlsplit(url)
    if not parsed.scheme or not parsed.hostname:
        return None
    host = parsed.hostname.lower()
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    port = parsed.port
    authority = host if port is None else f"{host}:{port}"
    return (parsed.scheme.lower(), authority, parsed.path or "/", parsed.query)

def credentials(url):
    parsed = urlsplit(url)
    if parsed.username is None:
        return None
    return f"{unquote(parsed.username)}:{unquote(parsed.password or '')}"

def headers(value):
    if isinstance(value, dict):
        return {str(key).lower(): str(item) for key, item in value.items()}
    if isinstance(value, list):
        result = {}
        for item in value:
            if isinstance(item, dict) and isinstance(item.get("name"), str):
                result[item["name"].lower()] = str(item.get("value", ""))
        return result
    return {}

declared_url = source.get("url")
desired_credentials = credentials(clone_url)
declared_credentials = credentials(declared_url) if isinstance(declared_url, str) else None
declared_headers = headers(source.get("headers"))
source_has_extra_fetch_shape = any(
    source.get(key) not in (None, "", [], {})
    for key in ("ref", "path", "sparsePaths")
)
matches_url_credentials = declared_credentials == desired_credentials and not declared_headers
if not declared_credentials and desired_credentials:
    basic = base64.b64encode(desired_credentials.encode()).decode()
    matches_url_credentials = declared_headers == {"authorization": f"Basic {basic}"}

if (
    source.get("source") == "git"
    and isinstance(declared_url, str)
    and target(declared_url) == target(clone_url)
    and matches_url_credentials
    and not source_has_extra_fetch_shape
):
    print("matching")
else:
    print("replace")
ARCHESTRA_MARKETPLACE_PY
}

marketplace_state="$(claude_marketplace_state)"
case "$marketplace_state" in
  matching)
    ok ${sh(`Marketplace "${marketplaceName}" is already registered with the requested source.`)}
    ;;
  replace)
    say ${sh(`Updating the "${marketplaceName}" marketplace source`)}
    ${remove}
    ${add}
    ;;
  *)
    if ! marketplace_add_output="$( ${add} )"; then
      printf '%s\n' "$marketplace_add_output"
      if [[ "$marketplace_add_output" == *"network source differs from the one declared for it in settings"* ]]; then
        say ${sh(`Updating the "${marketplaceName}" marketplace source`)}
        ${remove}
        ${add}
      else
        err ${registrationFailure}
        exit 1
      fi
    fi
    ;;
esac
${claudeMarketplaceAutoUpdateBash(marketplaceName)}`;
}

/**
 * Claude Code refreshes a third-party marketplace, and updates the plugins
 * installed from it, only when that marketplace has auto-update enabled — and
 * it is off by default for every marketplace added with `marketplace add`.
 * Without it the client keeps the skill revision it installed on connect
 * forever, so shipped skill fixes never reach it. Claude Code reads the flag
 * from the marketplace's `extraKnownMarketplaces` declaration (its own
 * "Enable auto-update" toggle writes the same field), so set it there. An
 * explicit value is the user's choice and is kept.
 */
function claudeMarketplaceAutoUpdateBash(marketplaceName: string): string {
  const manual = sh(
    `Could not enable auto-update for the "${marketplaceName}" marketplace. Enable it in /plugin > Marketplaces so Claude Code picks up new skill versions.`,
  );
  return `claude_marketplace_auto_update() {
  if ! command -v python3 >/dev/null 2>&1; then
    printf '%s' unavailable
    return
  fi
  ARCHESTRA_MARKETPLACE_NAME=${sh(marketplaceName)} \\
    python3 - <<'ARCHESTRA_MARKETPLACE_AUTO_UPDATE_PY'
import json, os, tempfile
from pathlib import Path

name = os.environ["ARCHESTRA_MARKETPLACE_NAME"]
config_dir = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
settings_path = config_dir / "settings.json"

try:
    settings = json.loads(settings_path.read_text())
    entry = settings.get("extraKnownMarketplaces", {}).get(name)
except Exception:
    print("unavailable")
    raise SystemExit

if not isinstance(entry, dict):
    print("unavailable")
    raise SystemExit
if "autoUpdate" in entry:
    print("kept")
    raise SystemExit

entry["autoUpdate"] = True
try:
    fd, tmp = tempfile.mkstemp(dir=settings_path.parent, prefix=".settings.", suffix=".tmp")
    with os.fdopen(fd, "w") as handle:
        json.dump(settings, handle, indent=2)
        handle.write("\\n")
    os.chmod(tmp, settings_path.stat().st_mode & 0o777)
    os.replace(tmp, settings_path)
except Exception:
    print("unavailable")
    raise SystemExit
print("enabled")
ARCHESTRA_MARKETPLACE_AUTO_UPDATE_PY
}

case "$(claude_marketplace_auto_update)" in
  enabled)
    ok ${sh(`Enabled auto-update for the "${marketplaceName}" marketplace.`)}
    ;;
  kept) ;;
  *)
    warn ${manual}
    ;;
esac`;
}

/**
 * Claude Code declares user marketplaces in settings.json as structured
 * sources. Compare that declaration before calling `marketplace add`: matching
 * credential-bearing URLs and equivalent Authorization headers describe the
 * same fetch identity, while changed source or credentials need replacement.
 */
function claudeMarketplaceRegistrationPowerShell(
  marketplaceName: string,
  cloneUrl: string,
): string {
  const add = `claude plugin marketplace add --scope user ${psq(cloneUrl)}`;
  return `function Get-ArchMarketplaceTarget($value) {
  try {
    $uri = [uri]$value
    if (-not $uri.Scheme -or -not $uri.Host) { return $null }
    $uriHost = $uri.Host.ToLowerInvariant()
    if ($uriHost.Contains(':') -and -not $uriHost.StartsWith('[')) { $uriHost = '[' + $uriHost + ']' }
    $authority = $uriHost
    if (-not $uri.IsDefaultPort) { $authority += ':' + $uri.Port }
    return @($uri.Scheme.ToLowerInvariant(), $authority, $(if ($uri.AbsolutePath) { $uri.AbsolutePath } else { '/' }), $uri.Query) -join '|'
  } catch { return $null }
}
function Get-ArchMarketplaceCredentials($value) {
  try {
    $uri = [uri]$value
    if ([string]::IsNullOrEmpty($uri.UserInfo)) { return $null }
    $parts = $uri.UserInfo.Split(':', 2)
    return [uri]::UnescapeDataString($parts[0]) + ':' + $(if ($parts.Length -gt 1) { [uri]::UnescapeDataString($parts[1]) } else { '' })
  } catch { return $null }
}
function Get-ArchMarketplaceState {
  $configDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.claude' }
  $settingsPath = Join-Path $configDir 'settings.json'
  if (-not (Test-Path $settingsPath)) { return 'add' }
  try { $settings = Get-Content -Raw -Path $settingsPath | ConvertFrom-Json } catch { return 'unknown' }
  $marketplaces = $settings.extraKnownMarketplaces
  if (-not $marketplaces -or -not $marketplaces.PSObject.Properties[${psq(marketplaceName)}]) { return 'add' }
  $source = $marketplaces.PSObject.Properties[${psq(marketplaceName)}].Value.source
  if (-not $source -or $source.source -cne 'git' -or -not $source.url) { return 'replace' }
  $desiredUrl = ${psq(cloneUrl)}
  $declaredTarget = Get-ArchMarketplaceTarget $source.url
  $desiredTarget = Get-ArchMarketplaceTarget $desiredUrl
  if ($null -eq $declaredTarget -or $null -eq $desiredTarget -or $declaredTarget -cne $desiredTarget) { return 'replace' }
  foreach ($field in @('ref', 'path', 'sparsePaths')) {
    if ($source.PSObject.Properties[$field] -and $source.$field) { return 'replace' }
  }
  $declaredCredentials = Get-ArchMarketplaceCredentials $source.url
  $desiredCredentials = Get-ArchMarketplaceCredentials $desiredUrl
  $headers = @{}
  if ($source.PSObject.Properties['headers'] -and $source.headers) {
    if ($source.headers -is [array]) {
      foreach ($header in $source.headers) {
        if ($header.name) { $headers[[string]$header.name.ToLowerInvariant()] = [string]$header.value }
      }
    } else {
      foreach ($header in $source.headers.PSObject.Properties) { $headers[$header.Name.ToLowerInvariant()] = [string]$header.Value }
    }
  }
  if ($declaredCredentials -ceq $desiredCredentials -and $headers.Count -eq 0) { return 'matching' }
  if (-not $declaredCredentials -and $desiredCredentials) {
    $basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($desiredCredentials))
    if ($headers.Count -eq 1 -and $headers['authorization'] -ceq ('Basic ' + $basic)) { return 'matching' }
  }
  return 'replace'
}
function Remove-ArchMarketplace {
  $marketplaceRemoved = $false
  try {
    claude plugin marketplace remove --scope user ${psq(marketplaceName)} 2>$null | Out-Null
    $marketplaceRemoved = $LASTEXITCODE -eq 0
  } catch { }
  return $marketplaceRemoved
}

$marketplaceState = Get-ArchMarketplaceState
if ($marketplaceState -eq 'matching') {
  Ok ${psq(`Marketplace "${marketplaceName}" is already registered with the requested source.`)}
} elseif ($marketplaceState -eq 'replace') {
  Say ${psq(`Updating the "${marketplaceName}" marketplace source`)}
  if (-not (Remove-ArchMarketplace)) {
    Err ${psq(`Could not replace the "${marketplaceName}" marketplace source. Shared skills were not installed.`)}
    exit 1
  }
  ${add}
  if ($LASTEXITCODE -ne 0) {
    Err ${psq(`Could not register the "${marketplaceName}" marketplace. Shared skills were not installed.`)}
    exit 1
  }
} else {
$marketplaceAddOutput = ''
$marketplaceAdded = $false
try {
  $marketplaceAddOutput = & ${add} 2>&1 | Out-String
  $marketplaceAdded = $LASTEXITCODE -eq 0
} catch {
  $marketplaceAddOutput += $_.Exception.Message
}
if (-not $marketplaceAdded) {
  Write-Host $marketplaceAddOutput
  if ($marketplaceAddOutput -like '*network source differs from the one declared for it in settings*') {
    Say ${psq(`Updating the "${marketplaceName}" marketplace source`)}
    if (-not (Remove-ArchMarketplace)) {
      Err ${psq(`Could not replace the "${marketplaceName}" marketplace source. Shared skills were not installed.`)}
      exit 1
    }
    claude plugin marketplace add --scope user ${psq(cloneUrl)}
    if ($LASTEXITCODE -ne 0) {
      Err ${psq(`Could not register the "${marketplaceName}" marketplace. Shared skills were not installed.`)}
      exit 1
    }
  } else {
    Err ${psq(`Could not register the "${marketplaceName}" marketplace. Shared skills were not installed.`)}
    exit 1
  }
}
}
${claudeMarketplaceAutoUpdatePowerShell(marketplaceName)}`;
}

/**
 * PowerShell twin of `claudeMarketplaceAutoUpdateBash`:
 * Claude Code keeps a third-party marketplace's plugins at the installed
 * revision unless the marketplace declares `autoUpdate`, which is off by
 * default. Set it on our declaration unless the user already chose a value.
 */
function claudeMarketplaceAutoUpdatePowerShell(
  marketplaceName: string,
): string {
  return `$archAutoUpdateState = 'unavailable'
try {
  $archAutoConfigDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.claude' }
  $archAutoSettingsPath = Join-Path $archAutoConfigDir 'settings.json'
  $archAutoSettings = Get-Content -Raw -Path $archAutoSettingsPath | ConvertFrom-Json
  $archAutoEntry = $archAutoSettings.extraKnownMarketplaces.PSObject.Properties[${psq(marketplaceName)}]
  if ($archAutoEntry -and $archAutoEntry.Value) {
    if ($archAutoEntry.Value.PSObject.Properties['autoUpdate']) {
      $archAutoUpdateState = 'kept'
    } else {
      $archAutoEntry.Value | Add-Member -NotePropertyName 'autoUpdate' -NotePropertyValue $true
      [IO.File]::WriteAllText($archAutoSettingsPath, ($archAutoSettings | ConvertTo-Json -Depth 32), (New-Object System.Text.UTF8Encoding $false))
      $archAutoUpdateState = 'enabled'
    }
  }
} catch { $archAutoUpdateState = 'unavailable' }
if ($archAutoUpdateState -eq 'enabled') {
  Ok ${psq(`Enabled auto-update for the "${marketplaceName}" marketplace.`)}
} elseif ($archAutoUpdateState -ne 'kept') {
  Warn ${psq(`Could not enable auto-update for the "${marketplaceName}" marketplace. Enable it in /plugin > Marketplaces so Claude Code picks up new skill versions.`)}
}`;
}

function claudeCodeBashSections(ctx: SetupScriptContext): string[] {
  const sections: string[] = [];

  if (ctx.mcp) {
    // Register at USER scope so the gateway is visible in every directory for
    // this user. `claude mcp add` defaults to `local` (per-directory) scope,
    // which makes the server "disappear" the moment Claude Code is run from a
    // different folder than the one connect happened to run in. Clear BOTH the
    // local and user scopes first: a stale local entry from an older connect run
    // would otherwise shadow the user entry and fail `add` under `set -euo
    // pipefail`, leaving the gateway removed and not re-added.
    const stale = legacyServerNames(ctx.mcp)
      .flatMap((name) => [
        `cli claude mcp remove --scope local ${sh(name)} >/dev/null 2>&1 || true`,
        `cli claude mcp remove --scope user ${sh(name)} >/dev/null 2>&1 || true`,
      ])
      .join("\n");
    const preflight = claudeAppaPermissionsPreflightBash(ctx.mcp);
    if (preflight) sections.push(preflight);
    sections.push(`say ${sh(`Adding ${ctx.appName} tools as "${ctx.mcp.serverName}"`)}
cli claude mcp remove --scope local ${sh(ctx.mcp.serverName)} >/dev/null 2>&1 || true
cli claude mcp remove --scope user ${sh(ctx.mcp.serverName)} >/dev/null 2>&1 || true${stale ? `\n${stale}` : ""}
cli claude mcp add --scope user --transport http ${sh(ctx.mcp.serverName)} ${sh(ctx.mcp.url)}`);
    sections.push(claudeAppaPermissionsBash(ctx.mcp));
  }

  if (ctx.proxy) {
    sections.push(
      ctx.proxy.provider === "bedrock"
        ? claudeBedrockProxyBash(ctx.proxy)
        : claudeAnthropicProxyBash(ctx.proxy),
    );
  }

  if (ctx.skills) {
    const hasSkills = ctx.skills.hasSkills ?? true;
    const pluginNames = ctx.skills.pluginNames ?? [];
    const pluginRef = `${ctx.skills.marketplaceName}@${ctx.skills.marketplaceName}`;
    const installs = [
      ...(hasSkills
        ? [
            `if ! cli claude plugin install ${sh(pluginRef)}; then
  warn ${sh(`Could not install the skills automatically — run 'claude plugin install ${pluginRef}' or open /plugin inside Claude Code.`)}
fi`,
          ]
        : []),
      ...pluginNames.map((pluginName) => {
        const ref = `${pluginName}@${ctx.skills?.marketplaceName}`;
        return `if ! cli claude plugin install ${sh(ref)}; then
  warn ${sh(`Could not install plugin — run 'claude plugin install ${ref}'.`)}
fi`;
      }),
    ];
    sections.push(`say ${sh(`Installing the "${ctx.skills.marketplaceName}" marketplace`)}
${claudeMarketplaceRegistrationBash(ctx.skills.marketplaceName, ctx.skills.cloneUrl)}
${installs.join("\n")}`);
  }

  return withStartupGuardBash(ctx, CLAUDE_CODE_GUARD_CLIENT, sections);
}

function claudeCodePowerShellSections(ctx: SetupScriptContext): string[] {
  const sections: string[] = [];

  if (ctx.mcp) {
    // Register at USER scope so the gateway is visible in every directory for
    // this user (see claudeCodeBashSections for the full rationale). Clear
    // both local and user scopes first so a stale local entry can't shadow the
    // user entry.
    const stale = legacyServerNames(ctx.mcp)
      .flatMap((name) => [
        `try { claude mcp remove --scope local ${psq(name)} 2>$null | Out-Null } catch { }`,
        `try { claude mcp remove --scope user ${psq(name)} 2>$null | Out-Null } catch { }`,
      ])
      .join("\n");
    sections.push(`Say ${psq(`Adding ${ctx.appName} tools as "${ctx.mcp.serverName}"`)}
try { claude mcp remove --scope local ${psq(ctx.mcp.serverName)} 2>$null | Out-Null } catch { }
try { claude mcp remove --scope user ${psq(ctx.mcp.serverName)} 2>$null | Out-Null } catch { }${stale ? `\n${stale}` : ""}
claude mcp add --scope user --transport http ${psq(ctx.mcp.serverName)} ${psq(ctx.mcp.url)}
if ($LASTEXITCODE -ne 0) { throw 'Could not register the MCP gateway. Fix the error above and re-run setup.' }`);
  }

  if (ctx.proxy) {
    sections.push(
      ctx.proxy.provider === "bedrock"
        ? claudeBedrockProxyPowerShell(ctx.proxy)
        : claudeAnthropicProxyPowerShell(ctx.proxy),
    );
  }

  if (ctx.skills) {
    const hasSkills = ctx.skills.hasSkills ?? true;
    const pluginInstalls = (ctx.skills.pluginNames ?? [])
      .map((pluginName) => {
        const ref = `${pluginName}@${ctx.skills?.marketplaceName}`;
        return `claude plugin install ${psq(ref)}
if ($LASTEXITCODE -ne 0) { Warn ${psq(`Could not install plugin — run 'claude plugin install ${ref}'.`)} }`;
      })
      .join("\n");
    const pluginRef = `${ctx.skills.marketplaceName}@${ctx.skills.marketplaceName}`;
    sections.push(`Say ${psq(`Installing the "${ctx.skills.marketplaceName}" marketplace`)}
${claudeMarketplaceRegistrationPowerShell(ctx.skills.marketplaceName, ctx.skills.cloneUrl)}
${
  hasSkills
    ? `claude plugin install ${psq(pluginRef)}
if ($LASTEXITCODE -ne 0) { Warn ${psq(`Could not install the skills automatically — run 'claude plugin install ${pluginRef}' or open /plugin inside Claude Code.`)} }`
    : ""
}
${pluginInstalls}`);
  }

  if (ctx.mcp) {
    sections.push(claudeAppaPermissionsPowerShell(ctx.mcp));
  }

  return withStartupGuardPowerShell(ctx, CLAUDE_CODE_GUARD_CLIENT, sections);
}

function claudeCodeEnding(ctx: SetupScriptContext): AgentEnding {
  const plugins = ctx.skills?.pluginNames?.length ?? 0;
  return {
    parts:
      ctx.mcp || ctx.proxy || ctx.skills
        ? [{ name: "Launch check", detail: "Runs each time you start claude" }]
        : [],
    signIn: ctx.mcp
      ? {
          command: ["claude", "mcp", "login", ctx.mcp.serverName],
          howTo: `Start claude, run /mcp, pick "${ctx.mcp.serverName}" and sign in.`,
        }
      : null,
    launch: ["claude", starterPrompt(ctx)],
    notes:
      plugins > 0
        ? [
            `${plugins} plugin${plugins === 1 ? " is" : "s are"} installed and load on their own.`,
          ]
        : [],
  };
}

export const claudeCodeSetup: ShellAgentSetup = {
  label: "Claude Code",
  binary: "claude",
  bash: {
    sections: claudeCodeBashSections,
  },
  powerShell: {
    sections: claudeCodePowerShellSections,
  },
  ending: claudeCodeEnding,
};
