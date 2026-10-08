# Agent connection setup

This folder renders everything the `/connection` page and the browser-approved
bootstrap run on a user's machine to connect a coding agent to Archestra: the
MCP gateway, the LLM proxy, the skills marketplace, and the startup guard that
checks those remotes before each launch.

Everything here is deterministic string building. No database, no I/O. The
routes render inside their claim transaction, and tests assert exact output.

## Flow

1. **Bootstrap.** The user, or their agent following `/connect.md`, runs the
   Node.js installer from `GET /api/client-connections/installer`
   (`bootstrap/client-connection-installer.ts`). It holds no deployment
   credentials. It starts a connection request and opens the approval page.
2. **Approval.** The user signs in, checks the displayed code, and approves in
   the browser. The protocol is described in
   `routes/client-connection/README.md`.
3. **Script download.** The installer polls until the request is approved. It
   then downloads `/api/connection-setups/script/<token>`. The route consumes
   the one-time ticket, revalidates access, and builds a `SetupScriptContext`.
   The manual Connect command (`buildSetupCommand`) downloads the same script
   with `curl | bash` or `irm | iex`.
4. **Render.** `renderSetupScript` (`index.ts`) picks the agent module for
   `ctx.clientId`. It renders bash for macOS and Linux and PowerShell for
   Windows: the shared header, the agent's sections, then the shared footer
   with the agent's next steps.
5. **Run.** The installer saves the script to a private temporary directory,
   runs it with bash or PowerShell, and deletes it. The script registers the
   gateway, routes the proxy, installs skills, and installs the startup guard.

Claude Desktop takes its own path. `agents/claude-desktop.ts` renders a Python
installer wrapped in bash or PowerShell, and `desktop/` builds the Desktop
extension bundle that runs the reviewed setup from inside the app.

## Layout

```
index.ts            renderSetupScript and the agent dispatch map
types.ts            SetupScriptContext and the agent module interface
setup-command.ts    the one-line Connect command and URL helpers
agents/             one module per agent
  claude-code.ts    bash and PowerShell steps side by side, plus next steps
  codex.ts
  copilot-cli.ts
  cursor.ts
  opencode.ts
  claude-desktop.ts Python installer for Claude Desktop (separate path)
steps/              building blocks shared by agents
  script-frame.ts   header, banner, footer and logging helpers (bash + PowerShell)
  quoting.ts        shell quoting (sh, psq) and small text helpers
  json-merge.ts     key-scoped JSON config merge with a one-time backup
  startup-guard.ts  wraps an agent's sections with the guard unshadow/install
  mcp.ts            legacy MCP server names to migrate
  marketplace-copy.ts, powershell-json.ts
guard/              startup guard renderers
  startup-guard.ts          bash guard, guard context, install/unshadow sections
  startup-guard.windows.ts  PowerShell guard
  clients/                  per-client descriptors: binary, paths, disconnect steps
payloads/           files the scripts write to disk (handoff helpers, OpenCode plugin)
bootstrap/          the Node.js installer served by the client-connection routes
desktop/            Claude Desktop extension bundle and its installer
```

An agent module (`ShellAgentSetup` in `types.ts`) provides a label, the CLI
binary the script requires, and a `bash` and a `powerShell` renderer. Each
renderer returns the agent's sections and its next steps. Agent modules call
shared steps but never render the script frame themselves.

## Adding an agent

The only path built today is the old shell one:

1. Add the client id to `INSTALLER_CLIENT_IDS` in `shared/connection-setup.ts`
   and its supported providers in
   `routes/connection-setup/connection-setup.routes.ts`.
2. Add a module under `agents/` and register it in `SHELL_AGENTS` in
   `index.ts`.
3. If the agent has a terminal command to wrap, add a guard descriptor under
   `guard/clients/` and wrap its sections with the startup-guard step.
4. Add unit tests that render the script for each platform.

New bash and PowerShell for agent setup is frozen (see below). A new agent
should start the Node.js runner rather than follow these steps.

## Direction

The current agents are the "old" model: each setup step is rendered twice, once
in bash and once in PowerShell, and the two copies drift. The wording and
behavior differences that exist today are kept on purpose, so this refactor
changed no rendered output.

New agents should use the "new" model: setup steps written once in Node.js and
run by the bootstrap installer, which already runs on every platform. That
runner is not built yet. Until it is, prefer extending shared steps over adding
agent-specific shell code, and add no new bash or PowerShell for agent setup.
