import {
  ARCHESTRA_TOKEN_PREFIX,
  CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY,
  CLAUDE_CODE_PROXY_ENV_KEYS,
  COPILOT_PROVIDER_ENV_KEYS,
  EXTERNAL_AGENT_ID_HEADER,
  STARTUP_GUARD_INSTALL,
  VIRTUAL_KEY_HEADER,
} from "@archestra/shared";
import type { StartupGuardClient, StartupGuardContext } from "./startup-guard";

/**
 * Per-client startup-guard descriptors — the client-specific half of the guard
 * (the shared engine lives in `startup-guard.ts`). Each descriptor supplies the
 * wrapped binary, the conversational product name shown in prompts, the install
 * locations (from the shared {@link STARTUP_GUARD_INSTALL} record), the
 * non-interactive launch flags to bow out on, and the exact reverse-of-connect
 * disconnect commands the guard runs when a remote is unreachable.
 *
 * Cursor is deliberately absent: it is a GUI IDE with no wrappable terminal
 * launch command, so its connect is reversed from the Disconnect panel rather
 * than a startup guard.
 */

/** Single-quote a value for bash; safe for arbitrary content. */
function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Single-quote a value for PowerShell; safe for arbitrary content. */
function psq(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// ===================================================================
// Claude Code
// ===================================================================

export const CLAUDE_CODE_GUARD_CLIENT: StartupGuardClient = {
  clientId: "claude-code",
  binary: "claude",
  label: "Claude Code",
  promptName: "Claude",
  disableEnvVar: "ARCHESTRA_CLAUDE_GUARD",
  ...STARTUP_GUARD_INSTALL["claude-code"],
  // Claude Code's non-interactive one-shot mode.
  nonInteractiveArgPatterns: ["-p", "--print"],
  mcpDisconnectCommands: `      command claude mcp remove --scope user "$MCP_SERVER_NAME" </dev/null >/dev/null 2>&1 || true
      command claude mcp remove --scope local "$MCP_SERVER_NAME" </dev/null >/dev/null 2>&1 || true`,
  skillsDisconnectCommands: `      command claude plugin marketplace remove "$SKILLS_MARKETPLACE_NAME" </dev/null >/dev/null 2>&1 || true`,
  renderProxyDisconnect: claudeProxyDisconnect,
  windows: {
    mcpDisconnect: `      if ($archRealExe) {
        try { & $archRealExe.Source mcp remove --scope user $McpServerName 2>$null | Out-Null } catch { }
        try { & $archRealExe.Source mcp remove --scope local $McpServerName 2>$null | Out-Null } catch { }
      }`,
    skillsDisconnect: `      if ($archRealExe) {
        try { & $archRealExe.Source plugin marketplace remove $SkillsMarketplaceName 2>$null | Out-Null } catch { }
      }`,
    renderProxyDisconnect: claudeWindowsProxyDisconnect,
    proxyDisconnectNote: (ctx) =>
      ctx.proxy?.provider === "bedrock"
        ? "If you set AWS_BEARER_TOKEN_BEDROCK in your environment, remove it there too."
        : "",
  },
};

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

// ===================================================================
// Codex
// ===================================================================

export const CODEX_GUARD_CLIENT: StartupGuardClient = {
  clientId: "codex",
  binary: "codex",
  label: "Codex",
  promptName: "Codex",
  disableEnvVar: "ARCHESTRA_CODEX_GUARD",
  ...STARTUP_GUARD_INSTALL.codex,
  // `codex exec …` is Codex's non-interactive one-shot subcommand.
  nonInteractiveArgPatterns: ["exec"],
  mcpDisconnectCommands: `      command codex mcp remove "$MCP_SERVER_NAME" </dev/null >/dev/null 2>&1 || true`,
  skillsDisconnectCommands: `      command codex plugin marketplace remove "$SKILLS_MARKETPLACE_NAME" </dev/null >/dev/null 2>&1 || true`,
  mcpDisconnectVerify: codexVerifyTableGone(
    "mcp_servers",
    "$MCP_SERVER_NAME",
    "codex mcp remove",
  ),
  skillsDisconnectVerify: codexVerifyTableGone(
    "marketplaces",
    "$SKILLS_MARKETPLACE_NAME",
    "codex plugin marketplace remove",
  ),
  renderProxyDisconnect: codexProxyDisconnect,
  windows: {
    mcpDisconnect: `      if ($archRealExe) { try { & $archRealExe.Source mcp remove $McpServerName 2>$null | Out-Null } catch { } }`,
    skillsDisconnect: `      if ($archRealExe) { try { & $archRealExe.Source plugin marketplace remove $SkillsMarketplaceName 2>$null | Out-Null } catch { } }`,
    mcpDisconnectVerify: codexWindowsVerifyTableGone(
      "mcp_servers",
      "$McpServerName",
      "codex mcp remove",
    ),
    skillsDisconnectVerify: codexWindowsVerifyTableGone(
      "marketplaces",
      "$SkillsMarketplaceName",
      "codex plugin marketplace remove",
    ),
    renderProxyDisconnect: codexWindowsProxyDisconnect,
    proxyDisconnectNote: (ctx) =>
      `Removed the ${ctx.appName} provider from the Codex config.toml. If Codex was signed in with an ${ctx.appName} virtual key it has been signed out — run codex login to sign back in with your own account.`,
  },
};

/**
 * Codex keeps its config where `CODEX_HOME` points, defaulting to `~/.codex`.
 * The vendor CLI honours that variable, so a guard that hardcoded `~/.codex`
 * would verify a different file than the one `codex mcp remove` just edited and
 * report a phantom failure.
 */
function codexConfigShellPath(): string {
  return '"${CODEX_HOME:-$HOME/.codex}/config.toml"';
}

/**
 * Prove a `[<section>.<name>]` table is gone from Codex's config, and say what
 * to run by hand when it is not.
 *
 * The removal itself is delegated to the Codex CLI, which is the right owner —
 * it deletes the parent table together with any nested `[<section>.<name>.*]`
 * sub-tables (per-tool `approval_mode` entries), which a line-based stripper
 * here would strand. What the guard must not do is *assume* the delegation
 * happened: the binary may not resolve, so reading the file back is the only
 * honest check.
 */
function codexVerifyTableGone(
  section: string,
  nameVar: string,
  manualCommand: string,
): string {
  return `      arch_cfg=${codexConfigShellPath()}
      [ -f "$arch_cfg" ] || return 0
      grep -q "^\\[${section}\\.${nameVar}\\]" "$arch_cfg" 2>/dev/null || return 0
      line_reset
      printf '%s  [${section}.%s] is still in %s — run \`${manualCommand} %s\` yourself.%s\\n' "$C_WARN" "${nameVar}" "$arch_cfg" "${nameVar}" "$C_RESET"
      return 1`;
}

/**
 * Codex's proxy disconnect on Windows: strip the `# >>> archestra:<proxyName> >>>`
 * … `# <<< archestra:<proxyName> <<<` block connect appended to
 * ~/.codex/config.toml — the exact reverse of the block the Windows connect
 * script writes. Pure PowerShell, mirroring the connect script's own strip loop.
 */
/** PowerShell twin of {@link codexConfigShellPath}. */
function codexHomePs(): string {
  return "$(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' })";
}

/** PowerShell twin of {@link codexVerifyTableGone}. */
function codexWindowsVerifyTableGone(
  section: string,
  nameVar: string,
  manualCommand: string,
): string {
  return `    $archCfg = Join-Path ${codexHomePs()} 'config.toml'
    if (Test-Path $archCfg) {
      $archHeader = '[${section}.' + ${nameVar} + ']'
      if (@(Get-Content -Path $archCfg) -contains $archHeader) {
        $Script:ArchDisconnectReason = $archHeader + ' is still in ' + $archCfg + ' — run \`${manualCommand} ' + ${nameVar} + '\` yourself.'
        return $false
      }
    }`;
}

function codexWindowsProxyDisconnect(ctx: StartupGuardContext): string {
  const marker = `archestra:${ctx.proxy?.proxyName ?? ""}`;
  return `function Disconnect-ArchProxy {
  $path = Join-Path ${codexHomePs()} 'config.toml'
  if (Test-Path $path) {
    $start = ${psq(`# >>> ${marker} >>>`)}
    $end = ${psq(`# <<< ${marker} <<<`)}
    $kept = New-Object System.Collections.Generic.List[string]
    $skip = $false
    foreach ($ln in (Get-Content -Path $path)) {
      if ($ln -eq $start) { $skip = $true; continue }
      if ($ln -eq $end) { $skip = $false; continue }
      if (-not $skip) { $kept.Add($ln) }
    }
    Set-Content -Path $path -Value $kept -Encoding utf8
  }
  Invoke-ArchCodexLogoutIfOurs
}

