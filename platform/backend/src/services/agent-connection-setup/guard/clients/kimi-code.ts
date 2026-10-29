import { STARTUP_GUARD_INSTALL } from "@archestra/shared";
import type { StartupGuardClient } from "../startup-guard";

const disconnect = `if [ -f "$HOME/.archestra/kimi-code/lifecycle.cjs" ]; then node "$HOME/.archestra/kimi-code/lifecycle.cjs" disconnect; fi`;
const verify = `if [ -f "$HOME/.archestra/kimi-code/state.json" ]; then printf '%s\\n' 'Kimi Code remains connected. Run: node ~/.archestra/kimi-code/lifecycle.cjs disconnect'; return 1; fi`;
const windowsDisconnect = `if (Test-Path (Join-Path $env:USERPROFILE '.archestra/kimi-code/lifecycle.cjs')) { & node (Join-Path $env:USERPROFILE '.archestra/kimi-code/lifecycle.cjs') disconnect }`;
const windowsVerify = `if (Test-Path (Join-Path $env:USERPROFILE '.archestra/kimi-code/state.json')) { $Script:ArchDisconnectReason = 'Kimi Code remains connected. Run: node "$HOME\\.archestra\\kimi-code\\lifecycle.cjs" disconnect'; return $false }`;
// The connection's own skills checkout; a non-zero exit retries next launch.
const refreshSkills = `  node "$HOME/.archestra/kimi-code/lifecycle.cjs" refresh-skills </dev/null >/dev/null 2>&1 || return 1`;
const windowsRefreshSkills = `  & node (Join-Path $env:USERPROFILE '.archestra/kimi-code/lifecycle.cjs') refresh-skills 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { return $false }`;
const proxyNote =
  "Open a new terminal and run kimi. Your other providers, MCP servers and shared skills were kept.";

/**
 * Kimi Code's model routing, gateway and skills are one connection: the
 * guardrails depend on the proxy and the gateway together, so disconnecting
 * any of them removes the whole connection. Every row runs the same helper,
 * which finds nothing left after the first, and the guard then removes
 * itself and its shell profile blocks.
 */
export const KIMI_CODE_GUARD_CLIENT: StartupGuardClient = {
  clientId: "kimi-code",
  binary: "kimi",
  label: "Kimi Code",
  promptName: "Kimi Code",
  disableEnvVar: "ARCHESTRA_KIMI_CODE_GUARD",
  ...STARTUP_GUARD_INSTALL["kimi-code"],
  // Print mode, and the ACP and web servers, have no terminal to draw in.
  nonInteractiveArgPatterns: [
    "-p",
    "--prompt",
    "--prompt=*",
    "acp",
    "web",
    "server",
    "rc",
    "remote",
  ],
  utilitySubcommands: [
    "export",
    "fork",
    "provider",
    "session",
    "login",
    "doctor",
    "vis",
    "install-desktop",
    "app",
    "migrate",
    "upgrade",
    "update",
    "help",
    "--help",
    "-h",
    "--version",
    "-V",
  ],
  disconnectNote:
    "Disconnecting any row removes the whole Kimi Code connection. Reconnect from the Connect page.",
  mcpDisconnectCommands: disconnect,
  skillsDisconnectCommands: disconnect,
  skillsRefreshCommands: refreshSkills,
  mcpDisconnectVerify: verify,
  skillsDisconnectVerify: verify,
  proxyDisconnectVerify: verify,
  renderProxyDisconnect: () => `disconnect_proxy() { ${disconnect}; }
proxy_disconnect_notes() { printf '%s\\n' '${proxyNote}'; }`,
  windows: {
    mcpDisconnect: windowsDisconnect,
    skillsDisconnect: windowsDisconnect,
    skillsRefreshCommands: windowsRefreshSkills,
    mcpDisconnectVerify: windowsVerify,
    skillsDisconnectVerify: windowsVerify,
    proxyDisconnectVerify: windowsVerify,
    renderProxyDisconnect: () =>
      `function Disconnect-ArchProxy { ${windowsDisconnect} }`,
    proxyDisconnectNote: () => proxyNote,
  },
};
