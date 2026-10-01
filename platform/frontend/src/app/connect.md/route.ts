import { requestOrigin } from "@/lib/request-origin";

export function GET(request: Request) {
  const origin = requestOrigin(request);
  const client = new URL(request.url).searchParams.get("client");
  const focused = client ? focusedInstructions(origin, client) : null;
  return new Response(
    focused ??
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
under Settings > Plugins. Send a message to make sure that inference works.

## Setup

1. Run exactly one command below in the terminal. Replace CLIENT_ID with the
   current client ID.
   macOS/Linux:
   p="$(mktemp)"; trap 'unlink "$p"' EXIT; curl --fail --silent --show-error ${origin}/api/client-connections/installer --output "$p" && node "$p" --url ${origin} --client CLIENT_ID
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
   Cursor: open Customize > MCPs to connect/authenticate the configured server.
   If the setup installed shared skills, reload Cursor and verify them under
   Customize > Skills. Cursor reads nested skills from ~/.cursor/skills/.
   If the proxy was selected, find "Cursor model settings (manual step)" in the
   installer output. It prints the proxy URL and either a virtual key or an
   instruction to use the user's own OpenAI API key. Tell the user where to find
   these values in the terminal; do not quote a secret key in chat. In Cursor
   Settings > Models > API Keys, enter them and enable Use OpenAI API Key and
   Override OpenAI Base URL.
   A Cursor subscription cannot authenticate the proxy. Send a test prompt in
   Cursor and confirm the request appears in this deployment before reporting success.
   Codex: ${CODEX_FINISH_INSTRUCTIONS}
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
   Cursor: installation alone is not a complete connection. If native OAuth,
   the skills check, or proxy inference remain unverified, say so explicitly.
   List the remaining steps from the setup output, including any manual User
   Rules and model settings. Ask the user to enter the printed virtual key or
   their own OpenAI API key in Cursor Settings; never ask for the key in chat.
   Do not claim the proxy is configured
   merely because the installer printed its settings.
   For other clients, close with one short, imperative user instruction, e.g.:
   "Open a new terminal, then run claude /mcp and select <server> to sign in."
   OpenCode: "Close every OpenCode process, then start opencode again."
6. Verify the configured gateway can list tools before reporting a working connection —
   in the new session, after authentication. OpenCode can check its connection
   now with opencode mcp list, but must restart to load new tools.
   Configuration applied alone does not prove MCP authentication succeeded.
   For clients requiring a new session, verification is that session's job.
   Codex: perform the fresh-process verification above from this conversation's
   terminal; do not defer it to a future user session. Gateway OAuth alone does
   not prove proxy inference or tool execution. A protected-session mark alone
   is not a complete verification either.
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

function focusedInstructions(origin: string, client: string): string | null {
  if (client === "claude-desktop") {
    return `# Connect Claude Desktop

In Claude Desktop's Cowork or Code tab, use client ID claude-desktop, not claude-code.
Direct the user to ${origin}/connection?clientId=claude-desktop to review and download the installer.
They open it in normal Claude Desktop; its native Install confirmation starts setup in a separate OS terminal.
The installer reuses a valid local subscription token, or opens Claude sign-in if needed.
It checks inference before changing configuration and restarting Desktop.

Cowork's code-execution terminal runs in a VM or cloud sandbox, not the host computer.
Do not install into that environment. A localhost deployment must be accessed from the user's host computer or browser.
Do not retry a denied action through another tool. After handoff, end the task without polling or cleanup.
After installation, the user authorizes the gateway under Settings > Connectors and installs shared skills under Settings > Plugins.
Do not ask the user to paste passwords, session cookies, or tokens into this conversation.
`;
  }

  const details = focusedClientDetails(client);
  if (!details) return null;

  return `# Connect ${details.label}

Connect the client running this conversation to ${origin}.
Use client ID ${client}. No preinstalled skill or platform credentials are needed.
The terminal needs Node.js 18 or newer and access to this deployment.
If a localhost page cannot be fetched through a web tool, use the local terminal.

## Setup

Run exactly one command in the client's terminal.
macOS/Linux:
p="$(mktemp)"; trap 'unlink "$p"' EXIT; curl --fail --silent --show-error ${origin}/api/client-connections/installer --output "$p" && node "$p" --url ${origin} --client ${client}
Windows PowerShell:
$p=[IO.Path]::GetTempFileName(); try { Invoke-WebRequest -UseBasicParsing -Uri ${origin}/api/client-connections/installer -OutFile $p; node $p --url ${origin} --client ${client} } finally { Remove-Item $p -Force -ErrorAction SilentlyContinue }

Keep the command running while the user signs in and reviews the setup in their browser.
The browser code must match the code printed in the terminal. If no browser opens, show the printed approval URL.
The public bootstrap downloads and applies only the approved setup. If it fails, report the exact error; do not replace this flow with manual API calls.
Do not print the polling secret, installer source, or approved setup payload.
If runtime handoff instructions are enabled, tell the user that future sessions inject a system-prompt file.

## Finish and verify

${details.finish}

Do not claim the connection works until its gateway and any selected model proxy have been verified.
Never ask the user to paste passwords, session cookies, or provider keys into this conversation.
The approval request expires after ten minutes. Denial or expiry requires a new run.
`;
}

function focusedClientDetails(client: string): {
  label: string;
  finish: string;
} | null {
  switch (client) {
    case "claude-code":
      return {
        label: "Claude Code",
        finish:
          "Open a new Claude Code session so the gateway registers. In that new session, open /mcp, select the configured server, and authenticate. Verify that it lists tools. Follow the setup output for model proxy settings; send a short test prompt before reporting inference as working.",
      };
    case "cursor":
      return {
        label: "Cursor",
        finish:
          "Reload Cursor. Open Customize > MCPs, authenticate the configured gateway, and verify it lists tools. Confirm installed shared skills under Customize > Skills. Cursor discovers nested skills in ~/.cursor/skills/. If runtime handoff User Rules were printed, ask the user to paste them under Customize > Rules > User Rules without replacing existing rules. If the model proxy was selected, find 'Cursor model settings (manual step)' in the installer output. Tell the user where to find the printed proxy URL and, for virtual-key setup, the printed virtual key; otherwise they need their own OpenAI API key. Do not quote a secret key in chat. Ask the user to enter these values under Settings > Models > API Keys, then enable Use OpenAI API Key and Override OpenAI Base URL. A Cursor subscription cannot authenticate the proxy. Send a test prompt and confirm the request appears in this deployment. Installation alone does not complete these native steps; state exactly which checks remain unverified.",
      };
    case "codex":
      return {
        label: "Codex",
        finish: CODEX_FINISH_INSTRUCTIONS,
      };
    case "copilot-cli":
      return {
        label: "Copilot CLI",
        finish:
          "Follow the setup output to restart Copilot CLI and complete native gateway OAuth. Verify that the gateway lists tools. If a model proxy was selected, send a short prompt and verify that inference reaches this deployment.",
      };
    case "opencode":
      return {
        label: "OpenCode",
        finish:
          "Run opencode mcp list. If SERVER_NAME is connected, skip authentication. Otherwise run opencode mcp auth list; if authentication is missing or expired, run CI=true opencode mcp auth SERVER_NAME and keep the process running while the user completes native OAuth consent. Do not start a second auth process while one is pending. Run opencode mcp list again, then close every OpenCode process and restart it to load new tools. Verify the gateway and any selected model proxy before reporting success.",
      };
    default:
      return null;
  }
}

const CODEX_FINISH_INSTRUCTIONS = [
  "If the installer printed 'Successfully logged in.', gateway OAuth is already cached. Do not run codex mcp login again. Otherwise run codex mcp list --json and inspect auth_status for the configured server. If auth_status is oauth, skip login. Only if it is not_logged_in, run codex mcp login SERVER_NAME once. Wait for its browser callback. For unknown or unsupported auth status, use verification to check cached authorization instead of repeating login. Do not start another login while one is pending.",
  "If a gateway or proxy was selected, run the exact Verification command printed by the installer yourself. Do not ask the user to run verification commands. On Windows use the printed native PowerShell verifier, not the Node --verify command. The helper starts a fresh native Codex app-server and calls a read-only gateway tool directly. It checks proxy inference with the configured model, approval mode and sandbox unchanged.",
  "Do not substitute codex exec or a model-driven shell probe. Do not force --sandbox read-only, edit config, or change the configured model, sandbox or approval settings. If the OS blocks process launch or access to Codex state files, request ordinary native per-command approval. Request approval only for this exact verification command, then retry once. If approval is unavailable, report the blocker instead of weakening the sandbox. Do not request elevated execution for API authentication or gateway authorization errors. The verifier must never auto-approve app-server permission requests.",
  "Empty MCP resource lists and tools/list are not gateway execution checks. Report success only when the helper returns verified for each selected gateway/proxy. A failed or interrupted verifier is incomplete, even when installation or OAuth succeeded. If skills were selected, verify the marketplace/plugins are registered. Report the connection status briefly without listing tool names or quoting the test response.",
].join(" ");