# Sign out ONLY when Codex is holding an ${ctx.appName} key. A user-owned key
# (sk-…) or a ChatGPT session is left untouched: \`codex logout\` deletes the
# whole credential file, so running it unconditionally would destroy an account
# login the user established themselves.
function Invoke-ArchCodexLogoutIfOurs {
  $Script:ArchLoggedOut = $false
  $authPath = Join-Path ${codexHomePs()} 'auth.json'
  if (-not (Test-Path $authPath)) { return }
  $raw = ''
  try { $raw = Get-Content -Path $authPath -Raw } catch { return }
  if ($raw -match '"auth_mode"\\s*:\\s*"chatgpt"') { return }
  if ($raw -notmatch '"OPENAI_API_KEY"\\s*:\\s*"${ARCHESTRA_TOKEN_PREFIX}') { return }
  $exe = Get-ArchRealExe
  if (-not $exe) { return }
  try { & $exe.Source logout 2>$null | Out-Null } catch { return }
  $Script:ArchLoggedOut = $true
}`;
}

/**
 * Codex's proxy disconnect: strip the `# >>> archestra:<proxyName> >>>` …
 * `# <<< archestra:<proxyName> <<<` block connect appended to Codex's
 * config.toml (awk, no python3 dependency), then sign Codex out of the virtual
 * key connect logged it in with.
 *
 * Both halves are required, and dropping only the first is worse than dropping
 * neither. Connect writes the pair as `base_url` inside that block plus an
 * `arch_…` key in Codex's own credential store (`codex login --with-api-key`).
 * The block is inert until the user opts in with `codex -c model_provider=…`;
 * the credential is global. Removing only the block therefore leaves every
 * plain `codex` run sending an Archestra virtual key to api.openai.com, which
 * answers `401 Incorrect API key provided: arch_…` — Codex ends up more broken
 * than before it was ever connected, and the key leaks to a third party.
 *
 * `codex logout` deletes the whole credential file, so it is only safe when the
 * credential in it is ours. The guard checks for our `arch_` prefix — a prefix
 * test, so no secret is read — and skips a ChatGPT session (`auth_mode`), which
 * Codex prefers over any stored key and which the user established themselves.
 */
