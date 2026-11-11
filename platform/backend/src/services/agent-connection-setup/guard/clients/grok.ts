import { STARTUP_GUARD_INSTALL } from "@archestra/shared/consts";
import type { StartupGuardClient } from "../startup-guard";

const disconnect = 'node "$HOME/.archestra/grok/disconnect.cjs"';
const verify =
  '[ ! -f "$HOME/.archestra/grok/connection.json" ] || { printf "%s\\n" "Grok remains connected. Resolve the disconnect error before retrying."; return 1; }';
const windowsDisconnect =
  "& node (Join-Path $env:USERPROFILE '.archestra/grok/disconnect.cjs')";
const windowsVerify =
  "if (Test-Path (Join-Path $env:USERPROFILE '.archestra/grok/connection.json')) { $Script:ArchDisconnectReason = 'Grok remains connected. Resolve the disconnect error before retrying.'; return $false }";

/** The shared screen delegates restoration to Grok's managed transaction. */
export const GROK_GUARD_CLIENT: StartupGuardClient = {
  clientId: "grok-build",
  binary: "grok",
  label: "Grok",
  promptName: "Grok",
  disableEnvVar: "ARCHESTRA_GROK_GUARD",
  ...STARTUP_GUARD_INSTALL["grok-build"],
  atomicDisconnect: true,
  proxyCheckLabel: "LLM proxy routing",
  disconnectNote:
    "Proxy admission is verified by the first governed reply.\nDisconnecting any row restores the whole Grok connection.",
  nonInteractiveArgPatterns: [
    "-p*",
    "-q",
    "--print*",
    "--json*",
    "--quiet*",
    "--headless*",
    "--output-format*",
    "--sync",
    "--single*",
    "--prompt-json*",
    "--prompt-file*",
    "agent",
  ],
  utilitySubcommands: ["inspect", "login", "--help", "-h", "--version", "-v"],
  mcpDisconnectCommands: disconnect,
  skillsDisconnectCommands: disconnect,
  mcpDisconnectVerify: verify,
  skillsDisconnectVerify: verify,
  proxyDisconnectVerify: verify,
  renderProxyDisconnect: () =>
    `disconnect_proxy() { ${disconnect}; }\nproxy_disconnect_notes() { :; }`,
  windows: {
    mcpDisconnect: windowsDisconnect,
    skillsDisconnect: windowsDisconnect,
    mcpDisconnectVerify: windowsVerify,
    skillsDisconnectVerify: windowsVerify,
    proxyDisconnectVerify: windowsVerify,
    renderProxyDisconnect: () =>
      `function Disconnect-ArchProxy { ${windowsDisconnect} }`,
    proxyDisconnectNote: () => "Open a fresh terminal to start ordinary Grok.",
  },
};
