// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these files build bash/PowerShell source as JS strings, so `${VAR}` is shell
// parameter expansion for the emitted script, not a JS template placeholder

import {
  ARCHESTRA_TOKEN_PREFIX,
  CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY,
  CLAUDE_CODE_PROXY_ENV_KEYS,
  COPILOT_PROVIDER_ENV_KEYS,
  EXTERNAL_AGENT_ID_HEADER,
  OPENCODE_PASSTHROUGH_PROVIDER_ROUTES,
  openCodePassthroughBaseUrl,
  STARTUP_GUARD_INSTALL,
  VIRTUAL_KEY_HEADER,
} from "@archestra/shared";
import logger from "@/logging";
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
 * launch command, so no startup guard can host a disconnect for it. Its
 * connect currently has no automated reversal at all — the Disconnect panel
 * that once covered it was removed from the connect flow — so undoing a
 * Cursor connect means editing `~/.cursor/mcp.json` by hand.
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
      }`,
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
  skillsDisconnectCommands: `      printf '%s\n' "$PLUGIN_NAMES" | while IFS= read -r arch_plugin; do
        [ -n "$arch_plugin" ] || continue
        command codex plugin remove "$arch_plugin@$SKILLS_MARKETPLACE_NAME" </dev/null >/dev/null 2>&1 || true
      done
      command codex plugin marketplace remove "$SKILLS_MARKETPLACE_NAME" </dev/null >/dev/null 2>&1 || true`,
  skillsRefreshCommands: `  command codex plugin marketplace upgrade "$arch_refresh_marketplace" </dev/null >/dev/null 2>&1 || return 1
  printf '%s\n' "$arch_refresh_plugin_names" | while IFS= read -r arch_plugin; do
    [ -n "$arch_plugin" ] || continue
    command codex plugin remove "$arch_plugin@$arch_refresh_marketplace" </dev/null >/dev/null 2>&1 || true
    command codex plugin add "$arch_plugin@$arch_refresh_marketplace" </dev/null >/dev/null 2>&1 || exit 1
  done || return 1`,
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
    skillsDisconnect: `      if ($archRealExe) {
        foreach ($archPlugin in $PluginNames) {
          try { & $archRealExe.Source plugin remove ($archPlugin + '@' + $SkillsMarketplaceName) 2>$null | Out-Null } catch { }
        }
        try { & $archRealExe.Source plugin marketplace remove $SkillsMarketplaceName 2>$null | Out-Null } catch { }
      }`,
    skillsRefreshCommands: `  & $archRefreshReal.Source plugin marketplace upgrade $ArchRefreshMarketplace 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { return $false }
  foreach ($archPlugin in $ArchRefreshPluginNames) {
    & $archRefreshReal.Source plugin remove ($archPlugin + '@' + $ArchRefreshMarketplace) 2>$null | Out-Null
    & $archRefreshReal.Source plugin add ($archPlugin + '@' + $ArchRefreshMarketplace) 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { return $false }
  }`,
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
  const selectedProvider = `model_provider = "${ctx.proxy?.proxyName ?? ""}"`;
  return `function Disconnect-ArchProxy {
  $path = Join-Path ${codexHomePs()} 'config.toml'
  if (Test-Path $path) {
    $start = ${psq(`# >>> ${marker} >>>`)}
    $end = ${psq(`# <<< ${marker} <<<`)}
    $selected = ${psq(selectedProvider)}
    $previous = ''
    $backup = $path + '.archestra-backup'
    if (Test-Path $backup) {
      foreach ($original in (Get-Content -Path $backup)) {
        if ($original -match '^\\[') { break }
        if ($original -match '^\\s*model_provider\\s*=') { $previous = $original; break }
      }
    }
    $kept = New-Object System.Collections.Generic.List[string]
    $skip = $false
    $inTable = $false
    foreach ($ln in (Get-Content -Path $path)) {
      if ($ln -eq $start) { $skip = $true; continue }
      if ($ln -eq $end) { $skip = $false; continue }
      if ($skip) { continue }
      if ($ln -match '^\\[') { $inTable = $true }
      if (-not $inTable -and $ln -eq $selected) {
        if ($previous -and $previous -ne $selected) { $kept.Add($previous) }
        continue
      }
      $kept.Add($ln)
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
 * Codex proxy disconnect: remove the `# >>> archestra:<proxyName> >>>` ...
 * `# <<< archestra:<proxyName> <<<` block from `config.toml`, restore the
 * previous default provider, and sign Codex out of any Archestra virtual key.
 *
 * Both steps are necessary. Connect sets the proxy as the default provider and
 * writes the virtual key to the Codex credential store (`codex login --with-api-key`).
 * The credential applies globally. If the script only removes the provider block,
 * normal `codex` runs send the Archestra virtual key directly to api.openai.com.
 * OpenAI returns `401 Incorrect API key provided: arch_...`. This breaks Codex
 * and leaks the virtual key.
 *
 * `codex logout` deletes the entire credential file. It is safe only when the
 * file contains an Archestra credential. The guard checks for the `arch_` prefix
 * without reading secret values. It leaves ChatGPT sessions (`auth_mode`) intact.
 */
function codexProxyDisconnect(ctx: StartupGuardContext): string {
  const marker = `archestra:${ctx.proxy?.proxyName ?? ""}`;
  const selectedProvider = `model_provider = "${ctx.proxy?.proxyName ?? ""}"`;
  return `disconnect_proxy() {
  CONFIG=${codexConfigShellPath()}
  if [ -f "$CONFIG" ]; then
    PREVIOUS_PROVIDER=''
    if [ -f "$CONFIG.archestra-backup" ]; then
      PREVIOUS_PROVIDER=$(awk '
        /^\\[/ {exit}
        /^[[:space:]]*model_provider[[:space:]]*=/ {print; exit}
      ' "$CONFIG.archestra-backup")
    fi
    awk -v start=${sh(`# >>> ${marker} >>>`)} -v end=${sh(`# <<< ${marker} <<<`)} -v selected=${sh(selectedProvider)} -v previous="$PREVIOUS_PROVIDER" '
      $0 == start {skip=1; next}
      $0 == end {skip=0; next}
      !skip {
        if ($0 ~ /^\\[/) in_table=1
        if (!in_table && $0 == selected) {
          if (previous != "" && previous != selected) print previous
          next
        }
        print
      }
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
  skillsDisconnectCommands: `      printf '%s\n' "$PLUGIN_NAMES" | while IFS= read -r arch_plugin; do
        [ -n "$arch_plugin" ] || continue
        command copilot plugin uninstall "$arch_plugin@$SKILLS_MARKETPLACE_NAME" </dev/null >/dev/null 2>&1 || true
      done
      command copilot plugin marketplace remove "$SKILLS_MARKETPLACE_NAME" </dev/null >/dev/null 2>&1 || true`,
  skillsRefreshCommands: `  command copilot plugin marketplace update "$arch_refresh_marketplace" </dev/null >/dev/null 2>&1 || return 1
  printf '%s\n' "$arch_refresh_plugin_names" | while IFS= read -r arch_plugin; do
    [ -n "$arch_plugin" ] || continue
    command copilot plugin update "$arch_plugin@$arch_refresh_marketplace" </dev/null >/dev/null 2>&1 || exit 1
  done || return 1`,
  // Copilot CLI keeps MCP servers in `~/.copilot/mcp-config.json` under
  // `mcpServers` and registered marketplaces in `~/.copilot/settings.json`
  // under `extraKnownMarketplaces` (both verified against a live install).
  mcpDisconnectVerify: jsonMemberGoneVerify({
    configPath: '"$HOME/.copilot/mcp-config.json"',
    member: "mcpServers",
    nameVar: "$MCP_SERVER_NAME",
    manualCommand: "copilot mcp remove",
  }),
  skillsDisconnectVerify: jsonMemberGoneVerify({
    configPath: '"$HOME/.copilot/settings.json"',
    member: "extraKnownMarketplaces",
    nameVar: "$SKILLS_MARKETPLACE_NAME",
    manualCommand: "copilot plugin marketplace remove",
  }),
  renderProxyDisconnect: copilotProxyDisconnect,
  windows: {
    mcpDisconnect: `      if ($archRealExe) { try { & $archRealExe.Source mcp remove $McpServerName 2>$null | Out-Null } catch { } }`,
    skillsDisconnect: `      if ($archRealExe) {
        foreach ($archPlugin in $PluginNames) {
          try { & $archRealExe.Source plugin uninstall ($archPlugin + '@' + $SkillsMarketplaceName) 2>$null | Out-Null } catch { }
        }
        try { & $archRealExe.Source plugin marketplace remove $SkillsMarketplaceName 2>$null | Out-Null } catch { }
      }`,
    skillsRefreshCommands: `  & $archRefreshReal.Source plugin marketplace update $ArchRefreshMarketplace 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { return $false }
  foreach ($archPlugin in $ArchRefreshPluginNames) {
    & $archRefreshReal.Source plugin update ($archPlugin + '@' + $ArchRefreshMarketplace) 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { return $false }
  }`,
    mcpDisconnectVerify: windowsJsonMemberGoneVerify({
      configPath: "Join-Path $env:USERPROFILE '.copilot\\mcp-config.json'",
      member: "mcpServers",
      nameVar: "$McpServerName",
      manualCommand: "copilot mcp remove",
    }),
    skillsDisconnectVerify: windowsJsonMemberGoneVerify({
      configPath: "Join-Path $env:USERPROFILE '.copilot\\settings.json'",
      member: "extraKnownMarketplaces",
      nameVar: "$SkillsMarketplaceName",
      manualCommand: "copilot plugin marketplace remove",
    }),
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

// ===================================================================
// Shared disconnect-verification helpers
// ===================================================================

/**
 * Bash proof that a named member is gone from a client's JSON config, for the
 * engine's `disconnect_verify()`.
 *
 * The removal itself is delegated to the vendor CLI, whose exit status cannot
 * answer "is it gone?" — a remove of an already-absent entry may exit 0 or 1
 * depending on the CLI — and a missing binary makes the removal a silent
 * no-op. Reading the config back is the only honest check, and it is also
 * what catches the missing-binary case. Prints the manual command and returns
 * 1 when the entry survived.
 *
 * The check needs python3 for a real JSON parse (a plain grep of a JSON file
 * false-positives on names that appear in unrelated values); without python3
 * it returns 0, keeping the previous assume-success behaviour rather than
 * failing disconnects on machines that cannot verify. An unreadable or
 * corrupt config also passes: presence is unprovable there, and the failure
 * path must only fire on proof.
 */
function jsonMemberGoneVerify(params: {
  /** Shell expression for the config path, e.g. `"$HOME/.copilot/mcp-config.json"`. */
  configPath: string;
  /** Top-level object holding the entries; empty string = the document root. */
  member: string;
  /** Shell variable carrying the entry name, e.g. `$MCP_SERVER_NAME`. */
  nameVar: string;
  /** Command the user can run by hand when verification fails. */
  manualCommand: string;
}): string {
  const { configPath, member, nameVar, manualCommand } = params;
  return `      command -v python3 >/dev/null 2>&1 || return 0
      arch_cfg=${configPath}
      [ -f "$arch_cfg" ] || return 0
      if python3 -c '
import json, sys
try:
    with open(sys.argv[1]) as f:
        cfg = json.load(f)
except Exception:
    sys.exit(0)
parent = cfg.get(sys.argv[3]) if sys.argv[3] else cfg
sys.exit(1 if isinstance(parent, dict) and sys.argv[2] in parent else 0)
' "$arch_cfg" "${nameVar}" "${member}"; then return 0; fi
      line_reset
      printf '%s  %s is still registered in %s — run \`${manualCommand} %s\` yourself.%s\\n' "$C_WARN" "${nameVar}" "$arch_cfg" "${nameVar}" "$C_RESET"
      return 1`;
}

/**
 * PowerShell twin of {@link jsonMemberGoneVerify}, for the engine's
 * `Test-ArchDisconnected`. ConvertFrom-Json is built in, so there is no
 * python3-style dependency; the unreadable-config case still passes for the
 * same reason.
 */
function windowsJsonMemberGoneVerify(params: {
  /** PowerShell expression for the config path. */
  configPath: string;
  /** Top-level object holding the entries; empty string = the document root. */
  member: string;
  /** PowerShell variable carrying the entry name, e.g. `$McpServerName`. */
  nameVar: string;
  /** Command the user can run by hand when verification fails. */
  manualCommand: string;
}): string {
  const { configPath, member, nameVar, manualCommand } = params;
  const parent = member ? `$archParsed.${member}` : "$archParsed";
  return `    $archCfg = ${configPath}
    if (Test-Path $archCfg) {
      $archParsed = $null
      try { $archParsed = Get-Content -Path $archCfg -Raw | ConvertFrom-Json } catch { }
      $archParent = if ($archParsed) { ${parent} } else { $null }
      if ($archParent -and $archParent.PSObject.Properties[${nameVar}]) {
        $Script:ArchDisconnectReason = ${nameVar} + ' is still registered in ' + $archCfg + ' — run \`${manualCommand} ' + ${nameVar} + '\` yourself.'
        return $false
      }
    }`;
}

// ===================================================================
// OpenCode
// ===================================================================

/**
 * OpenCode's connect merges the provider and MCP entries it owns into the
 * documented global config, writes a key file under ~/.archestra in
 * virtual-key mode, and clones skills separately. Disconnect removes only
 * those entries; OpenCode's auth store is never
 * touched, so local keys and subscriptions remain available.
 */
function opencodeProviderId(provider: string): string {
  return (
    OPENCODE_PASSTHROUGH_PROVIDER_ROUTES.find(
      (route) => route.provider === provider,
    )?.openCodeProviderId ?? provider
  );
}

// Drops `<section>.<name>` from the global config. Inputs arrive via env, never argv.
const OPENCODE_OWNED_STRIP_PY = `import json, os, pathlib
p = pathlib.Path(os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config"))) / "opencode" / "opencode.json"
if p.exists():
    d = json.loads(p.read_text() or "{}")
    section = os.environ["ARCH_OC_SECTION"]
    name = os.environ["ARCH_OC_NAME"]
    entries = d.get(section)
    if isinstance(entries, dict):
        entries.pop(name, None)
        if not entries:
            d.pop(section, None)
    if section == "provider":
        state_path = pathlib.Path(os.path.expanduser("~/.archestra/opencode-connection-state.json"))
        if state_path.exists():
            state = json.loads(state_path.read_text())
            provider_state = state.get("providerState") or {}
            if name in provider_state:
                providers = d.setdefault("provider", {})
                if provider_state[name] is None: providers.pop(name, None)
                else: providers[name] = provider_state[name]
                if not providers: d.pop("provider", None)
            if state.get("enabledProvidersPresent"): d["enabled_providers"] = state.get("enabledProviders")
            else: d.pop("enabled_providers", None)
            if state.get("disabledProvidersPresent"): d["disabled_providers"] = state.get("disabledProviders")
            else: d.pop("disabled_providers", None)
            state_path.unlink()
    backup = p.with_name(p.name + ".archestra-backup")
    if [k for k in d if k != "$schema"] or backup.exists():
        p.write_text(json.dumps(d, indent=2) + "\\n")
    else:
        p.unlink()`;

// Exit 0 when `<section>.<name>` is still in the global config.
const OPENCODE_OWNED_HAS_PY = `import json, os, pathlib, sys
p = pathlib.Path(os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config"))) / "opencode" / "opencode.json"
d = json.loads(p.read_text() or "{}") if p.exists() else {}
sys.exit(0 if os.environ["ARCH_OC_NAME"] in (d.get(os.environ["ARCH_OC_SECTION"]) or {}) else 1)`;

const OPENCODE_OWNED_STRIP_NODE = `const fs=require("fs"),path=require("path"),os=require("os");
const home=process.env.HOME||os.homedir();
const p=path.join(process.env.XDG_CONFIG_HOME||path.join(home,".config"),"opencode","opencode.json");
if(fs.existsSync(p)){
  const d=JSON.parse(fs.readFileSync(p,"utf8")||"{}");
  const section=process.env.ARCH_OC_SECTION,name=process.env.ARCH_OC_NAME;
  const entries=d[section];
  if(entries&&typeof entries==="object") { delete entries[name]; if(Object.keys(entries).length===0) delete d[section]; }
  if(section==="provider"){
    const statePath=path.join(home,".archestra","opencode-connection-state.json");
    if(fs.existsSync(statePath)){
      const state=JSON.parse(fs.readFileSync(statePath,"utf8"));
      const providerState=state.providerState||{};
      if(Object.hasOwn(providerState,name)){
        d.provider??={};
        if(providerState[name]===null) delete d.provider[name]; else d.provider[name]=providerState[name];
        if(Object.keys(d.provider).length===0) delete d.provider;
      }
      if(state.enabledProvidersPresent) d.enabled_providers=state.enabledProviders; else delete d.enabled_providers;
      if(state.disabledProvidersPresent) d.disabled_providers=state.disabledProviders; else delete d.disabled_providers;
      fs.rmSync(statePath,{force:true});
    }
  }
  const backup=p+".archestra-backup";
  if(Object.keys(d).some((key)=>key!=="$schema")||fs.existsSync(backup)) fs.writeFileSync(p,JSON.stringify(d,null,2)+"\\n");
  else fs.rmSync(p,{force:true});
}`;

const OPENCODE_OWNED_HAS_NODE = `const fs=require("fs"),path=require("path"),os=require("os");
const home=process.env.HOME||os.homedir();
const p=path.join(process.env.XDG_CONFIG_HOME||path.join(home,".config"),"opencode","opencode.json");
const d=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,"utf8")||"{}"):{};
process.exit(Object.hasOwn(d[process.env.ARCH_OC_SECTION]||{},process.env.ARCH_OC_NAME)?0:1);`;

const OPENCODE_PASSTHROUGH_STRIP_PY = `import json, os, pathlib
p = pathlib.Path(os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config"))) / "opencode" / "opencode.json"
if p.exists():
    d = json.loads(p.read_text() or "{}")
    providers = d.get("provider")
    expected_routes = json.loads(os.environ["ARCH_OC_PROVIDER_ROUTES"])
    managed_headers = json.loads(os.environ["ARCH_OC_HEADERS"])
    if isinstance(providers, dict):
        for provider_id, expected_url in expected_routes.items():
            entry = providers.get(provider_id)
            if not isinstance(entry, dict): continue
            options = entry.get("options")
            if not isinstance(options, dict): continue
            if options.get("baseURL") == expected_url: options.pop("baseURL", None)
            headers = options.get("headers")
            if isinstance(headers, dict):
                for name, value in managed_headers.items():
                    if headers.get(name) == value: headers.pop(name, None)
                if not headers: options.pop("headers", None)
            if not options: entry.pop("options", None)
            if not entry: providers.pop(provider_id, None)
        if not providers: d.pop("provider", None)
    state_path = pathlib.Path(os.path.expanduser("~/.archestra/opencode-connection-state.json"))
    if state_path.exists():
        state = json.loads(state_path.read_text())
        provider_state = state.get("providerState") or {}
        providers = d.setdefault("provider", {})
        for provider_id, previous in provider_state.items():
            if previous is None:
                if provider_id in providers and not providers[provider_id]: providers.pop(provider_id, None)
            else: providers[provider_id] = previous
        if not providers: d.pop("provider", None)
        if state.get("enabledProvidersPresent"): d["enabled_providers"] = state.get("enabledProviders")
        else: d.pop("enabled_providers", None)
        if state.get("disabledProvidersPresent"): d["disabled_providers"] = state.get("disabledProviders")
        else: d.pop("disabled_providers", None)
        state_path.unlink()
    p.write_text(json.dumps(d, indent=2) + "\\n")`;

const OPENCODE_PASSTHROUGH_STRIP_NODE = `const fs=require("fs"),path=require("path"),os=require("os");
const home=process.env.HOME||os.homedir();
const p=path.join(process.env.XDG_CONFIG_HOME||path.join(home,".config"),"opencode","opencode.json");
if(fs.existsSync(p)){
  const d=JSON.parse(fs.readFileSync(p,"utf8")||"{}");
  const providers=d.provider,expected=JSON.parse(process.env.ARCH_OC_PROVIDER_ROUTES),managed=JSON.parse(process.env.ARCH_OC_HEADERS);
  if(providers&&typeof providers==="object"){
    for(const [providerId,expectedUrl] of Object.entries(expected)){
      const entry=providers[providerId],options=entry?.options;
      if(!options||typeof options!=="object") continue;
      if(options.baseURL===expectedUrl) delete options.baseURL;
      if(options.headers&&typeof options.headers==="object"){
        for(const [name,value] of Object.entries(managed)) if(options.headers[name]===value) delete options.headers[name];
        if(Object.keys(options.headers).length===0) delete options.headers;
      }
      if(Object.keys(options).length===0) delete entry.options;
      if(Object.keys(entry).length===0) delete providers[providerId];
    }
    if(Object.keys(providers).length===0) delete d.provider;
  }
  const statePath=path.join(home,".archestra","opencode-connection-state.json");
  if(fs.existsSync(statePath)){
    const state=JSON.parse(fs.readFileSync(statePath,"utf8"));
    d.provider??={};
    for(const [providerId,previous] of Object.entries(state.providerState||{})){
      if(previous===null){ if(d.provider[providerId]&&Object.keys(d.provider[providerId]).length===0) delete d.provider[providerId]; }
      else d.provider[providerId]=previous;
    }
    if(Object.keys(d.provider).length===0) delete d.provider;
    if(state.enabledProvidersPresent) d.enabled_providers=state.enabledProviders; else delete d.enabled_providers;
    if(state.disabledProvidersPresent) d.disabled_providers=state.disabledProviders; else delete d.disabled_providers;
    fs.rmSync(statePath,{force:true});
  }
  fs.writeFileSync(p,JSON.stringify(d,null,2)+"\\n");
}`;

const OPENCODE_PLUGIN_RESTORE_NODE = `const fs=require("node:fs");
const [plugin,state]=process.argv.slice(1);
try {
  if (fs.existsSync(state)) {
    const saved=JSON.parse(fs.readFileSync(state,"utf8"));
    if (saved.existed && saved.contentBase64) { fs.mkdirSync(require("node:path").dirname(plugin),{recursive:true}); fs.writeFileSync(plugin,Buffer.from(saved.contentBase64,"base64"),{mode:0o600}); }
    else fs.rmSync(plugin,{force:true});
    fs.rmSync(state,{force:true});
  } else fs.rmSync(plugin,{force:true});
} catch { fs.rmSync(plugin,{force:true}); }`;

const OPENCODE_PLUGIN_RESTORE_PY = `import base64, json, pathlib, sys
plugin, state = map(pathlib.Path, sys.argv[1:3])
try:
    if state.exists():
        saved = json.loads(state.read_text())
        if saved.get("existed") and saved.get("contentBase64"):
            plugin.parent.mkdir(parents=True, exist_ok=True)
            plugin.write_bytes(base64.b64decode(saved["contentBase64"]))
            plugin.chmod(0o600)
        else:
            plugin.unlink(missing_ok=True)
        state.unlink(missing_ok=True)
    else:
        plugin.unlink(missing_ok=True)
except Exception:
    plugin.unlink(missing_ok=True)`;

const OPENCODE_SKILLS_DIR_SH =
  '"${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills/$SKILLS_MARKETPLACE_NAME"';

function opencodeConfigDirPs(): string {
  return "$(if ($env:XDG_CONFIG_HOME) { Join-Path $env:XDG_CONFIG_HOME 'opencode' } else { Join-Path $env:USERPROFILE '.config/opencode' })";
}

/** PowerShell: drop `<section>.<name>` from the global config (BOM-free write). */
function opencodeWindowsStrip(section: string, nameExpr: string): string {
  return `    $archOc = Join-Path ${opencodeConfigDirPs()} 'opencode.json'
    if (Test-Path $archOc) {
      try {
        $archCfg = Get-Content -Raw -Path $archOc | ConvertFrom-Json
        $archSection = $archCfg.PSObject.Properties[${psq(section)}]
        if ($archSection -and $archSection.Value.PSObject.Properties[${nameExpr}]) {
          $archSection.Value.PSObject.Properties.Remove(${nameExpr})
          if (@($archSection.Value.PSObject.Properties).Count -eq 0) { $archCfg.PSObject.Properties.Remove(${psq(section)}) }
        }
        ${section === "provider" ? opencodeWindowsRestoreProviderCatalog() : ""}
        $archBackup = $archOc + '.archestra-backup'
        if (@($archCfg.PSObject.Properties | Where-Object { $_.Name -ne '$schema' }).Count -eq 0 -and -not (Test-Path $archBackup)) { Remove-Item -Force $archOc }
        else { [IO.File]::WriteAllText($archOc, ($archCfg | ConvertTo-Json -Depth 32), (New-Object System.Text.UTF8Encoding $false)) }
      } catch { }
    }`;
}

function opencodeWindowsVerifyGone(section: string, nameExpr: string): string {
  return `    $archOc = Join-Path ${opencodeConfigDirPs()} 'opencode.json'
    if (Test-Path $archOc) {
      try {
        $archCfg = Get-Content -Raw -Path $archOc | ConvertFrom-Json
        $archSection = $archCfg.PSObject.Properties[${psq(section)}]
        if ($archSection -and $archSection.Value.PSObject.Properties[${nameExpr}]) {
          $Script:ArchDisconnectReason = ${nameExpr} + ' is still in ' + $archOc + ' — remove it from the ${section} block yourself.'
          return $false
        }
      } catch { }
    }`;
}

function opencodeWindowsRestoreProviderCatalog(): string {
  return `$archStateFile = Join-Path $env:USERPROFILE '.archestra/opencode-connection-state.json'
        if (Test-Path $archStateFile) {
          $archState = Get-Content -Raw -Path $archStateFile | ConvertFrom-Json
          if ($archState.PSObject.Properties['providerState']) {
            if (-not $archCfg.PSObject.Properties['provider']) { $archCfg | Add-Member -NotePropertyName 'provider' -NotePropertyValue ([pscustomobject]@{}) }
            foreach ($archSavedProvider in $archState.providerState.PSObject.Properties) {
              if ($null -ne $archSavedProvider.Value) {
                if ($archCfg.provider.PSObject.Properties[$archSavedProvider.Name]) { $archCfg.provider.($archSavedProvider.Name) = $archSavedProvider.Value }
                else { $archCfg.provider | Add-Member -NotePropertyName $archSavedProvider.Name -NotePropertyValue $archSavedProvider.Value }
              } else {
                $archCurrentProvider = $archCfg.provider.PSObject.Properties[$archSavedProvider.Name]
                if ($archCurrentProvider -and @($archCurrentProvider.Value.PSObject.Properties).Count -eq 0) { $archCfg.provider.PSObject.Properties.Remove($archSavedProvider.Name) }
              }
            }
            if (@($archCfg.provider.PSObject.Properties).Count -eq 0) { $archCfg.PSObject.Properties.Remove('provider') }
          }
          if ($archState.enabledProvidersPresent) {
            if ($archCfg.PSObject.Properties['enabled_providers']) { $archCfg.enabled_providers = @($archState.enabledProviders) }
            else { $archCfg | Add-Member -NotePropertyName 'enabled_providers' -NotePropertyValue @($archState.enabledProviders) }
          }
          else { $archCfg.PSObject.Properties.Remove('enabled_providers') }
          if ($archState.disabledProvidersPresent) {
            if ($archCfg.PSObject.Properties['disabled_providers']) { $archCfg.disabled_providers = @($archState.disabledProviders) }
            else { $archCfg | Add-Member -NotePropertyName 'disabled_providers' -NotePropertyValue @($archState.disabledProviders) }
          }
          else { $archCfg.PSObject.Properties.Remove('disabled_providers') }
          Remove-Item -Force $archStateFile
        }`;
}

function opencodeWindowsRestoreRoutingPlugin(): string {
  return `$archPluginFile = Join-Path ${opencodeConfigDirPs()} 'plugins/archestra-llm-proxy.js'
  $archPluginState = Join-Path $env:USERPROFILE '.archestra/opencode-routing-plugin-state.json'
  if (Test-Path $archPluginState) {
    try {
      $archSavedPlugin = Get-Content -Raw -Path $archPluginState | ConvertFrom-Json
      if ($archSavedPlugin.existed -and $archSavedPlugin.contentBase64) { $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $archPluginFile); [IO.File]::WriteAllBytes($archPluginFile, [Convert]::FromBase64String($archSavedPlugin.contentBase64)) }
      else { Remove-Item -Force -ErrorAction SilentlyContinue $archPluginFile }
    } catch { Remove-Item -Force -ErrorAction SilentlyContinue $archPluginFile }
    Remove-Item -Force -ErrorAction SilentlyContinue $archPluginState
  } else { Remove-Item -Force -ErrorAction SilentlyContinue $archPluginFile }`;
}

function opencodeWindowsRemoveConfigBackup(): string {
  // After plugin restore and proxy strip, matching Bash disconnect_proxy.
  return `  Remove-Item -Force -ErrorAction SilentlyContinue ((Join-Path ${opencodeConfigDirPs()} 'opencode.json') + '.archestra-backup')`;
}

function opencodeRestoreRoutingPluginSh(): string {
  return `arch_oc_plugin="\${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/archestra-llm-proxy.js"
  arch_oc_plugin_state="$HOME/.archestra/opencode-routing-plugin-state.json"
  if command -v node >/dev/null 2>&1; then
    node -e ${sh(OPENCODE_PLUGIN_RESTORE_NODE)} "$arch_oc_plugin" "$arch_oc_plugin_state"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c ${sh(OPENCODE_PLUGIN_RESTORE_PY)} "$arch_oc_plugin" "$arch_oc_plugin_state"
  else
    printf '%s  Node.js and python3 are unavailable. Restore or remove %s yourself.%s\n' "$C_WARN" "$arch_oc_plugin" "$C_RESET"
    return 1
  fi`;
}

function opencodeProxyDisconnect(ctx: StartupGuardContext): string {
  if (ctx.proxy?.authMode === "provider-key") {
    const routes = opencodePassthroughRoutes(ctx);
    const headers = opencodeManagedHeaders(ctx);
    return `disconnect_proxy() {
  ${opencodeRestoreRoutingPluginSh()}
  if command -v node >/dev/null 2>&1; then
    ARCH_OC_PROVIDER_ROUTES=${sh(JSON.stringify(routes))} ARCH_OC_HEADERS=${sh(JSON.stringify(headers))} node -e ${sh(OPENCODE_PASSTHROUGH_STRIP_NODE)} >/dev/null 2>&1 || true
  elif command -v python3 >/dev/null 2>&1; then
    ARCH_OC_PROVIDER_ROUTES=${sh(JSON.stringify(routes))} ARCH_OC_HEADERS=${sh(JSON.stringify(headers))} python3 -c ${sh(OPENCODE_PASSTHROUGH_STRIP_PY)} >/dev/null 2>&1 || true
  fi
  rm -f "\${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json.archestra-backup"
}

proxy_disconnect_notes() {
  line_reset
  printf '%s  Removed ${ctx.appName} route overrides from supported OpenCode providers. Local authentication and model selection are unchanged.%s\n' "$C_DIM" "$C_RESET"
  return 0
}`;
  }
  const id = opencodeProviderId(ctx.proxy?.provider ?? "");
  return `disconnect_proxy() {
  ${opencodeRestoreRoutingPluginSh()}
  if command -v node >/dev/null 2>&1; then
    ARCH_OC_SECTION=provider ARCH_OC_NAME=${sh(id)} node -e ${sh(OPENCODE_OWNED_STRIP_NODE)} >/dev/null 2>&1 || true
  elif command -v python3 >/dev/null 2>&1; then
    ARCH_OC_SECTION=provider ARCH_OC_NAME=${sh(id)} python3 -c ${sh(OPENCODE_OWNED_STRIP_PY)} >/dev/null 2>&1 || true
  fi
  rm -f "$HOME/.archestra/opencode-${id}.key"
  rm -f "\${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json.archestra-backup"
}

proxy_disconnect_notes() {
  line_reset
  if command -v node >/dev/null 2>&1 || command -v python3 >/dev/null 2>&1; then
    printf '%s  Removed the ${ctx.appName} provider settings from ~/.config/opencode/opencode.json. Local provider authentication is unchanged.%s\n' "$C_DIM" "$C_RESET"
  else
    printf '%s  Node.js and python3 are unavailable. Delete provider.${id} from ~/.config/opencode/opencode.json yourself.%s\n' "$C_WARN" "$C_RESET"
  fi
  return 0
}`;
}

function opencodeWindowsProxyDisconnect(ctx: StartupGuardContext): string {
  if (ctx.proxy?.authMode === "provider-key") {
    const routes = opencodePassthroughRoutes(ctx);
    const headers = opencodeManagedHeaders(ctx);
    const routeJson = psq(JSON.stringify(routes));
    const headerJson = psq(JSON.stringify(headers));
    return `function Disconnect-ArchProxy {
  ${opencodeWindowsRestoreRoutingPlugin()}
  $archOc = Join-Path ${opencodeConfigDirPs()} 'opencode.json'
  if (Test-Path $archOc) {
    try {
      $archCfg = Get-Content -Raw -Path $archOc | ConvertFrom-Json
      $archRoutes = ${routeJson} | ConvertFrom-Json
      $archManagedHeaders = ${headerJson} | ConvertFrom-Json
      foreach ($archRoute in $archRoutes.PSObject.Properties) {
        $archEntry = $archCfg.provider.PSObject.Properties[$archRoute.Name]
        if (-not $archEntry) { continue }
        $archOptions = $archEntry.Value.PSObject.Properties['options']
        if (-not $archOptions) { continue }
        if ($archOptions.Value.baseURL -eq $archRoute.Value) { $archOptions.Value.PSObject.Properties.Remove('baseURL') }
        $archHeaders = $archOptions.Value.PSObject.Properties['headers']
        if ($archHeaders) {
          foreach ($archHeader in $archManagedHeaders.PSObject.Properties) {
            if ($archHeaders.Value.($archHeader.Name) -eq $archHeader.Value) { $archHeaders.Value.PSObject.Properties.Remove($archHeader.Name) }
          }
          if (@($archHeaders.Value.PSObject.Properties).Count -eq 0) { $archOptions.Value.PSObject.Properties.Remove('headers') }
        }
        if (@($archOptions.Value.PSObject.Properties).Count -eq 0) { $archEntry.Value.PSObject.Properties.Remove('options') }
        if (@($archEntry.Value.PSObject.Properties).Count -eq 0) { $archCfg.provider.PSObject.Properties.Remove($archRoute.Name) }
      }
      ${opencodeWindowsRestoreProviderCatalog()}
      [IO.File]::WriteAllText($archOc, ($archCfg | ConvertTo-Json -Depth 32), (New-Object System.Text.UTF8Encoding $false))
    } catch { }
  }
${opencodeWindowsRemoveConfigBackup()}
}`;
  }
  const id = opencodeProviderId(ctx.proxy?.provider ?? "");
  return `function Disconnect-ArchProxy {
  ${opencodeWindowsRestoreRoutingPlugin()}
${opencodeWindowsStrip("provider", psq(id))}
  Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $env:USERPROFILE ${psq(`.archestra/opencode-${id}.key`)})
${opencodeWindowsRemoveConfigBackup()}
}`;
}

export const OPENCODE_GUARD_CLIENT: StartupGuardClient = {
  clientId: "opencode",
  binary: "opencode",
  label: "OpenCode",
  promptName: "OpenCode",
  disableEnvVar: "ARCHESTRA_OPENCODE_GUARD",
  ...STARTUP_GUARD_INSTALL.opencode,
  // One-shot and headless subcommands: warn on stderr, skip the pre-loader.
  nonInteractiveArgPatterns: [
    "run",
    "serve",
    "web",
    "acp",
    "mcp",
    "auth",
    "debug",
    "models",
    "export",
    "import",
    "stats",
    "upgrade",
    "uninstall",
  ],
  mcpDisconnectCommands: `      command opencode mcp logout "$MCP_SERVER_NAME" </dev/null >/dev/null 2>&1 || true
      if command -v node >/dev/null 2>&1; then
        ARCH_OC_SECTION=mcp ARCH_OC_NAME="$MCP_SERVER_NAME" node -e ${sh(OPENCODE_OWNED_STRIP_NODE)} >/dev/null 2>&1 || true
      elif command -v python3 >/dev/null 2>&1; then
        ARCH_OC_SECTION=mcp ARCH_OC_NAME="$MCP_SERVER_NAME" python3 -c ${sh(OPENCODE_OWNED_STRIP_PY)} >/dev/null 2>&1 || true
      fi`,
  skillsDisconnectCommands: `      [ -n "$SKILLS_MARKETPLACE_NAME" ] && rm -rf ${OPENCODE_SKILLS_DIR_SH}`,
  skillsRefreshCommands: `  arch_oc_skills="\${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills/$arch_refresh_marketplace"
  [ -d "$arch_oc_skills/.git" ] || return 0
  command -v git >/dev/null 2>&1 || return 1
  git -C "$arch_oc_skills" pull --ff-only -q </dev/null >/dev/null 2>&1 || return 1`,
  mcpDisconnectVerify: `      arch_oc_mcp_present=1
      if command -v node >/dev/null 2>&1; then
        ARCH_OC_SECTION=mcp ARCH_OC_NAME="$MCP_SERVER_NAME" node -e ${sh(OPENCODE_OWNED_HAS_NODE)} 2>/dev/null && arch_oc_mcp_present=0
      elif command -v python3 >/dev/null 2>&1; then
        ARCH_OC_SECTION=mcp ARCH_OC_NAME="$MCP_SERVER_NAME" python3 -c ${sh(OPENCODE_OWNED_HAS_PY)} 2>/dev/null && arch_oc_mcp_present=0
      fi
      if [ -f "\${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json" ] && [ "$arch_oc_mcp_present" -eq 0 ]; then
        line_reset
        printf '%s  "%s" is still in ~/.config/opencode/opencode.json — remove it from the mcp block yourself.%s\\n' "$C_WARN" "$MCP_SERVER_NAME" "$C_RESET"
        return 1
      fi`,
  skillsDisconnectVerify: `      if [ -n "$SKILLS_MARKETPLACE_NAME" ] && [ -d ${OPENCODE_SKILLS_DIR_SH} ]; then
        line_reset
        printf '%s  %s is still there — delete it yourself.%s\\n' "$C_WARN" ${OPENCODE_SKILLS_DIR_SH} "$C_RESET"
        return 1
      fi`,
  renderProxyDisconnect: opencodeProxyDisconnect,
  windows: {
    mcpDisconnect: `      if ($archRealExe) { try { & $archRealExe.Source mcp logout $McpServerName 2>$null | Out-Null } catch { } }
${opencodeWindowsStrip("mcp", "$McpServerName")}`,
    skillsDisconnect: `      if ($SkillsMarketplaceName) { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path ${opencodeConfigDirPs()} ('skills/' + $SkillsMarketplaceName)) }`,
    skillsRefreshCommands: `  $archOcSkills = Join-Path ${opencodeConfigDirPs()} ('skills/' + $ArchRefreshMarketplace)
  if (-not (Test-Path (Join-Path $archOcSkills '.git'))) { return $true }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return $false }
  try { & git -C $archOcSkills pull --ff-only -q 2>$null | Out-Null } catch { return $false }
  if ($LASTEXITCODE -ne 0) { return $false }`,
    mcpDisconnectVerify: opencodeWindowsVerifyGone("mcp", "$McpServerName"),
    skillsDisconnectVerify: `    $archOcSkills = Join-Path ${opencodeConfigDirPs()} ('skills/' + $SkillsMarketplaceName)
    if ($SkillsMarketplaceName -and (Test-Path $archOcSkills)) {
      $Script:ArchDisconnectReason = $archOcSkills + ' is still there — delete it yourself.'
      return $false
    }`,
    renderProxyDisconnect: opencodeWindowsProxyDisconnect,
    proxyDisconnectNote: (ctx) =>
      ctx.proxy?.authMode === "provider-key"
        ? `Removed ${ctx.appName} route overrides from supported OpenCode providers. Local authentication and model selection were preserved.`
        : `Removed the ${ctx.appName} provider settings from opencode.json. Local provider authentication was preserved.`,
  },
};

function opencodePassthroughRoutes(
  ctx: StartupGuardContext,
): Record<string, string> {
  const providerSuffix = ctx.proxy?.provider ? `/${ctx.proxy.provider}` : "";
  const rawUrl = ctx.proxy?.url ?? "";
  const stripped = Boolean(providerSuffix) && rawUrl.endsWith(providerSuffix);
  if (providerSuffix && rawUrl && !stripped) {
    logger.warn(
      { provider: ctx.proxy?.provider, proxyUrl: rawUrl },
      "OpenCode passthrough proxy URL does not end with the provider suffix; using the full URL as the route base",
    );
  }
  const baseUrl = stripped ? rawUrl.slice(0, -providerSuffix.length) : rawUrl;
  return Object.fromEntries(
    OPENCODE_PASSTHROUGH_PROVIDER_ROUTES.map((route) => [
      route.openCodeProviderId,
      openCodePassthroughBaseUrl(baseUrl, route),
    ]),
  );
}

function opencodeManagedHeaders(
  ctx: StartupGuardContext,
): Record<string, string> {
  const headers: Record<string, string> = {
    [EXTERNAL_AGENT_ID_HEADER]: "opencode",
  };
  if (ctx.proxy?.passthroughVirtualKey) {
    headers[VIRTUAL_KEY_HEADER] = ctx.proxy.passthroughVirtualKey;
  }
  return headers;
}