function codexProxyDisconnect(ctx: StartupGuardContext): string {
  const marker = `archestra:${ctx.proxy?.proxyName ?? ""}`;
  return `disconnect_proxy() {
  CONFIG=${codexConfigShellPath()}
  if [ -f "$CONFIG" ]; then
    awk -v start=${sh(`# >>> ${marker} >>>`)} -v end=${sh(`# <<< ${marker} <<<`)} '
      $0 == start {skip=1; next}
      $0 == end {skip=0; next}
      !skip {print}
    ' "$CONFIG" > "$CONFIG.archestra-tmp" 2>/dev/null && mv "$CONFIG.archestra-tmp" "$CONFIG"
  fi
  codex_logout_if_ours
}

# Sign out ONLY when Codex is holding an ${ctx.appName} key. A user-owned
# key (sk-…) or a ChatGPT session is left untouched: logout would delete it.
codex_logout_if_ours() {
  AUTH=${'"${CODEX_HOME:-$HOME/.codex}/auth.json"'}
  [ -f "$AUTH" ] || return 0
  grep -q '"auth_mode"[[:space:]]*:[[:space:]]*"chatgpt"' "$AUTH" 2>/dev/null && return 0
  grep -q '"OPENAI_API_KEY"[[:space:]]*:[[:space:]]*"${ARCHESTRA_TOKEN_PREFIX}' "$AUTH" 2>/dev/null || return 0
  command codex logout </dev/null >/dev/null 2>&1 || true
  ARCH_LOGGED_OUT=1
}

