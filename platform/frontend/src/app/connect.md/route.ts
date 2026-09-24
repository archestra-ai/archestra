import { requestOrigin } from "@/lib/request-origin";

export function GET(request: Request) {
  const origin = requestOrigin(request);
  return new Response(
    `# Connect This Client

Connect the coding client running this conversation to ${origin}.
No preinstalled skill or platform credentials are needed to start.

## Requirements

The terminal needs Node.js 18 or newer and access to this deployment.
Supported clients: claude-code, claude-desktop, cursor, codex, copilot-cli, opencode.
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

1. Run exactly one command below in the terminal. Replace CLIENT_ID with the
   current client ID.
   macOS/Linux:
   p="$(mktemp)"; trap 'rm -f "$p"' EXIT; curl --fail --silent --show-error ${origin}/api/client-connections/installer --output "$p" && node "$p" --url ${origin} --client CLIENT_ID
   Windows PowerShell:
   $p=[IO.Path]::GetTempFileName(); try { Invoke-WebRequest -UseBasicParsing -Uri ${origin}/api/client-connections/installer -OutFile $p; node $p --url ${origin} --client CLIENT_ID } finally { Remove-Item $p -Force -ErrorAction SilentlyContinue }
2. The public bootstrap validates the deployment URL, starts a browser approval,
   then downloads and applies only the setup the user reviewed. If your security
   policy requires local source review, summarize the result without pasting the
   source into the conversation unless the user asks for it.
3. Keep the command running while the user signs in and approves in their browser.
   It reports approval, download size, and setup progress. If it fails, report
   the exact error and stop instead of replacing the flow with manual API calls.
   OpenCode: run the installer here with a timeout of 600000 ms. Keep that exact
   process running. Relay its approval URL and code if no browser opens. Do
   not start a second installer while the first request is pending.
   For Desktop, the separate terminal owns this process; finish the agent task after handoff.
   The browser code must match the code printed in the terminal.
   If no browser opens, show the printed approval URL to the user.
4. The installer applies the approved configuration automatically.
   If the organization has runtime handoff instructions enabled, the setup also
   installs a system-prompt file injected into every future session launch —
   tell the user plainly; the client itself does not make that obvious.
5. Follow the setup output to reload the client and finish its native MCP OAuth sign-in.
   Claude Code only registers the gateway in a NEW session, so never send the
   user to /mcp here. OpenCode's separate CLI can read the updated config now.
   Claude Code: in the new session, open /mcp, select the configured server, and authenticate.
   Cursor: use its MCP settings to connect/authenticate the configured server.
   Codex: use codex mcp login SERVER_NAME.
   OpenCode: run opencode mcp list first. If SERVER_NAME is connected (OAuth),
   skip authentication; do not re-authenticate a working connection. Otherwise
   run opencode mcp auth list. If SERVER_NAME is authenticated but not connected,
   report the connection error instead of forcing another OAuth flow.
   If authentication is missing or expired, run opencode mcp auth SERVER_NAME
   here with a timeout of 600000 ms and CI=true for this process. On macOS/Linux:
   CI=true opencode mcp auth SERVER_NAME
   On PowerShell:
   $previousCI=$env:CI; $env:CI='true'; try { opencode mcp auth SERVER_NAME } finally { $env:CI=$previousCI }
   CI=true keeps the OAuth URL visible in captured output instead of filling it
   with spinner frames. Keep the process running while the user completes browser
   consent. If no browser opens, relay the printed URL immediately. Explain that
   this URL is the gateway's native MCP OAuth consent, not another connection approval.
   If no URL appears within 60 seconds, interrupt the command and report the
   error; do not pipe a confirmation answer or start another auth. Then run
   opencode mcp list and confirm the gateway is connected.
   Let the user complete any browser consent or client execution approval.
   Then close with one short, imperative user instruction and nothing else, e.g.:
   "Open a new terminal, then run claude /mcp and select <server> to sign in."
   OpenCode: "Close every OpenCode process, then start opencode again."
6. Verify the configured gateway can list tools before reporting a working connection —
   in the new session, after authentication. OpenCode can check its connection
   now with opencode mcp list, but must restart to load new tools.
   Configuration applied alone does not prove MCP authentication succeeded.
   For clients requiring a new session, verification is that session's job.
7. For other clients, delete the temporary bootstrap file when finished.
   For Desktop, leave this public temporary file in place and end the task after handoff.

Never ask the user to paste passwords, session cookies, or tokens into this conversation.
Do not print the polling secret, installer source, or approved setup payload.
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
