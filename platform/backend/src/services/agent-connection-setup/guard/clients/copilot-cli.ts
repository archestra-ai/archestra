// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these files build bash/PowerShell source as JS strings, so `${VAR}` is shell
// parameter expansion for the emitted script, not a JS template placeholder

import {
  COPILOT_PROVIDER_ENV_KEYS,
  STARTUP_GUARD_INSTALL,
} from "@archestra/shared";
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
      "Removed the COPILOT_PROVIDER_* environment variables (User scope and this session). Open a new terminal for the change to fully take effect.",
  },
};

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
