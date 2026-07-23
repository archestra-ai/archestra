import {
  CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY,
  CLAUDE_CODE_PROXY_ENV_KEYS,
  EXTERNAL_AGENT_ID_HEADER,
  STARTUP_GUARD_INSTALL,
  VIRTUAL_KEY_HEADER,
} from "@archestra/shared";
import type { StartupGuardClient, StartupGuardContext } from "./startup-guard";

/**
 * Per-client startup-guard descriptors — the client-specific half of the guard
 * (the shared engine lives in `startup-guard.ts`). Each descriptor supplies the
 * wrapped binary, the conversational product name shown in prompts, the install
 * locations (from the shared {@link STARTUP_GUARD_INSTALL} record), the
 * non-interactive launch flags to bow out on, and the exact reverse-of-connect
 * disconnect commands the guard runs when a remote is unreachable.
 *
 * Cursor is deliberately absent: it is a GUI IDE with no wrappable terminal
 * launch command, so its connect is reversed from the Disconnect panel rather
 * than a startup guard.
 */

/** Single-quote a value for bash; safe for arbitrary content. */
function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// ===================================================================
// Claude Code
// ===================================================================

export const CLAUDE_CODE_GUARD_CLIENT: StartupGuardClient = {
  clientId: "claude-code",
  binary: "claude",
  label: "Claude Code",
  promptName: "Claude",
  disableEnvVar: "ARCHESTRA_CLAUDE_GUARD",
  ...STARTUP_GUARD_INSTALL["claude-code"],
  // Claude Code's non-interactive one-shot mode.
  nonInteractiveArgPatterns: ["-p", "--print"],
  mcpDisconnectCommands: `      command claude mcp remove --scope user "$MCP_SERVER_NAME" </dev/null >/dev/null 2>&1 || true
      command claude mcp remove --scope local "$MCP_SERVER_NAME" </dev/null >/dev/null 2>&1 || true`,
  skillsDisconnectCommands: `      command claude plugin marketplace remove "$SKILLS_MARKETPLACE_NAME" </dev/null >/dev/null 2>&1 || true`,
  renderProxyDisconnect: claudeProxyDisconnect,
};

/**
 * Claude Code's proxy disconnect: strip exactly the env keys connect set (per
 * provider, from the shared {@link CLAUDE_CODE_PROXY_ENV_KEYS} list) from
 * ~/.claude/settings.json, keeping the user's own custom-header lines. Falls
 * back to printed manual steps when python3 is missing, mirroring the connect
 * script's merge fallback.
 */
function claudeProxyDisconnect(ctx: StartupGuardContext): string {
  const provider = ctx.proxy?.provider === "bedrock" ? "bedrock" : "anthropic";
  const envKeys = CLAUDE_CODE_PROXY_ENV_KEYS[provider];
  const ourHeaderNames = [EXTERNAL_AGENT_ID_HEADER, VIRTUAL_KEY_HEADER]
    .map((name) => `"${name.toLowerCase()}"`)
    .join(", ");
  const bedrockNote =
    provider === "bedrock"
      ? `
  line_reset
  printf '%s  If you exported AWS_BEARER_TOKEN_BEDROCK in your shell profile, remove it there too.%s\\n' "$C_DIM" "$C_RESET"`
      : "";

  const strippedKeysList = envKeys.map((key) => `"${key}"`).join(", ");

  return `disconnect_proxy() {
  command -v python3 >/dev/null 2>&1 || return 0
  python3 - <<'ARCHESTRA_GUARD_PY'
import json, os, pathlib
path = pathlib.Path(os.path.expanduser("~/.claude/settings.json"))
if not path.exists():
    raise SystemExit(0)
raw = path.read_text().strip()
if not raw:
    raise SystemExit(0)
settings = json.loads(raw)
env = settings.get("env")
if not isinstance(env, dict):
    raise SystemExit(0)
backup = path.with_name(path.name + ".archestra-guard-backup")
if not backup.exists():
    backup.write_text(json.dumps(settings, indent=2) + "\\n")
for key in [${strippedKeysList}]:
    env.pop(key, None)
# Drop only our header lines; the user's other custom headers survive.
ours = {${ourHeaderNames}}
existing = env.get("${CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY}", "") or ""
lines = [
    ln for ln in existing.splitlines()
    if ln.strip() and ln.split(":", 1)[0].strip().lower() not in ours
]
if lines:
    env["${CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY}"] = "\\n".join(lines)
else:
    env.pop("${CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY}", None)
if not env:
    settings.pop("env", None)
path.write_text(json.dumps(settings, indent=2) + "\\n")
ARCHESTRA_GUARD_PY
}

# Printed after the Disconnected line — the strip itself runs silenced in
# the background while the spinner plays.
proxy_disconnect_notes() {
  if ! command -v python3 >/dev/null 2>&1; then
    line_reset
    printf '%s  python3 not found — remove these keys from the env block of ~/.claude/settings.json manually: ${envKeys.join(", ")} (and our lines in ${CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY}).%s\\n' "$C_WARN" "$C_RESET"
  fi${bedrockNote}
  return 0
}`;
}

