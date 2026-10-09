import { ARCHESTRA_TOKEN_PREFIX } from "@archestra/shared";
import {
  CLAUDE_DESKTOP_PROFILE_ID,
  INSTALLER_CLIENT_IDS,
  INSTALLER_CLIENT_LABELS,
  type InstallerClientId,
  isInstallerClientId,
  startupGuardStem,
} from "@archestra/shared/connection-setup";
import {
  type DeploymentTarget,
  deploymentTarget,
  requestOrigin,
} from "@/lib/request-origin";

/**
 * Agent instructions that undo what the connect setup installed in one client:
 * the MCP gateway entry, skills and plugins, the LLM proxy settings, and the
 * shell-profile startup check. The reverse steps mirror the setup scripts in
 * backend/src/services/agent-connection-setup/agents/ and the startup guard's
 * own disconnect actions (agent-connection-setup/guard/clients/); for clients
 * with a guard, the guard runs them itself via ARCHESTRA_GUARD_ACTION=disconnect.
 */
export function GET(request: Request) {
  const origin = requestOrigin(request);
  const params = new URL(request.url).searchParams;
  const client = params.get("client");
  const target = deploymentTarget(origin, params.get("base"));
  const body =
    (client === "generic" ? genericInstructions(target) : null) ??
    (client === "claude-desktop" ? claudeDesktopInstructions(target) : null) ??
    (client ? focusedInstructions(target, client) : null) ??
    pickClientInstructions(origin);
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function pickClientInstructions(origin: string): string {
  return `# Disconnect This Client

Remove what the ${origin} connect setup added to the coding client running this
conversation. Work out which client that is; ask only if it is unknown.
Supported clients: ${INSTALLER_CLIENT_IDS.join(", ")}.

Then read ${origin}/disconnect.md?client=CLIENT_ID with CLIENT_ID replaced, and follow it.
In Claude Desktop's Cowork or Code tab, the client ID is claude-desktop, not claude-code.
For any other app, read ${origin}/disconnect.md?client=generic.
`;
}

/** The plan → yes → back up → remove → verify flow every client shares. */
function instructions(params: {
  target: DeploymentTarget;
  label: string;
  inventory: string;
  remove: string;
  finish: string;
}): string {
  const { label } = params;
  const { origin, host } = params.target;
  return `# Disconnect ${label}

Remove what the ${origin} connect setup added to ${label} on this computer.
Only touch entries that point at ${host}; leave everything else in ${label} as it is.

## 1. Find what is installed

${params.inventory}

## 2. Show the plan and wait

Before changing anything, show the user a short table: each item you found, what
you will remove or change, and which config files you will edit.
Then stop and wait for the user's explicit yes. Change nothing until they confirm;
if they want to keep a part, leave it and skip its step below.

## 3. Disconnect

Back up every config file before you edit it by copying it to <file>.before-disconnect
(keep an existing one). Remove only the entries named in the plan; do not restore
older .archestra-backup files wholesale, since they would undo the user's later changes.

${params.remove}

## 4. Verify and report

Repeat step 1 and confirm nothing that points at ${host} is left.
${params.finish}
Report what was removed, the files you changed with their backups, and anything left
for the user to do by hand.
End by telling the user this only cleaned up this computer, and that the last step is
to go back to ${origin}/connection and press Revoke access in the Disconnect dialog,
so the deployment stops accepting this client.

Never ask the user to paste passwords, session cookies, tokens or provider keys into
this conversation, and never print a secret.
`;
}

interface GuardClient {
  binary: string;
  inventory: string;
  manual: string;
  finish: string;
}

const GUARD_CLIENTS: Partial<Record<InstallerClientId, GuardClient>> = {
  "claude-code": {
    binary: "claude",
    inventory: `- MCP: claude mcp list. The gateway is the server whose URL starts with {{BASE}}/mcp/.
- Skills and plugins: the marketplace cloned from {{HOST}}/skills/ (claude plugin marketplace list,
  or plugins/known_marketplaces.json in the Claude config folder), and the plugins enabled
  from it (the PLUGIN@MARKETPLACE keys of enabledPlugins in settings.json).
- LLM proxy: the env block of ~/.claude/settings.json (or $CLAUDE_CONFIG_DIR/settings.json).
  Look for ANTHROPIC_BASE_URL or ANTHROPIC_BEDROCK_BASE_URL pointing at {{HOST}}, and the
  x-archestra-* lines in ANTHROPIC_CUSTOM_HEADERS.`,
    manual: `- claude mcp remove --scope user SERVER_NAME, then the same with --scope local.
- In settings.json permissions.allow, remove the rules that start with mcp__SERVER_NAME__.
- For each plugin from the marketplace: claude plugin uninstall PLUGIN@MARKETPLACE.
  Then claude plugin marketplace remove MARKETPLACE.
- In the settings.json env block, remove ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN
  (Bedrock: CLAUDE_CODE_USE_BEDROCK, AWS_REGION, ANTHROPIC_BEDROCK_BASE_URL and
  AWS_BEARER_TOKEN_BEDROCK) when they point at {{HOST}} or hold a ${ARCHESTRA_TOKEN_PREFIX} key. Remove only
  the x-archestra-* lines from ANTHROPIC_CUSTOM_HEADERS, and drop the key if it ends up empty.`,
    finish:
      "Tell the user to open a new terminal and start a new Claude Code session; the current one keeps the old configuration.",
  },
  codex: {
    binary: "codex",
    inventory: `- MCP: codex mcp list. The gateway is the server whose URL starts with {{BASE}}/mcp/.
- Skills and plugins: the [marketplaces.MARKETPLACE] table in \${CODEX_HOME:-~/.codex}/config.toml
  whose source is {{HOST}}/skills/, and the plugins installed from it (named PLUGIN@MARKETPLACE).
- LLM proxy: in the same config.toml, the block between "# >>> archestra:PROVIDER >>>"
  and "# <<< archestra:PROVIDER <<<", and a top-level model_provider = "PROVIDER" line.`,
    manual: `- If ~/.archestra/codex-startup-guard.sh.handoff.cjs exists, run
  node ~/.archestra/codex-startup-guard.sh.handoff.cjs --remove-direct first.
- codex mcp remove SERVER_NAME.
- For each plugin from the marketplace: codex plugin remove PLUGIN@MARKETPLACE.
  Then codex plugin marketplace remove MARKETPLACE.
- Delete the "# >>> archestra:PROVIDER >>>" block from config.toml. Replace the top-level
  model_provider = "PROVIDER" line with the model_provider line from
  config.toml.archestra-backup, or delete it when the backup has none.
- Only if \${CODEX_HOME:-~/.codex}/auth.json holds an OPENAI_API_KEY that starts with
  ${ARCHESTRA_TOKEN_PREFIX}, run codex logout. Leave a ChatGPT sign-in or the user's own key alone.`,
    finish:
      "Tell the user to start a new Codex session, and to run codex login if Codex was signed out.",
  },
  "copilot-cli": {
    binary: "copilot",
    inventory: `- MCP: the mcpServers entry in ~/.copilot/mcp-config.json whose URL starts with {{BASE}}/mcp/.
- Skills and plugins: the extraKnownMarketplaces entry in ~/.copilot/settings.json cloned
  from {{HOST}}/skills/, and the plugins installed from it (named PLUGIN@MARKETPLACE; see
  copilot plugin --help for the list command).
- LLM proxy: the archestra provider and its models in ~/.copilot/providers.json
  (respect COPILOT_HOME and COPILOT_PROVIDERS_CONFIG overrides); the selected model in
  ~/.copilot/settings.json. Setup ownership and the previous model are recorded in
  providers.json.archestra-state.json alongside the registry.
- Optional environment settings: export COPILOT_PROVIDER_TYPE, COPILOT_PROVIDER_BASE_URL,
  COPILOT_PROVIDER_API_KEY and COPILOT_PROVIDER_HEADERS lines in ~/.zshrc, ~/.bashrc
  and ~/.profile; fish set -gx lines in config.fish or conf.d/*.fish
  (on Windows, user environment variables of the same names).`,
    manual: `- copilot mcp remove SERVER_NAME.
- For each plugin from the marketplace: copilot plugin uninstall PLUGIN@MARKETPLACE.
  Then copilot plugin marketplace remove MARKETPLACE.
- Remove only the archestra provider whose baseUrl points to {{BASE}}, and its models.
  If settings.json still selects the model in the setup state file, restore previousModel
  (or remove the model setting if previousModel is null). Remove the setup state file.
- Remove the export COPILOT_PROVIDER_* lines found above. Remove COPILOT_MODEL only when it selects an archestra/ model; preserve other choices.`,
    finish:
      "Tell the user to open a new terminal so the removed environment variables are gone.",
  },
  opencode: {
    binary: "opencode",
    inventory: `- Config: \${XDG_CONFIG_HOME:-~/.config}/opencode/opencode.json. The gateway is the mcp
  entry whose URL starts with {{BASE}}/mcp/. The proxy is a provider entry whose
  options.baseURL (V1) or settings.baseURL (V2 providers) points at {{HOST}}, or x-archestra-* headers added to a provider.
- Skills: the folder \${XDG_CONFIG_HOME:-~/.config}/opencode/skills/MARKETPLACE cloned from {{HOST}}/skills/.
- Routing plugin: \${XDG_CONFIG_HOME:-~/.config}/opencode/plugins/archestra-llm-proxy.js.`,
    manual: `- opencode mcp logout SERVER_NAME, then remove mcp.SERVER_NAME from opencode.json.
- Delete the skills folder named above.
- If ~/.archestra/opencode-primary-state.json exists, restore its sections and fields
  into opencode.json: null means delete the field or provider entry. Then delete
  that state file and ~/.archestra/opencode-primary.key.
- Otherwise, remove the provider entry that points at {{HOST}}, or only the baseURL and
  x-archestra-* headers that were added to the user's own provider.
- Routing plugin: if ~/.archestra/opencode-routing-plugin-state.json says the plugin
  file existed before, restore its saved content; otherwise delete archestra-llm-proxy.js.
  Then delete the state file and any ~/.archestra/opencode-*.key file.`,
    finish:
      "Do not restart OpenCode from inside this conversation. Tell the user to close OpenCode and launch opencode in a new terminal.",
  },
};

function focusedInstructions(
  target: DeploymentTarget,
  client: string,
): string | null {
  if (!isInstallerClientId(client)) return null;
  const details = GUARD_CLIENTS[client];
  const guard = startupGuardStem(client);
  if (!details || !guard) {
    return client === "cursor" ? cursorInstructions(target) : null;
  }
  const label = INSTALLER_CLIENT_LABELS[client];
  const withOrigin = (text: string) =>
    text
      .replaceAll("{{BASE}}", target.base)
      .replaceAll("{{HOST}}", target.host);
  const guardSh = `~/.archestra/${guard}-startup-guard.sh`;
  const guardPs = `$HOME\\.archestra\\${guard}-startup-guard.ps1`;
  return instructions({
    target,
    label,
    inventory: `${withOrigin(details.inventory)}
- Startup check: ${guardSh} (Windows: ${guardPs}) and the
  "# >>> archestra ${guard} guard >>>" block in your shell profiles
  (~/.zshrc, ~/.bashrc, ~/.bash_profile, ~/.bash_login, ~/.profile; on Windows,
  profile.ps1 under Documents\\WindowsPowerShell and Documents\\PowerShell).
  It wraps \`${details.binary}\` and checks the connection before every launch.

Read each name you need (server, marketplace, plugins, provider) from these configs.
The variables at the top of the startup check file name exactly what it covers
(MCP server, marketplace, plugins and URLs); trust them over a guess.`,
    remove: `### If the startup check is installed

If the guard file contains ARCHESTRA_GUARD_ACTION, it can undo every step itself:
the same reverse steps it offers when the deployment is down. Run it directly.
macOS/Linux:
ARCHESTRA_GUARD_ACTION=disconnect bash ${guardSh}
Windows PowerShell:
$env:ARCHESTRA_GUARD_ACTION='disconnect'; try { & "${guardPs}" } finally { Remove-Item Env:ARCHESTRA_GUARD_ACTION }

It prints one line per removed part. On success it also deletes itself and its
profile blocks. If it reports "Could not disconnect", do that part by hand below,
then run it again. If a part the plan keeps would be removed, use the manual steps instead.

### Otherwise, by hand

${withOrigin(details.manual)}
- Delete the "# >>> archestra ${guard} guard >>>" through
  "# <<< archestra ${guard} guard <<<" block from each shell profile, then delete
  ~/.archestra/${guard}-startup-guard.* (the script, .skip, .prompt.md and
  .instructions files). Remove ~/.archestra only if it is then empty.`,
    finish: details.finish,
  });
}

function cursorInstructions(target: DeploymentTarget): string {
  const { base, host } = target;
  return instructions({
    target,
    label: INSTALLER_CLIENT_LABELS.cursor,
    inventory: `- MCP: the mcpServers entry in ~/.cursor/mcp.json whose URL starts with ${base}/mcp/.
- Skills: a folder in ~/.cursor/skills/ that is a git clone of ${host}/skills/
  (check with git -C FOLDER remote get-url origin).
- LLM proxy and User Rules: Cursor keeps these in its settings UI, not in a file.`,
    remove: `- Remove the gateway entry from ~/.cursor/mcp.json and keep the other servers.
- Delete the skills folder found above.
- Ask the user to open Settings > Models > API Keys, turn off Override OpenAI Base URL
  if it points at ${host}, and remove the key they entered for it.
- If the user pasted runtime handoff instructions into Customize > Rules > User Rules,
  ask them to delete that text. Do not change their other rules.`,
    finish:
      "Tell the user to reload Cursor and check that the gateway is gone from Customize > MCPs.",
  });
}

function claudeDesktopInstructions(target: DeploymentTarget): string {
  return instructions({
    target,
    label: INSTALLER_CLIENT_LABELS["claude-desktop"],
    inventory: `This runs on the user's host computer. Cowork's code-execution terminal is a VM or
cloud sandbox, so do not change anything there. If you have no permitted host-terminal
access, give the user these steps instead.

Desktop folder: ~/Library/Application Support/Claude-3p on macOS,
%LOCALAPPDATA%\\Claude-3p on Windows, \${XDG_CONFIG_HOME:-~/.config}/Claude-3p on Linux.
- configLibrary/${CLAUDE_DESKTOP_PROFILE_ID}.json: the profile the setup installed. It
  carries the gateway, the shared marketplace and the proxy settings for ${target.host}.
- configLibrary/_meta.json: its entry, and appliedId when that profile is active.
- claude_desktop_config.json: deploymentMode, which the setup set. Files ending in
  .before-archestra hold the state from before the first setup.`,
    remove: `- Ask the user to finish active tasks and quit Claude Desktop. Do not force it to close.
- Delete configLibrary/${CLAUDE_DESKTOP_PROFILE_ID}.json.
- In configLibrary/_meta.json, remove the entry with that id, and remove appliedId if it is that id.
- In claude_desktop_config.json, set deploymentMode to its value in
  claude_desktop_config.json.before-archestra, or remove the key if the backup has none
  or does not exist.
- Then the user reopens Claude Desktop.`,
    finish:
      "Ask the user to check Settings > Connectors and Settings > Plugins, and to remove the gateway or the shared marketplace there if either is still listed.",
  });
}

function genericInstructions(target: DeploymentTarget): string {
  const { base, host } = target;
  return instructions({
    target,
    label: "This App",
    inventory: `Work out which app and version you are running in, then check its config for:
- MCP servers whose URL starts with ${base}/mcp/.
- Skills or a skills marketplace cloned from ${host}/skills/.
- A model provider base URL that points at ${base}, and any x-archestra-* headers.
- Environment variables or tokens the setup added for these (look for ${ARCHESTRA_TOKEN_PREFIX} keys).`,
    remove: `- Remove each MCP server entry and skills folder or marketplace found above.
- For the model provider, set the base URL back to the provider's default (remove the
  override) and keep the provider, model and the user's own API key.
- Remove ${ARCHESTRA_TOKEN_PREFIX} keys and x-archestra-* headers the setup added.
- If the app keeps these settings in its UI, tell the user exactly where to change them.`,
    finish: "Reload or restart the app if it needs to.",
  });
}
