---
title: Connect Your Agents
category: Archestra Platform
order: 8
description: How the one-command setup script connects your AI tools, and how to audit or undo it
lastUpdated: 2026-09-08
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

![The Connection page with Claude Code selected, showing the one-time setup command](/docs/automated_screenshots/platform-claude-code-example_connect-page.webp)

The Connection page lets you connect your local coding agent to Archestra with a single command. You pick the client — Claude Code, Codex, etc., and the page gives you a setup script to paste and run in your terminal.

On macOS and Linux the command is `curl -fsSL <url> | bash`. On Windows it is `irm <url> | iex`. Running it configures the client in place. Plugins declare whether they support macOS/Linux, Windows, or both; the review includes only plugins compatible with the selected operating system and names incompatible plugins that were skipped.

## Connect From Your Coding Client

![Browser approval with a matching terminal code](/docs/automated_screenshots/platform-connection_browser-approval.webp)

Give your coding agent this prompt, replacing the example hostname with your deployment:

> Read https://ai.example.com/connect.md and connect this client.

The public instructions need no installed skill or platform login.
They support Claude Code, Cursor, Codex, and Copilot CLI.
The terminal needs Node.js 18 or newer on macOS, Linux, or Windows.

The agent downloads a public bootstrap installer and starts a connection request.
Your browser opens the Connection page, preserving the requested client and operating system.
Sign in using your deployment's usual login or SSO.
Review the configuration and confirm that the browser code matches your terminal.
Approval releases the setup script to the waiting installer.
Denying the request prevents installation.

The installer uses the same configuration defaults and permissions as the Connection page.
It runs the existing setup script after approval.
Your coding client may ask permission before running downloaded code.

### Completing the Connection

Browser approval authorizes installation. MCP gateway authentication remains the client's native OAuth flow.
Follow the installer output to authenticate the gateway and reload your client.
Verify that the gateway can list tools before considering the connection complete.

