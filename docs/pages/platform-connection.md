---
title: Connect Your Agents
category: Archestra Platform
order: 8
description: How the one-command setup script connects your AI tools, and how to audit or undo it
lastUpdated: 2026-10-02
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

![The Connection page with a copyable coding-agent prompt](/docs/automated_screenshots/platform-connection_connect-with-ai.webp)

Select your client on the Connection page. Claude Code, Cursor, Codex, Copilot CLI, and OpenCode list what the connection adds, then show a setup prompt. Your agent prepares the connection; you review and approve it in your browser.

Claude Desktop, n8n, and other clients show their setup instructions. Your selected client stays in the URL when you refresh or share the page.

On macOS and Linux the command is `curl -fsSL <url> | bash`. On Windows it is `irm <url> | iex`. Running it configures the client in place. Plugins declare whether they support macOS/Linux, Windows, or both; the review includes only plugins compatible with the selected operating system and names incompatible plugins that were skipped.

## Connect From Your Coding Client

The terminal on the Connection page provides a prompt for your deployment.
You can also give your coding agent this prompt, replacing the example hostname:

> Read https://ai.example.com/connect.md?client=cursor and connect Cursor.

If a security policy blocks setup in Claude Code, Codex, or OpenCode, sign in and use Copy on the Connection page. This starts a ten-minute setup window for your account and copies the unchanged prompt.
Approved installers also receive a signed, ten-minute setup exception for gateway and authenticated proxy requests. This covers connection continuations even when the client changes its tools or lacks session metadata. Authentication and access permissions still apply. After expiry, the same URLs continue through normal policy checks. Manual n8n and other-client setups continue through normal policy checks.

The public instructions need no installed skill or platform login.
They support Claude Code, Cursor, Codex, Copilot CLI, and OpenCode.
The terminal needs Node.js 18 or newer on macOS, Linux, or Windows.

The agent downloads a public bootstrap installer and starts a connection request.
Your browser opens a compact approval page for the requested client and operating system.
The setup uses your deployment’s defaults. **Customize setup** reveals the optional settings.
Sign in using your deployment's usual login or SSO.
Review the configuration and confirm that the browser code matches your terminal.
![Browser approval with a matching terminal code](/docs/automated_screenshots/platform-connection_browser-approval.webp)

Approval releases the setup script to the waiting installer.
Denying the request prevents installation.

The installer uses the same configuration defaults and permissions as the Connection page.
It runs the existing setup script after approval.
Your coding client may ask permission before running downloaded code.

Keep the original installer running while you approve its browser request. Temporary status errors do not require another installer or approval link. Codex continues reading the same terminal session until installation finishes. Gateway OAuth is a separate authentication step, not another setup request.

### Completing the Connection

Browser approval authorizes installation. MCP gateway authentication remains the client's native OAuth flow.
Follow the installer output to authenticate the gateway and reload your client.
Verify that the gateway can list tools before considering the connection complete.

For Claude Code, approved gateway setup adds exact allow rules for the OpenAPPA helper calls. They skip Claude Code's tool-permission prompts and auto-mode tool classification. Existing ask and deny rules stay unchanged and take priority. Gateway authorization and required human review still apply. These rules cannot override model or provider safety refusals. Other gateway, policy, and credential tools are not included. Start a new session before the rules load. See [Claude Code](#claude-code).

For OpenCode, the connection agent checks `opencode mcp list` after installation. If the gateway is already connected, it skips OAuth. Otherwise, it starts the gateway's native OAuth sign-in. After the agent finishes, save your work and close OpenCode normally. Start a new session in a fresh terminal. An in-session process restart can terminate the agent before it finishes.

For Codex, the connection agent runs the installer's verification command. Windows uses a native PowerShell launcher. macOS and Linux use Node. Both start a fresh native client with your configured model, approvals, and sandbox. They call a read-only gateway tool and check inference through the selected proxy. The gateway check does not ask a model to run a shell command.

Verification uses the deployment's tool prefix, including full white-label names. It does not infer that prefix from the MCP server's display name.

If the operating system blocks startup, Codex can request approval for that one verification command. Your configured sandbox and approval settings stay unchanged. The verifier never approves permission requests automatically. Installation and OAuth alone do not prove the connection works.

