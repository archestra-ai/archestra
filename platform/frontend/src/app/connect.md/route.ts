import { requestOrigin } from "@/lib/request-origin";

export function GET(request: Request) {
  const origin = requestOrigin(request);
  return new Response(
    `# Connect This Client

Connect the coding client running this conversation to ${origin}.
No preinstalled skill or platform credentials are needed to start.

## Requirements

The terminal needs Node.js 18 or newer and access to this deployment.
Supported clients: claude-code, claude-desktop, cursor, codex, copilot-cli.
Supported operating systems: macOS, Linux, Windows.
Ask which client to configure only if the current client is unknown.

## Claude Desktop

In Claude Desktop's Cowork or Code tab, use client ID claude-desktop, not claude-code.
For the simplest setup, direct the user to ${origin}/connection?clientId=claude-desktop.
They review the setup, download the installer, and open it in normal Claude Desktop.
Desktop's native Install confirmation starts the setup in a separate OS terminal.
The installer reuses a valid local subscription token, or opens Claude sign-in if needed.
It checks inference before changing configuration and restarting Desktop.
The download contains an expiring one-time setup ticket, not the user's subscription token.
This is a direct user installation; do not try to launch it through a denied Cowork action.
If Desktop is already using a third-party inference profile, use the page's terminal option.

Cowork's code-execution terminal runs in a VM or cloud sandbox, not the host computer.
Do not install into that environment or treat its Linux platform as the user's OS.
A localhost deployment must be accessed from the user's host computer or browser.
If the user chooses agent-driven terminal setup instead, it requires permitted host-terminal access.
Follow the client's normal approval flow. Do not disable sandboxing or retry a denied action through another tool.
The bootstrap opens a separate OS terminal. After handoff, end the task immediately:
do not run cleanup, polling, or verification while waiting for Desktop to restart.
After installation, authorize the gateway under Settings > Connectors and install shared skills
under Settings > Plugins. Verify a fresh message appears in LLM Proxy Logs.

## Setup

1. Download ${origin}/api/client-connections/installer to a temporary file named connect.cjs.
2. Inspect it, then run: node /path/to/connect.cjs --url ${origin} --client CLIENT_ID
3. Keep the process running while the user signs in and approves in their browser.
   For Desktop, the separate terminal owns this process; finish the agent task after handoff.
   The browser code must match the code printed in the terminal.
   If no browser opens, show the printed approval URL to the user.
4. The installer applies the approved configuration automatically.
5. Follow the setup output to reload the client and finish its native MCP OAuth sign-in.
   Claude Code: open /mcp, select the configured server, and authenticate.
   Cursor: use its MCP settings to connect/authenticate the configured server.
   Codex: use codex mcp login SERVER_NAME.
   Let the user complete any browser consent or client execution approval.
6. Verify the configured gateway can list tools before reporting a working connection.
   Configuration applied alone does not prove MCP authentication succeeded.
7. For other clients, delete the temporary bootstrap file when finished.
   For Desktop, leave this public temporary file in place and end the task after handoff.

Never ask the user to paste passwords, session cookies, or tokens into this conversation.
Do not print the polling secret or the downloaded setup script: it may contain credentials.
The approval request expires after ten minutes. Denial or expiry requires a new run.
Use --no-open if the terminal cannot open a browser; the URL is still printed.
The installer changes the selected client's configuration using the existing setup script.
Review its output for backup paths and restart instructions.
`,
    {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}
