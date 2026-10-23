import { STARTUP_GUARD_INSTALL } from "@archestra/shared";
import type { StartupGuardClient } from "../startup-guard";

const disconnect = `if [ -f "$HOME/.archestra/pi/lifecycle.cjs" ]; then node "$HOME/.archestra/pi/lifecycle.cjs" disconnect; fi`;
const verify = `if [ -f "$HOME/.archestra/pi/connection.json" ]; then printf '%s\\n' 'Pi remains connected. Run arcpi --disconnect for recovery details.'; return 1; fi`;
const windowsDisconnect = `if (Test-Path (Join-Path $env:USERPROFILE '.archestra/pi/lifecycle.cjs')) { & node (Join-Path $env:USERPROFILE '.archestra/pi/lifecycle.cjs') disconnect }`;
const windowsVerify = `if (Test-Path (Join-Path $env:USERPROFILE '.archestra/pi/connection.json')) { $Script:ArchDisconnectReason = 'Pi remains connected. Run arcpi --disconnect for recovery details.'; return $false }`;

/** Pi's native guardrails require the proxy and gateway to remain connected together. */
export const PI_GUARD_CLIENT: StartupGuardClient = {
  clientId: "pi",
  atomicDisconnect: true,
  binary: "arcpi",
  label: "Pi",
  promptName: "Pi",
  disableEnvVar: "ARCHESTRA_PI_GUARD",
  ...STARTUP_GUARD_INSTALL.pi,
  nonInteractiveArgPatterns: ["-p", "--print", "--mode", "--mode=*"],
  utilitySubcommands: ["mcp", "--help", "-h", "--version", "-v"],
  proxyCheckLabel: "Proxy catalog/configuration",
  disconnectNote:
    "Upstream inference is not tested at startup.\nDisconnecting any row restores the whole Pi connection. Reconnect: arcpi --reconnect.",
  healthProbe: {
    bash: 'node "$HOME/.archestra/pi/lifecycle.cjs" check 2>/dev/null',
    powershell: `try {
    $Script:HealthBody = (& node (Join-Path $env:USERPROFILE '.archestra/pi/lifecycle.cjs') check 2>$null) -join ''
    return ($LASTEXITCODE -eq 0)
  } catch { return $false }`,
  },
  mcpDisconnectCommands: disconnect,
  skillsDisconnectCommands: disconnect,
  mcpDisconnectVerify: verify,
  skillsDisconnectVerify: verify,
  proxyDisconnectVerify: verify,
  renderProxyDisconnect: () => `disconnect_proxy() { ${disconnect}; }
proxy_disconnect_notes() { printf '%s\\n' 'Open a new terminal and run pi. Other clients and shared skills were preserved.'; }`,
  windows: {
    mcpDisconnect: windowsDisconnect,
    skillsDisconnect: windowsDisconnect,
    mcpDisconnectVerify: windowsVerify,
    skillsDisconnectVerify: windowsVerify,
    proxyDisconnectVerify: windowsVerify,
    renderProxyDisconnect: () =>
      `function Disconnect-ArchProxy { ${windowsDisconnect} }`,
    proxyDisconnectNote: () =>
      "Open a new terminal and run pi. Other clients and shared skills were preserved.",
  },
};
