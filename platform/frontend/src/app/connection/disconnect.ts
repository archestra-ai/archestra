import {
  CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY,
  CLAUDE_CODE_GUARD_MARKER_END,
  CLAUDE_CODE_GUARD_MARKER_START,
  CLAUDE_CODE_GUARD_PS_SCRIPT_RELPATH,
  CLAUDE_CODE_GUARD_SCRIPT_RELPATH,
  CLAUDE_CODE_GUARD_SKIP_RELPATH,
  CLAUDE_CODE_PROXY_ENV_KEYS,
} from "@archestra/shared";

/**
 * The reverse of the connect flow: how to detach a client from the MCP gateway
 * and the LLM proxy. Every step is a LOCAL change to the client's own config,
 * so disconnecting works even when the proxy or the platform is unreachable —
 * which is the whole point of having a disconnect path.
 */

export interface DisconnectStep {
  title: string;
  /** Plain-text guidance for manual (config-file / GUI) steps. */
  body?: string;
  /** A copyable command rendered in a terminal block. */
  command?: string;
}

export function getDisconnectSteps(
  clientId: string,
  params: { serverName: string; appName: string },
): DisconnectStep[] {
  const { serverName, appName } = params;

  switch (clientId) {
    case "claude-code":
      return [
        {
          title: "Remove the MCP gateway",
          command: `claude mcp remove ${serverName}`,
        },
        {
          title: "Remove the proxy base URL",
          body: `Delete the ${CLAUDE_CODE_PROXY_ENV_KEYS.anthropic.join(" and ")} lines from the env block in ~/.claude/settings.json — plus ${CLAUDE_CODE_PROXY_ENV_KEYS.bedrock.join(", ")} if you set up Bedrock, and the ${appName} lines in ${CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY}. Restart Claude Code.`,
        },
        {
          title: "Remove the startup guard (macOS/Linux)",
          body: `Deletes the pre-loader script and the claude() wrapper the connect script added to your shell profile. Open a new terminal afterward.`,
          command: `for f in ~/.zshrc ~/.bashrc; do [ -f "$f" ] && sed -i.bak '/^${CLAUDE_CODE_GUARD_MARKER_START}$/,/^${CLAUDE_CODE_GUARD_MARKER_END}$/d' "$f"; done; rm -f ~/${CLAUDE_CODE_GUARD_SCRIPT_RELPATH} ~/${CLAUDE_CODE_GUARD_SKIP_RELPATH}`,
        },
        {
          title: "Remove the startup guard (Windows)",
          body: `Deletes the pre-loader script and the claude wrapper the connect script added to your PowerShell profiles. Open a new PowerShell session afterward.`,
          command: `$s='${CLAUDE_CODE_GUARD_MARKER_START}';$e='${CLAUDE_CODE_GUARD_MARKER_END}';foreach($d in @('WindowsPowerShell','PowerShell')){$f=Join-Path (Join-Path ([Environment]::GetFolderPath('MyDocuments')) $d) 'profile.ps1';if(Test-Path $f){$k=$true;Set-Content $f @(Get-Content $f|Where-Object{if($_-eq$s){$k=$false};$r=$k;if($_-eq$e){$k=$true;$r=$false};$r})}};Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $env:USERPROFILE '${CLAUDE_CODE_GUARD_PS_SCRIPT_RELPATH}'),(Join-Path $env:USERPROFILE '${CLAUDE_CODE_GUARD_SKIP_RELPATH}')`,
        },
      ];
    case "cursor":
      return [
        {
          title: "Remove the MCP gateway",
          body: `Open Cursor Settings → MCP and remove the ${serverName} server, or delete its entry from ~/.cursor/mcp.json.`,
        },
        {
          title: "Revert the proxy",
          body: `Remove the ${appName} base URL override you added under Cursor's model settings.`,
        },
      ];
    case "codex":
      return [
        {
          title: "Remove the MCP gateway",
          command: `codex mcp remove ${serverName}`,
        },
        {
          title: "Revert the proxy provider",
          body: `Remove the ${appName} provider block you added to ~/.codex/config.toml.`,
        },
      ];
    case "copilot-cli":
      return [
        {
          title: "Remove the MCP gateway",
          command: `copilot mcp remove ${serverName}`,
        },
        {
          title: "Unset the proxy base URL",
          command: `unset COPILOT_PROVIDER_BASE_URL`,
        },
        {
          title: "Clean your shell profile",
          body: `Delete the export COPILOT_PROVIDER_BASE_URL line from your shell profile so it does not come back on the next session.`,
        },
      ];
    case "claude-desktop":
      return [
        {
          title: "Remove the MCP gateway",
          body: `Delete the ${serverName} entry from the mcpServers block in claude_desktop_config.json, then restart Claude Desktop.`,
        },
        {
          title: "Revert the proxy",
          body: `Remove the ${appName} custom headers and base URL you added for inference.`,
        },
      ];
    case "n8n":
      return [
        {
          title: "Remove the MCP gateway",
          body: `Delete the ${appName} MCP node and its gateway credential from your n8n workflow.`,
        },
        {
          title: "Revert the proxy",
          body: `Remove the ${appName} base URL and API key from the n8n LLM credential.`,
        },
      ];
    default:
      return [
        {
          title: "Remove the MCP gateway",
          body: `Remove the ${serverName} MCP server from your client's configuration.`,
        },
        {
          title: "Revert the proxy",
          body: `Point the client's model base URL back at the provider's default instead of ${appName}.`,
        },
      ];
  }
}