Cursor still requires native gateway OAuth. Connecting its gateway does not route inference through the LLM Proxy. To route supported OpenAI chat models, select the proxy under **Customize setup**, then apply the printed key and base URL in Cursor's model settings.
The installer places shared skills in Cursor's skills folder; reload Cursor to see them.
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
- **Claude Code still prompts for a helper:** start a new session. Only `get_remedy_plans`, `execute_remedy_plan`, `yell`, and `ask_user` are pre-approved. The rules apply only to the connected gateway.
- **Helper preapproval skipped:** some gateway names cannot form an exact permission rule. Setup warns and continues without adding helper permissions.
- **Claude Code says python3 is required:** install Python 3 and run setup again. macOS and Linux use it to write the helper allow rules.

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
- **LLM proxy** — routes the client's model calls through Archestra. Passthrough mode uses your own provider credentials. Virtual-key mode injects a key Archestra provisions for you.
- **Skills** — installs a shared skills plugin into the client.
- **Plugins** — installs selected, approved, platform-compatible plugins for the client. The review step lets you change the selection before generating the command. See [Plugins](/docs/platform-agent-plugins).

For Claude Code, Codex, Copilot CLI, and OpenCode the script also installs a [startup guard](#startup-guard) that checks these remotes before every launch.

The exact commands and files differ per client — see [Supported Clients](#supported-clients) below.

## Attribution Headers

When it wires up the LLM proxy, the script adds Archestra attribution headers to supported clients:

- **X-Archestra-Agent-Id** names the client, such as Claude Code, Claude Desktop, Codex, or OpenCode. The proxy logs use it for client filters and badges. It carries no secret.
- **X-Archestra-Virtual-Key** attributes the request to you. In passthrough mode your own provider credential still pays for inference; this key just tells the proxy whose request it is. Treat it as a secret.

Each client stores the headers in its native provider settings. The merge leaves unrelated headers unchanged.

## Idempotence and Backups

You can run the command as many times as you want. Nothing stacks up.

CLI registrations remove the old entry before adding the new one. Config-file edits are key-scoped merges: the script rewrites only the values it manages and leaves the rest of the file alone. Re-running after a key rotation replaces the stale value in place — it never duplicates a header or a provider block. Claude Code helper allow rules are replaced in place on a re-run. Your other allow, ask, and deny entries stay unchanged.

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

For Claude Code, Codex, Copilot CLI, and OpenCode, the script installs a startup guard. It checks your Archestra remotes when you start an inference session with `claude`, `codex`, `copilot`, or `opencode`. It makes one health request for the LLM proxy, MCP gateway, and skills origin. When everything is healthy, the CLI starts in about a second. Utility commands such as `claude login`, `claude stop`, and `codex upgrade` run directly, with their arguments unchanged.

A remote the platform reports down gets a "Failed to connect to …" line. After the last check, one prompt covers every down remote — "Disconnect MCP gateway (name) from Codex now? (Y/n)", naming your client, or "Disconnect all 3 unreachable resources…" when several are down. Enter or `y` disconnects them all — the exact reverse of the connect steps; plugins are uninstalled before their marketplace is removed. `n` keeps them. The guard reads the client's config back to confirm each removal landed. A removal it cannot confirm gets a ✗ line with the command to run by hand, and the guard stays installed to try again. Later launches skip a remote the guard disconnected. Once no connected remote is left, the guard removes itself — the script and the profile hook — so a stale wrapper can never break a launch. When the platform itself is unreachable, the guard retries its request for up to 15 seconds with a status line, showing the same disconnect prompt below it, then treats every remote as down. These health checks do not block a launch. Non-interactive runs, `codex exec` or `claude -p` for example, only get a warning on stderr.

For Codex proxy connections, the model catalog check is a separate launch requirement. A failed catalog refresh stops the launch, even if you skip the health checks.

Codex catalog discovery supports file-backed credentials. It does not support the `auto` or `keyring` credential stores. The Codex home filesystem must support hard links. Setup reports an error if these requirements are not met. It does not change your credential-store setting.

The managed `web_search` and `model_catalog_json` settings require single-line values. Multiline inline feature tables are also unsupported. Setup rejects these forms before changing the configuration. Other multiline settings remain unchanged.

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
| OpenCode | `~/.archestra/opencode-startup-guard.sh` | `~/.archestra/opencode-startup-guard.ps1` | `ARCHESTRA_OPENCODE_GUARD=0` |

Set the disable variable to turn the guard off without uninstalling. To remove everything by hand instead, follow your client's Revert steps below.

## Supported Clients

Five clients get the one-command script: Claude Code, Codex, Cursor, Copilot CLI, and OpenCode. Claude Desktop gets a downloadable installer. n8n and Any Client get step-by-step instructions you apply yourself. Each section lists what changes and how to undo it. To also cut off access on the server, delete the virtual key on the **LLM Proxy** page and revoke any skills share link on the Skills page.

In the **MCP gateway** commands below, `<name>` is the name your client uses for the gateway. Any name works. The gateway signs each tool that it lists. Guardrails and OpenAPPA use that signature to identify tools under any name.

### Claude Code

For a full walkthrough, see [Using Claude Code with a Pro or Max Subscription](/docs/platform-claude-code-example).

The `claude` CLI must be on your `PATH`.

- **MCP gateway** — runs `claude mcp add --transport http <name> <url>`. Finish with `claude /mcp`, select the gateway, and sign in once in your browser.
- **Helper permissions** — gateway setup adds exact `permissions.allow` rules for `get_remedy_plans`, `execute_remedy_plan`, `list_peer_messages`, `read_peer_message`, `yell`, and `ask_user`. Each rule uses the registered server name and this deployment's tool prefix. A default personal gateway allows `mcp__archestra__archestra__get_remedy_plans`. The first `archestra` names the server. The second starts the tool name. The other helpers use that same shape. Those calls skip Claude Code's tool-permission prompt and auto-mode tool classification. Other gateway tools are not included. Policy and credential administration tools are not included. Existing ask and deny rules stay unchanged and take priority. These rules cannot override model or provider safety refusals. The installer reports that the helper calls are pre-approved. Start a new session before the rules apply. Disconnecting the gateway from the startup guard removes the rules setup added. macOS and Linux need Python 3 for that cleanup. Your other allow, ask, and deny rules stay. `claude mcp remove` alone does not remove them.
- **LLM proxy** — merges `ANTHROPIC_BASE_URL` and the Archestra attribution headers into `~/.claude/settings.json`. Virtual-key mode also sets `ANTHROPIC_AUTH_TOKEN`. For Amazon Bedrock it merges the Bedrock variables, including `AWS_BEARER_TOKEN_BEDROCK` in virtual-key mode.
- **Skills** — runs `claude plugin marketplace add` then `claude plugin install`, and turns on auto-update for the marketplace so Claude Code picks up new skill versions at startup. A choice you already made for that marketplace is kept.
- **Plugins** — installs the selected Claude Code plugins. You can import OpenAPPA from the Plugins catalog, then select it here.
- **Startup guard** — installs a pre-loader that checks your Archestra remotes before every `claude` launch. See [Startup Guard](#startup-guard).
- **Backup** — `~/.claude/settings.json.archestra-backup`.
- **Revert** — the startup guard's reconfigure menu (press `C` at launch) disconnects any remote. It also removes the helper allow rules setup added. macOS and Linux need Python 3 for that removal. By hand: restore the backup, delete the Archestra env keys, run `claude mcp remove <name>` and `claude plugin marketplace remove <name>`, and drop the exported Bedrock token from your profile. `claude mcp remove` alone leaves those allow rules in place.

Switching to passthrough removes saved Archestra keys from that provider's authentication variables in `~/.claude/settings.json`. Your provider credentials stay unchanged. Switching to virtual-key mode removes the old passthrough header. For Anthropic, it also removes saved Archestra keys from `ANTHROPIC_API_KEY`. Restart Claude Code after changing modes. Remove stale Archestra credentials from shell or project settings separately if you configured them there.

### Codex

The `codex` CLI must be on your `PATH`.

- **MCP gateway** — runs `codex mcp add <name> --url <url>`. Codex can complete OAuth during registration. Verification reuses that login instead of opening a second authorization flow.
- **LLM proxy** — adds a `[model_providers.<name>]` block to `~/.codex/config.toml` and selects it as the default provider. New `codex` sessions use the proxy automatically. Codex can use an existing ChatGPT subscription or OpenAI API key. In virtual-key mode, the script signs in with `codex login --with-api-key`.
- **Skills** — runs `codex plugin marketplace add`.
- **Plugins** — runs `codex plugin add` for each plugin. Codex delivers the plugin but does not execute its hooks until you open `/hooks` and approve that content hash.
- **Startup guard** — installs a pre-loader that checks your Archestra remotes before every `codex` launch. Connecting the LLM proxy also installs direct-tool settings, including a model catalog, in `~/.codex`. Connection probes use these settings without requiring a shell profile. Normal launches refresh the catalog, including newly released models. An unverified refresh stops the proxy-connected launch instead of falling back to code mode. A network-blocked shell inside Codex can reuse a validated direct catalog from the last 24 hours. The selected model must be present. This does not change sandbox restrictions or approval settings. MCP-only connections leave tool mode unchanged. See [Startup Guard](#startup-guard).
- **MCP forms** — Codex's Full Access preset does not show required MCP forms. Connection setup does not change your approval policy.
- **Backup** — `~/.codex/config.toml.archestra-backup`.
- **Revert** — removing the LLM proxy in the startup guard (press `C` at launch) restores the previous tool-mode settings and removes the generated catalog. This also applies when the MCP gateway stays connected. Removing only the gateway leaves the proxy's direct-tool settings active. By hand: restore `~/.codex/config.toml.archestra-backup`, or delete the `# >>> archestra:<name> >>>` block and remove `model_provider`; restore any `# original:` entries inside the `archestra:codex-direct` blocks before deleting those blocks. Run `codex mcp remove <name>` and `codex plugin marketplace remove <name>`. If the script signed Codex in with a virtual key, run `codex logout`, then sign in with your own account.

### Cursor

Cursor is a desktop app, so the script edits its files directly and prints the remaining UI steps.

- **MCP gateway** — merges the server into `~/.cursor/mcp.json`. Authenticate it in Cursor under Customize → MCPs.
- **LLM proxy** — prints the values to paste under Settings → Models → API Keys. Enter an OpenAI API key or personal virtual key, then turn on **Use OpenAI API Key**. Cursor subscriptions cannot authenticate proxy requests.
- **Skills** — the script clones the shared skills into `~/.cursor/skills/<marketplace-name>`. Cursor discovers the nested skills after a reload; confirm them under Customize → Skills. The script updates the clone when run again.
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

Download the setup helper and open it in normal Claude Desktop. Confirm its native installation prompt to start the reviewed setup. For an existing third-party profile, use the terminal option. The setup script supports macOS, Windows, and Linux. Choose subscription authentication or an API key under **Customize setup**. The script checks inference, saves a gateway profile, and restarts Desktop. It preserves manually created profiles and backs up changed files. Rerunning setup replaces the managed connection; a different deployment takes precedence over the previous one.

Connecting the LLM Proxy switches Desktop to third-party mode with separate conversation history. After restart, open **Settings → Import** in Desktop to copy your Claude.ai conversations. Import is a one-time copy; rerun it to add newer conversations. See [Import Conversations](/docs/platform-claude-desktop-example#import-conversations). Tools-only setup does not require this mode switch.

Subscription setup opens Claude sign-in through the helper's browser flow. API-key setup uses a personal virtual key backed by your configured Anthropic key. The download uses Desktop's built-in runtime. Only the terminal option requires Python and Claude Code for subscription sign-in.

Follow the gateway completion step on Connect after Desktop restarts. Authentication and enabling the gateway for a conversation are separate actions. The selected shared skills install automatically after restart. Rerun Connect to install an updated snapshot.

To return to standard Claude, choose Anthropic sign-in on Desktop's sign-in screen. See [Revert](/docs/platform-claude-desktop-example#revert) for recovery guidance. Keep third-party application data to preserve conversations created there.

See [Using Claude Desktop (Cowork)](/docs/platform-claude-desktop-example) for requirements and authentication details.

### OpenCode

OpenCode 1.17 or newer supports the reviewed setup script.

- **MCP gateway** — adds the server to `~/.config/opencode/opencode.json`. If `opencode mcp list` reports that authentication is needed, run `opencode mcp auth <name>`. If credentials are valid but the connection fails, check the connection error instead of signing in again.
- **LLM proxy** — keeps OpenCode provider IDs, model IDs, and local credentials. It enables compatible providers with valid credentials and routes them to proxy endpoints. Unsupported or uncredentialed providers stay hidden. If an active model becomes unavailable, OpenCode clears it without choosing a replacement.
- **OAuth connections** — OpenCode refreshes local Google and ChatGPT access tokens. The routing guard forwards request bearer tokens and required account headers to the proxy adapter. Archestra does not store or refresh the OAuth tokens.
- **Routing guard** — installs a global OpenCode plugin. The plugin updates the provider allowlist after project configuration loads. It blocks requests if a project overrides the Archestra base URL or chooses an unsupported provider, preventing direct provider requests.
- **Skills** — clones the marketplace into `~/.config/opencode/skills/`. OpenCode loads the skills on its next start.
- **Startup guard** — installs a pre-loader that checks your Archestra remotes before every `opencode` launch. See [Startup Guard](#startup-guard).
- **Revert** — use the startup guard reconfigure menu. It removes the routing plugin and restores settings from previous connections. Local credentials and model selections stay unchanged. If the routing plugin file existed before setup, disconnect restores the original file content.

### n8n

n8n is a workflow tool, so you configure nodes inside n8n — there is no script and nothing on disk to back up.

- **MCP gateway** — add the "MCP Client Tool" node, paste the endpoint URL, and set authentication to Bearer Auth with a token or to MCP OAuth2.
- **LLM proxy** — add the provider's chat-model node, create a credential, and paste the base URL and key. Most providers are supported; Bedrock routes through an OpenAI-compatible URL.
- **Revert** — delete the node or its credential.

### Any Client

Selecting **Any Client** gives copy-paste instructions instead of a one-command script. The page shows the MCP gateway URL with its authentication, and the LLM proxy base URL and key. You apply them to whatever tool you use — an editor plugin or a custom agent, for example.

## Configuring the Page

Go to **Settings → Connect Page** to set what the page offers everyone. **Available clients** is the list of clients it shows setup instructions for — remove a chip to drop that client. "Any client" is always shown.

You can turn off **LLM Proxy on Connect**, **Skills on Connect**, and **Plugins on Connect**. The page then omits those sections, and new setup commands cannot include them. Plugin management and existing installs keep working.

The same page holds the defaults it pre-selects — an MCP gateway, a client, and the provider key a setup command's virtual key maps to — and the base URLs it hands out.

Which model providers the page offers is not set here. That is one deployment-wide list, under **Settings → LLM → Model providers**.

### Runtime Handoff Instructions

**Suggest runtime handoff** adds configurable instructions to connected clients. It is on by default. Setup must include an MCP gateway with access to Agent Runtime tools. The default instructions ask the agent to mention Cloud runtime once, in its first reply. When you request a transfer, it uses the handoff skill and creates a runtime agent if needed.

- **Claude Code:** the existing shell wrapper passes a local file through `--append-system-prompt-file`. Explicit system-prompt flags take precedence.
- **Codex:** the wrapper reads effective settings through Codex's local configuration API. It combines existing developer instructions with the handoff text through `-c developer_instructions`. It does not edit `AGENTS.md` or replace the built-in prompt. Profile, directory, remote, and config overrides skip this addition, except model, provider, and reasoning-effort selections. If configuration cannot be read within three seconds, Codex launches unchanged with a warning. This requires Node.js and a Codex version supporting `config/read`.
- **Copilot CLI:** the wrapper adds a local instruction directory through `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`. Existing instruction directories stay included.
- **Claude Desktop:** setup adds `organizationInstructions` to its managed profile. This requires Desktop 1.37937.0 or newer. Instructions longer than 3,000 characters fail setup without changing the profile.
- **Cursor:** setup prints the instruction text. Paste it into **Customize → Rules → User Rules**, keeping your existing rules. Updates and removal remain manual.
- **OpenCode:** the wrapper passes a temporary config overlay through `OPENCODE_CONFIG_CONTENT`. The overlay adds the handoff instruction without editing project files.

After saving edits or disabling the feature, rerun Connect setup. Reload your shell for CLI clients and start a new conversation. Resumed conversations can retain their previous prompt. Disabling removes managed instructions during setup; remove Cursor's rule manually. Instructions guide the model; they do not guarantee an offer or start remote work automatically.

## Use Case

Acme's administrator shares `https://ai.example.com/connect.md` with a new engineer.
The engineer asks Claude Code to read it and connect.
They sign in through SSO and approve the matching terminal code.
The installer applies the reviewed configuration.
They start a new Claude Code session, finish MCP authentication, and verify that tools are available.

The Connection page also provides a setup command for manual installation.
