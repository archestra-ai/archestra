// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these files build bash/PowerShell source as JS strings, so `${VAR}` is shell
// parameter expansion for the emitted script, not a JS template placeholder

import {
  ARCHESTRA_TOKEN_PREFIX,
  STARTUP_GUARD_INSTALL,
} from "@archestra/shared";
import { psq, sh } from "../../steps/quoting";
import type { StartupGuardClient, StartupGuardContext } from "../startup-guard";

export const CODEX_GUARD_CLIENT: StartupGuardClient = {
  clientId: "codex",
  binary: "codex",
  label: "Codex",
  promptName: "Codex",
  disableEnvVar: "ARCHESTRA_CODEX_GUARD",
  ...STARTUP_GUARD_INSTALL.codex,
  // `codex exec …` is Codex's non-interactive one-shot subcommand.
  nonInteractiveArgPatterns: ["exec"],
  utilitySubcommands: [
    "mcp",
    "plugin",
    "plugins",
    "install",
    "uninstall",
    "update",
    "upgrade",
    "doctor",
    "completion",
    "completions",
    "config",
    "login",
    "logout",
    "features",
    "help",
  ],
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
  DIRECT_HELPER="$HOME/${CODEX_GUARD_CLIENT.scriptRelpath}.handoff.cjs"
  if [ -f "$DIRECT_HELPER" ]; then
    command -v node >/dev/null 2>&1 && node "$DIRECT_HELPER" --remove-direct || return 1
  elif [ -f "$CONFIG" ] && grep -q 'archestra:codex-direct:root' "$CONFIG"; then
    return 1
  fi
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
  $directHelper = $GuardPath + '.handoff.cjs'
  if (Test-Path $directHelper) {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Could not restore Codex direct tool settings.' }
    & node $directHelper --remove-direct
    if ($LASTEXITCODE -ne 0) { throw 'Could not restore Codex direct tool settings.' }
  } elseif ((Test-Path $path) -and (Select-String -Path $path -Pattern 'archestra:codex-direct:root' -Quiet)) {
    throw 'Codex direct tool settings remain without their restore helper.'
  }
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