// ===================================================================
// Codex
// ===================================================================

export const CODEX_GUARD_CLIENT: StartupGuardClient = {
  clientId: "codex",
  binary: "codex",
  label: "Codex",
  promptName: "Codex",
  disableEnvVar: "ARCHESTRA_CODEX_GUARD",
  ...STARTUP_GUARD_INSTALL.codex,
  // `codex exec …` is Codex's non-interactive one-shot subcommand.
  nonInteractiveArgPatterns: ["exec"],
  mcpDisconnectCommands: `      command codex mcp remove "$MCP_SERVER_NAME" </dev/null >/dev/null 2>&1 || true`,
  skillsDisconnectCommands: `      command codex plugin marketplace remove "$SKILLS_MARKETPLACE_NAME" </dev/null >/dev/null 2>&1 || true`,
  renderProxyDisconnect: codexProxyDisconnect,
};

/**
 * Codex's proxy disconnect: strip the `# >>> archestra:<proxyName> >>>` …
 * `# <<< archestra:<proxyName> <<<` block connect appended to
 * ~/.codex/config.toml (awk, no python3 dependency). The Codex login credential
 * is left intact — removing the provider block already stops routing through
 * Archestra — with a note pointing at `codex logout` when a virtual key was used.
 */
function codexProxyDisconnect(ctx: StartupGuardContext): string {
  const marker = `archestra:${ctx.proxy?.proxyName ?? ""}`;
  return `disconnect_proxy() {
  CONFIG="$HOME/.codex/config.toml"
  [ -f "$CONFIG" ] || return 0
  awk -v start=${sh(`# >>> ${marker} >>>`)} -v end=${sh(`# <<< ${marker} <<<`)} '
    $0 == start {skip=1; next}
    $0 == end {skip=0; next}
    !skip {print}
  ' "$CONFIG" > "$CONFIG.archestra-tmp" 2>/dev/null && mv "$CONFIG.archestra-tmp" "$CONFIG"
}

proxy_disconnect_notes() {
  line_reset
  printf '%s  Removed the Archestra provider from ~/.codex/config.toml. If you signed Codex in with an Archestra virtual key, run \`codex logout\` (then log back in) to restore your own credentials.%s\\n' "$C_DIM" "$C_RESET"
  return 0
}`;
}

// ===================================================================
// Copilot CLI
// ===================================================================

export const COPILOT_GUARD_CLIENT: StartupGuardClient = {
  clientId: "copilot-cli",
  binary: "copilot",
  label: "Copilot CLI",
  promptName: "Copilot",
  disableEnvVar: "ARCHESTRA_COPILOT_GUARD",
  ...STARTUP_GUARD_INSTALL["copilot-cli"],
  // Copilot CLI's non-interactive one-shot flag.
  nonInteractiveArgPatterns: ["-p", "--prompt"],
  mcpDisconnectCommands: `      command copilot mcp remove "$MCP_SERVER_NAME" </dev/null >/dev/null 2>&1 || true`,
  skillsDisconnectCommands: `      command copilot plugin marketplace remove "$SKILLS_MARKETPLACE_NAME" </dev/null >/dev/null 2>&1 || true`,
  renderProxyDisconnect: copilotProxyDisconnect,
};

/**
 * Copilot CLI's proxy disconnect: Copilot is configured through
 * `COPILOT_PROVIDER_*` environment exports (connect prints them for the user to
 * paste into a shell profile), so the reverse is best-effort — strip any
 * `export COPILOT_PROVIDER_{TYPE,BASE_URL,API_KEY}=…` lines from the common
 * shell profiles, leaving the user's own `COPILOT_MODEL` choice untouched.
 */
function copilotProxyDisconnect(_ctx: StartupGuardContext): string {
  return `disconnect_proxy() {
  for profile in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
    [ -f "$profile" ] || continue
    grep -Eq '^[[:space:]]*export[[:space:]]+COPILOT_PROVIDER_(TYPE|BASE_URL|API_KEY)=' "$profile" 2>/dev/null || continue
    grep -Ev '^[[:space:]]*export[[:space:]]+COPILOT_PROVIDER_(TYPE|BASE_URL|API_KEY)=' "$profile" > "$profile.archestra-tmp" 2>/dev/null && mv "$profile.archestra-tmp" "$profile"
  done
}

proxy_disconnect_notes() {
  line_reset
  printf '%s  Removed any COPILOT_PROVIDER_* export lines from your shell profiles — open a new terminal so the change takes effect.%s\\n' "$C_DIM" "$C_RESET"
  return 0
}`;
}
