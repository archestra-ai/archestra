export function GET(request: Request) {
  const origin = new URL(request.url).origin;
  return new Response(
    `# Connect This Client

Connect the coding client running this conversation to ${origin}.
No preinstalled skill or platform credentials are needed to start.

## Requirements

The terminal needs Node.js 18 or newer and access to this deployment.
Supported clients: claude-code, cursor, codex, copilot-cli.
Supported operating systems: macOS, Linux, Windows.
Ask which client to configure only if the current client is unknown.

## Setup

1. Download ${origin}/api/client-connections/installer to a temporary file named connect.cjs.
2. Inspect it, then run: node /path/to/connect.cjs --url ${origin} --client CLIENT_ID
3. Keep the process running while the user signs in and approves in their browser.
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
7. Delete the temporary bootstrap file when finished.

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
