// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these files build bash/PowerShell source as JS strings, so `${VAR}` is shell
// parameter expansion for the emitted script, not a JS template placeholder

import {
  COPILOT_PROVIDER_ENV_KEYS,
  STARTUP_GUARD_INSTALL,
} from "@archestra/shared";
import { COPILOT_PROVIDER_CONFIG_NODE } from "../../payloads/copilot-provider-config";
import { psq, sh } from "../../steps/quoting";
import type { StartupGuardClient, StartupGuardContext } from "../startup-guard";
import { jsonMemberGoneVerify, windowsJsonMemberGoneVerify } from "./verify";

export const COPILOT_GUARD_CLIENT: StartupGuardClient = {
  clientId: "copilot-cli",
  binary: "copilot",
  label: "Copilot CLI",
  promptName: "Copilot",
  disableEnvVar: "ARCHESTRA_COPILOT_GUARD",
  ...STARTUP_GUARD_INSTALL["copilot-cli"],
  // Copilot CLI's non-interactive one-shot flag.
  nonInteractiveArgPatterns: ["-p", "--prompt"],
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
    "completion",
    "completions",
    "config",
    "login",
    "logout",
    "help",
  ],
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
      "Removed the managed provider and model from providers.json and the saved COPILOT_PROVIDER_* environment variables. Open a new terminal for the change to fully take effect.",
  },
};

/** Remove our native registry entries and exports left by earlier setups. */
function copilotProxyDisconnect(ctx: StartupGuardContext): string {
  return `disconnect_proxy() {
  if ! command -v node >/dev/null 2>&1; then
    printf '%s\\n' 'Node.js is required to remove the saved Copilot provider settings.' >&2
    return 1
  fi
  ARCHESTRA_COPILOT_ACTION=remove ARCHESTRA_COPILOT_CONFIG=${sh(JSON.stringify({ url: ctx.proxy?.url }))} node <<'ARCHESTRA_COPILOT_REMOVE' || return 1
${COPILOT_PROVIDER_CONFIG_NODE}
ARCHESTRA_COPILOT_REMOVE
  archestra_copilot_exports=${sh(`^[[:space:]]*(export[[:space:]]+COPILOT_PROVIDER_(TYPE|BASE_URL|API_KEY|HEADERS)=|set[[:space:]]+-gx[[:space:]]+COPILOT_PROVIDER_(TYPE|BASE_URL|API_KEY|HEADERS)[[:space:]]|export[[:space:]]+COPILOT_MODEL=['"]?archestra/|set[[:space:]]+-gx[[:space:]]+COPILOT_MODEL[[:space:]]+['"]?archestra/)`)}
  for profile in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile" "$HOME/.bash_profile" "$HOME/.bash_login" "\${ZDOTDIR:-$HOME}/.zshrc" "\${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish" "\${XDG_CONFIG_HOME:-$HOME/.config}"/fish/conf.d/*.fish; do
    [ -f "$profile" ] || continue
    grep -Eq "$archestra_copilot_exports" "$profile" || continue
    awk -v pattern="$archestra_copilot_exports" '$0 !~ pattern { print }' "$profile" > "$profile.archestra-tmp" && cat "$profile.archestra-tmp" > "$profile" && rm "$profile.archestra-tmp" || return 1
  done
}

proxy_disconnect_notes() {
  line_reset
  printf '%s  Removed the managed provider and model from providers.json and any COPILOT_PROVIDER_* export lines — open a new terminal so the change takes effect.%s\\n' "$C_DIM" "$C_RESET"
  return 0
}`;
}

/** Remove native settings and the environment settings left by older setup. */
function copilotWindowsProxyDisconnect(ctx: StartupGuardContext): string {
  const names = [
    COPILOT_PROVIDER_ENV_KEYS.type,
    COPILOT_PROVIDER_ENV_KEYS.baseUrl,
    COPILOT_PROVIDER_ENV_KEYS.apiKey,
    COPILOT_PROVIDER_ENV_KEYS.headers,
  ]
    .map((n) => `'${n}'`)
    .join(", ");
  return `function Disconnect-ArchProxy {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is required to remove the saved Copilot provider settings.' }
  $env:ARCHESTRA_COPILOT_ACTION = 'remove'
  $env:ARCHESTRA_COPILOT_CONFIG = ${psq(JSON.stringify({ url: ctx.proxy?.url }))}
  try {
    [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psq(Buffer.from(COPILOT_PROVIDER_CONFIG_NODE).toString("base64"))})) | node
    if ($LASTEXITCODE -ne 0) { throw 'Could not remove Copilot provider settings.' }
  } finally {
    Remove-Item Env:ARCHESTRA_COPILOT_ACTION, Env:ARCHESTRA_COPILOT_CONFIG -ErrorAction SilentlyContinue
  }
  foreach ($scope in @('Process', 'User')) {
    $model = [Environment]::GetEnvironmentVariable('COPILOT_MODEL', $scope)
    if ($model -and $model.StartsWith('archestra/', [StringComparison]::Ordinal)) {
      [Environment]::SetEnvironmentVariable('COPILOT_MODEL', $null, $scope)
    }
  }
  foreach ($n in @(${names})) {
    try { [Environment]::SetEnvironmentVariable($n, $null, 'User') } catch { }
    try { Remove-Item -Path ('Env:' + $n) -ErrorAction SilentlyContinue } catch { }
  }
}`;
}