Cursor still requires its model settings and marketplace steps inside the app.
See [Supported Clients](#supported-clients) for each client's remaining steps.
This flow does not automate those UI-only settings.

### Troubleshooting

- **No browser opens:** open the approval URL printed in your terminal.
- **Remote terminal:** add `--no-open` when starting the bootstrap installer.
- **Expired or denied request:** start the installer again for a new approval URL.
- **Client or operating system mismatch:** select the requested values before approving.
- **Deployment temporarily unavailable:** polling retries until the request expires.
- **Setup download or execution fails:** fix the reported issue and start again.
- **Tools unavailable after setup:** complete the client's MCP sign-in and reload it.

Approval requests expire after ten minutes, including the approved script's download window.
The setup script can be downloaded once.
A failed download may consume that link; restarting creates a fresh request.

The bootstrap keeps its polling secret in the terminal process.
Browser URLs carry a request identifier, never that secret.
Only approve a request you started with a matching terminal code.
Never paste passwords, cookies, polling secrets, or setup scripts into a chat.

Deployments expose `/llms.txt` with a link to `/connect.md`.
Automatic discovery varies by client; the explicit prompt above avoids relying on discovery.
Both public documents must remain reachable without application authentication.
An upstream proxy that requires login for every URL must allow these documents and bootstrap endpoints.

## What the Script Configures

A script can set up four things:

- **MCP gateway** — gives the client access to your Archestra tools. Its tools unlock after a one-time sign-in.
- **LLM proxy** — routes the client's model calls through Archestra. In passthrough mode the script leaves your own provider credential untouched and changes only the base URL. In virtual-key mode it injects a key Archestra provisions for you.
- **Skills** — installs a shared skills plugin into the client.
- **Plugins** — installs selected, approved, platform-compatible plugins for the client. The review step lets you change the selection before generating the command. See [Plugins](/docs/platform-agent-plugins).

For Claude Code, Codex, and Copilot CLI the script also installs a [startup guard](#startup-guard) that checks these remotes before every launch.

The exact commands and files differ per client — see [Supported Clients](#supported-clients) below.

## Attribution Headers

When it wires up the LLM proxy for Claude Code or Claude Desktop, the script adds two Archestra headers to every model request:

- **X-Archestra-Agent-Id** names the client — Claude Code or Claude Desktop — so the proxy logs show which tool made each call. It carries no secret.
- **X-Archestra-Virtual-Key** attributes the request to you. In passthrough mode your own provider credential still pays for inference; this key just tells the proxy whose request it is. Treat it as a secret.

For Claude Code the script writes these into `ANTHROPIC_CUSTOM_HEADERS` in `~/.claude/settings.json`; for Claude Desktop they go in the Custom headers field. The merge replaces only these two lines, so any other headers you set stay put.

## Idempotence and Backups

You can run the command as many times as you want. Nothing stacks up.

CLI registrations remove the old entry before adding the new one. Config-file edits are key-scoped merges: the script rewrites only the values it manages and leaves the rest of the file alone. Re-running after a key rotation replaces the stale value in place — it never duplicates a header or a provider block.

Before the script edits an existing config file, it copies that file once to a `.archestra-backup` sibling. The copy happens only on the first run, so it always holds your pristine, pre-Archestra configuration.

## Secrets and the One-Time Link

The script carries credentials, so treat its output as a secret — do not share or commit it. It passes secrets through environment variables and stdin, never as command arguments, so they stay out of your shell history and the process list.

The setup link is single-use. It expires 15 minutes after you generate it and is consumed the first time it is fetched. Generate a fresh command from the page whenever you need to run the setup again.

## Reading the Source Before You Run It

The command pipes a remote script into your shell, so you may want to read it first. Save it, inspect it, then run the saved file:

```bash
curl -fsSL '<url>' -o archestra-setup.sh
less archestra-setup.sh
bash archestra-setup.sh
```

You can also read the generator. A deterministic renderer builds the script with no hidden network calls: `platform/backend/src/services/connection-setup-script.ts` for macOS and Linux, and `connection-setup-script.windows.ts` for Windows. What you receive is exactly what those files produce.

## Startup Guard

For Claude Code, Codex, and Copilot CLI, the script installs a startup guard — a pre-loader that checks your Archestra remotes each time you launch `claude`, `codex`, or `copilot`. It makes a single health request covering the configured remotes — the LLM proxy and the MCP gateway; the skills marketplace rides on the same origin — then plays each remote's check in turn with a brief spinner. When everything is healthy, the CLI starts in about a second. The guard draws on the terminal's alternate screen, so nothing lingers after the CLI exits.

A remote the platform reports down gets a "Failed to connect to …" line. After the last check, one prompt covers every down remote — "Disconnect MCP gateway (name) from Codex now? (Y/n)", naming your client, or "Disconnect all 3 unreachable resources…" when several are down. Enter or `y` disconnects them all — the exact reverse of the connect steps; plugins are uninstalled before their marketplace is removed. `n` keeps them. The guard reads the client's config back to confirm each removal landed. A removal it cannot confirm gets a ✗ line with the command to run by hand, and the guard stays installed to try again. Later launches skip a remote the guard disconnected. Once no connected remote is left, the guard removes itself — the script and the profile hook — so a stale wrapper can never break a launch. When the platform itself is unreachable, the guard retries its request for up to 15 seconds with a status line, showing the same disconnect prompt below it, then treats every remote as down. Every path ends with the CLI starting; the guard never blocks a launch. Non-interactive runs, `codex exec` or `claude -p` for example, only get a warning on stderr.

After an interactive client session exits, its Bash or PowerShell wrapper refreshes the Archestra marketplace and installed plugins if the last successful refresh was more than 24 hours ago. Refresh happens after the session, never in the startup path, and one-shot invocations such as `claude -p` and `codex exec` skip it.

Under the checks the guard always shows its two keys: "To skip press [Space] · to reconfigure your Archestra connection press [C]". Press `Space` at any point to skip the rest of the checks and start the CLI at once — nothing is disconnected or remembered. When everything is healthy the guard waits about a second and a half for a key, then starts the CLI. Press `C` and the rows turn into a numbered menu — one per remote — so you can disconnect any of them, reachable or not, by pressing its number. The row lands on a check, later launches skip it, and removing the last connected remote uninstalls the guard. Press `Esc` to leave the menu and start the CLI.

The same health request also tells the guard whether a newer version of the setup is available. The guard remembers the version it was installed at and compares it to the version the platform reports. When the platform is ahead, the guard shows an "update" line with one more key — press `U` to see the steps to re-run the setup from the Connection page. The line is advisory only: it never blocks the launch, and a non-interactive run — `codex exec` or `claude -p`, for example — just prints a one-line note on stderr instead. An older or rolled-back instance stays silent, so you are nudged only when there is genuinely a newer setup to pick up.

A guard installed before this version check cannot show that update line — it predates the check. The next time you run the setup, the script spots the older guard and upgrades it in place automatically, with no prompt. The replacement matches the version the platform reports, so it stays silent on the next launch instead of nudging you again.

The guard lives under `~/.archestra/`, hooked in by a marked wrapper block in your shell profile — on Windows, in each PowerShell edition's `profile.ps1`. Each client has its own file and its own disable variable:

| Client | macOS / Linux | Windows | Disable with |
| --- | --- | --- | --- |
| Claude Code | `~/.archestra/claude-startup-guard.sh` | `~/.archestra/claude-startup-guard.ps1` | `ARCHESTRA_CLAUDE_GUARD=0` |
| Codex | `~/.archestra/codex-startup-guard.sh` | `~/.archestra/codex-startup-guard.ps1` | `ARCHESTRA_CODEX_GUARD=0` |
| Copilot CLI | `~/.archestra/copilot-startup-guard.sh` | `~/.archestra/copilot-startup-guard.ps1` | `ARCHESTRA_COPILOT_GUARD=0` |

Set the disable variable to turn the guard off without uninstalling. To remove everything by hand instead, follow your client's Revert steps below.

## Supported Clients

Four clients get the one-command script: Claude Code, Codex, Cursor, and Copilot CLI. Claude Desktop, n8n, and Any Client get copy-paste instructions you apply in the app yourself. Each section lists what changes and how to undo it. To also cut off access on the server, delete the virtual key on the **LLM Proxy** page and revoke any skills share link on the Skills page.

### Claude Code

For a full walkthrough, see [Using Claude Code with a Pro or Max Subscription](/docs/platform-claude-code-example).

The `claude` CLI must be on your `PATH`.

- **MCP gateway** — runs `claude mcp add --transport http <name> <url>`. Finish with `claude /mcp`, select the gateway, and sign in once in your browser.
- **LLM proxy** — merges `ANTHROPIC_BASE_URL` and the Archestra attribution headers into `~/.claude/settings.json`. Virtual-key mode also sets `ANTHROPIC_AUTH_TOKEN`. For Amazon Bedrock it sets the Bedrock variables instead and prints an `AWS_BEARER_TOKEN_BEDROCK` line to add to your shell profile.
- **Skills** — runs `claude plugin marketplace add` then `claude plugin install`.
- **Plugins** — installs the selected Claude Code plugins. OpenAPPA is imported by default and can be deselected, updated, or deleted.
- **Startup guard** — installs a pre-loader that checks your Archestra remotes before every `claude` launch. See [Startup Guard](#startup-guard).
- **Backup** — `~/.claude/settings.json.archestra-backup`.
- **Revert** — the startup guard's reconfigure menu (press `C` at launch) disconnects any remote. By hand: restore the backup, delete the Archestra env keys, run `claude mcp remove <name>` and `claude plugin marketplace remove <name>`, and drop the exported Bedrock token from your profile.

### Codex

The `codex` CLI must be on your `PATH`.

- **MCP gateway** — runs `codex mcp add <name> --url <url>`. Run `codex` once to finish the browser sign-in.
- **LLM proxy** — adds a marker-delimited `[model_providers.<name>]` block to `~/.codex/config.toml`. Virtual-key mode signs in with `codex login --with-api-key`. Start Codex through the proxy with `codex -c model_provider=<name>`.
- **Skills** — runs `codex plugin marketplace add`.
- **Plugins** — runs `codex plugin add` for each plugin. Codex delivers the plugin but does not execute its hooks until you open `/hooks` and approve that content hash.
- **Startup guard** — installs a pre-loader that checks your Archestra remotes before every `codex` launch. See [Startup Guard](#startup-guard).
- **Backup** — `~/.codex/config.toml.archestra-backup`.
- **Revert** — the startup guard's reconfigure menu (press `C` at launch) disconnects any remote. By hand: delete the `# >>> archestra:<name> >>>` block, run `codex mcp remove <name>` and `codex plugin marketplace remove <name>`; if the script signed Codex in with a virtual key, run `codex logout`, then `codex login` with your own account.

### Cursor

Cursor is a desktop app, so the script edits its files directly and prints the UI-only steps.

- **MCP gateway** — merges the server into `~/.cursor/mcp.json`. Turn it on in Cursor under Settings → MCP.
- **LLM proxy** — prints the values to paste under Settings → Models: the base URL to override and the API key to verify.
- **Skills** — prints the clone URL to paste into `/add-plugin` from the command palette.
- **Plugins** — advertises Cursor plugins in the same marketplace and prints the plugin names to install manually. Cursor delivery is not automated.
- **Backup** — `~/.cursor/mcp.json.archestra-backup`.
- **Revert** — restore the backup, or remove the server entry from `mcp.json`; clear the model override in Settings.

### Copilot CLI

The `copilot` CLI must be on your `PATH`.

- **MCP gateway** — runs `copilot mcp add --transport http <name> <url>`.
- **LLM proxy** — on Windows the script sets the `COPILOT_PROVIDER_*` variables for you: in the current session and in your User environment. The model you pick in the review step is applied as `COPILOT_MODEL`. On macOS and Linux the script prints `export` lines to add to your shell profile — a piped script cannot set variables in your shell there. For a GitHub Copilot subscription the script runs the GitHub device flow locally, so your token never leaves the machine.
- **Skills** — runs `copilot plugin marketplace add`.
- **Plugins** — runs `copilot plugin install` for every enabled Copilot CLI plugin.
- **Startup guard** — installs a pre-loader that checks your Archestra remotes before every `copilot` launch. See [Startup Guard](#startup-guard).
- **Backup** — none; the proxy settings are environment variables.
- **Revert** — run `copilot mcp remove <name>`; on Windows remove the `COPILOT_PROVIDER_*` variables from your User environment, on macOS and Linux delete the export lines from your shell profile.

### Claude Desktop

For a full walkthrough, see [Using Claude Desktop (Cowork)](/docs/platform-claude-desktop-example).

> **Note:** Claude Desktop's third-party inference cannot reuse a Claude Pro or Max subscription. To keep paying through a subscription, connect Claude Code in passthrough mode instead.

Claude Desktop is a desktop app, so you apply every change in its UI — there is no script and nothing on disk to back up.

- **MCP gateway** — enable Developer Mode, open Developer → Configure Third-Party Inference, add a blank managed MCP server, and paste the gateway URL. Sign in once in your browser.
- **LLM proxy** — in the same form, paste the gateway base URL and your API key, then add the Archestra attribution headers under Custom headers.
- **Skills** — in **Settings → Plugins → Browse plugins**, install your shared-skills marketplace.
- **Revert** — remove the connector and clear the inference credential in the app.

### n8n

n8n is a workflow tool, so you configure nodes inside n8n — there is no script and nothing on disk to back up.

- **MCP gateway** — add the "MCP Client Tool" node, paste the endpoint URL, and set authentication to Bearer Auth with a token or to MCP OAuth2.
- **LLM proxy** — add the provider's chat-model node, create a credential, and paste the base URL and key. Most providers are supported; Bedrock routes through an OpenAI-compatible URL.
- **Revert** — delete the node or its credential.

### Any Client

Selecting **Any Client** gives copy-paste instructions instead of a one-command script. The page shows the MCP gateway URL with its authentication, and the LLM proxy base URL and key. You apply them to whatever tool you use — an editor plugin or a custom agent, for example.

## Configuring the Page

Go to **Settings → Connection** to set what the page offers everyone. **Available clients** is the list of clients it shows setup instructions for — remove a chip to drop that client. "Any client" is always shown.

You can turn off **LLM Proxy on Connect**, **Skills on Connect**, and **Plugins on Connect**. The page then omits those sections, and new setup commands cannot include them. Plugin management and existing installs keep working.

The same page holds the defaults it pre-selects — an MCP gateway, a client, and the provider key a setup command's virtual key maps to — and the base URLs it hands out.

Which model providers the page offers is not set here. That is one deployment-wide list, under **Settings → LLM → Model providers**.

## Use Case

Acme's administrator shares `https://ai.example.com/connect.md` with a new engineer.
The engineer asks Claude Code to read it and connect.
They sign in through SSO and approve the matching terminal code.
The installer applies the reviewed configuration.
They finish MCP authentication in Claude Code and verify that tools are available.

The Connection page also provides a setup command for manual installation.