proxy_disconnect_notes() {
  line_reset
  printf '%s  Removed the ${ctx.appName} provider from $CONFIG.%s\\n' "$C_DIM" "$C_RESET"
  if [ "\${ARCH_LOGGED_OUT:-0}" = "1" ]; then
    printf '%s  Signed Codex out of the ${ctx.appName} virtual key — run \`codex login\` to sign back in with your own account.%s\\n' "$C_DIM" "$C_RESET"
  fi
  return 0
}`;
}

// ===================================================================
// Copilot CLI
// ===================================================================

export const COPILOT_GUARD_CLIENT: StartupGuardClient = {
  clientId: "copilot-cli",
  binary: "copilot",
  label: "Copilot CLI",
  promptName: "Copilot",
  disableEnvVar: "ARCHESTRA_COPILOT_GUARD",
  ...STARTUP_GUARD_INSTALL["copilot-cli"],
  // Copilot CLI's non-interactive one-shot flag.
  nonInteractiveArgPatterns: ["-p", "--prompt"],
  mcpDisconnectCommands: `      command copilot mcp remove "$MCP_SERVER_NAME" </dev/null >/dev/null 2>&1 || true`,
  skillsDisconnectCommands: `      command copilot plugin marketplace remove "$SKILLS_MARKETPLACE_NAME" </dev/null >/dev/null 2>&1 || true`,
  renderProxyDisconnect: copilotProxyDisconnect,
  windows: {
    mcpDisconnect: `      if ($archRealExe) { try { & $archRealExe.Source mcp remove $McpServerName 2>$null | Out-Null } catch { } }`,
    skillsDisconnect: `      if ($archRealExe) { try { & $archRealExe.Source plugin marketplace remove $SkillsMarketplaceName 2>$null | Out-Null } catch { } }`,
    renderProxyDisconnect: copilotWindowsProxyDisconnect,
    proxyDisconnectNote: () =>
      "Removed the COPILOT_PROVIDER_* environment variables (User scope and this session). Open a new terminal for the change to fully take effect.",
  },
};

/**
 * Copilot CLI's proxy disconnect on Windows: connect applies the
 * `COPILOT_PROVIDER_*` env vars (current session + User scope), so the
 * reverse clears those three from both, leaving the user's own
 * `COPILOT_MODEL` choice untouched.
 */
function copilotWindowsProxyDisconnect(_ctx: StartupGuardContext): string {
  const names = [
    COPILOT_PROVIDER_ENV_KEYS.type,
    COPILOT_PROVIDER_ENV_KEYS.baseUrl,
    COPILOT_PROVIDER_ENV_KEYS.apiKey,
    COPILOT_PROVIDER_ENV_KEYS.headers,
  ]
    .map((n) => `'${n}'`)
    .join(", ");
  return `function Disconnect-ArchProxy {
  foreach ($n in @(${names})) {
    try { [Environment]::SetEnvironmentVariable($n, $null, 'User') } catch { }
    try { Remove-Item -Path ('Env:' + $n) -ErrorAction SilentlyContinue } catch { }
  }
}`;
}

/**
 * Copilot CLI's proxy disconnect: Copilot is configured through
 * `COPILOT_PROVIDER_*` environment exports (connect prints them for the user to
 * paste into a shell profile), so the reverse is best-effort — strip any
 * `export COPILOT_PROVIDER_{TYPE,BASE_URL,API_KEY,HEADERS}=…` lines from the
 * common shell profiles, leaving the user's own `COPILOT_MODEL` choice
 * untouched.
 */
function copilotProxyDisconnect(_ctx: StartupGuardContext): string {
  return `disconnect_proxy() {
  for profile in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
    [ -f "$profile" ] || continue
    grep -Eq '^[[:space:]]*export[[:space:]]+COPILOT_PROVIDER_(TYPE|BASE_URL|API_KEY|HEADERS)=' "$profile" 2>/dev/null || continue
    grep -Ev '^[[:space:]]*export[[:space:]]+COPILOT_PROVIDER_(TYPE|BASE_URL|API_KEY|HEADERS)=' "$profile" > "$profile.archestra-tmp" 2>/dev/null && mv "$profile.archestra-tmp" "$profile"
  done
}

proxy_disconnect_notes() {
  line_reset
  printf '%s  Removed any COPILOT_PROVIDER_* export lines from your shell profiles — open a new terminal so the change takes effect.%s\\n' "$C_DIM" "$C_RESET"
  return 0
}`;
}
