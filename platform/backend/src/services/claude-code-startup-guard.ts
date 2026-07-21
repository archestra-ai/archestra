import {
  CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY,
  CLAUDE_CODE_GUARD_MARKER_END,
  CLAUDE_CODE_GUARD_MARKER_START,
  CLAUDE_CODE_GUARD_SCRIPT_RELPATH,
  CLAUDE_CODE_PROXY_ENV_KEYS,
  DEFAULT_APP_NAME,
  EXTERNAL_AGENT_ID_HEADER,
  VIRTUAL_KEY_HEADER,
} from "@archestra/shared";
import { CONNECTION_HEALTH_PATH } from "@/routes/route-paths";
import type { SetupScriptContext } from "./connection-setup-script";

/**
 * Renderer for the Claude Code startup guard ("pre-loader"): a standalone bash
 * script the connect setup script installs at ~/{@link CLAUDE_CODE_GUARD_SCRIPT_RELPATH}
 * plus a `claude()` wrapper function in the user's shell profile. Before every
 * launch the guard checks the Archestra remotes wired into Claude Code — LLM
 * proxy, MCP gateway, skills marketplace, in that order — and:
 *
 * - verifies each remote two ways: transport reachability AND, for the
 *   gateway/proxy, existence via the public connection-health endpoint. The
 *   data-plane endpoints answer uniformly without auth (the gateway 401s for
 *   existing and deleted ids alike), so reachability alone cannot catch a
 *   remote that was deleted on the platform;
 * - paces each check to a ~0.5s minimum with a spinner so the screen reads as
 *   a deliberate pre-flight, then hands off to claude;
 * - a REMOVED remote prompts immediately (the platform answered
 *   authoritatively — retrying would be theater); an UNREACHABLE one retries
 *   with capped exponential backoff + jitter for up to 15s, surfacing a
 *   "trying to connect…" line after 3s and a "hang tight" nudge after 10s,
 *   with `s` (skip) / `d` (disconnect) live the whole time;
 * - disconnecting runs the exact reverse of the connect steps, and the guard
 *   always ends by letting `claude` start.
 *
 * Everything here is deterministic string building — no DB, no I/O — matching
 * connection-setup-script.ts, which embeds these renders into the Claude Code
 * setup script. The emitted bash stays 3.2-compatible (macOS system bash):
 * integer `read -t` fallback, no associative arrays.
 */

interface ClaudeCodeGuardMcpSection {
  /** Logical server name registered in Claude Code (slug). */
  serverName: string;
  /** Gateway URL, e.g. https://host/v1/mcp/<gateway-slug>. */
  url: string;
  /** Public existence-check URL; null falls back to reachability-only. */
  healthUrl: string | null;
}

interface ClaudeCodeGuardProxySection {
  /** Claude Code proxy providers only. */
  provider: "anthropic" | "bedrock";
  providerLabel: string;
  /** Proxy URL, e.g. https://host/v1/anthropic/<profile-id>. */
  url: string;
  /** Public existence-check URL; null falls back to reachability-only. */
  healthUrl: string | null;
}

interface ClaudeCodeGuardSkillsSection {
  marketplaceName: string;
  cloneUrl: string;
}

/** @public — named by the unit tests that build guard fixtures. */
export interface ClaudeCodeStartupGuardContext {
  /** White-label product name (pre-sanitized by the setup-script renderer). */
  appName: string;
  mcp: ClaudeCodeGuardMcpSection | null;
  proxy: ClaudeCodeGuardProxySection | null;
  skills: ClaudeCodeGuardSkillsSection | null;
}

/**
 * The Archestra mark rendered in the pre-loader header (Claude Code renders
 * its own logo the same way). Only shown for the default brand — printing the
 * Archestra icon under a white-labeled name would be wrong — and shared with
 * the PowerShell guard renderer so both platforms draw the same mark.
 */
export const ARCHESTRA_GUARD_MARK_LINES = [
  "   ▟██▙",
  "   ████",
  "  ████",
  "  ████ ▟▙",
  " ▜██▛  ▜▛",
];

/**
 * Derive the guard's context from the setup-script context: pass the remotes
 * through and attach the connection-health URL for the gateway and proxy,
 * extracted from the same URLs connect wires into the client. Shared by the
 * bash and PowerShell setup renderers so the two guards can never disagree on
 * what they probe.
 */
export function buildClaudeCodeStartupGuardContext(
  ctx: SetupScriptContext,
): ClaudeCodeStartupGuardContext {
  return {
    appName: ctx.appName,
    mcp: ctx.mcp
      ? {
          serverName: ctx.mcp.serverName,
          url: ctx.mcp.url,
          healthUrl: healthUrlFor(ctx.mcp.url, "/v1/mcp/", "mcp-gateway"),
        }
      : null,
    proxy: ctx.proxy
      ? {
          provider: ctx.proxy.provider === "bedrock" ? "bedrock" : "anthropic",
          providerLabel: ctx.proxy.providerLabel,
          url: ctx.proxy.url,
          healthUrl: healthUrlFor(
            ctx.proxy.url,
            `/v1/${ctx.proxy.provider}/`,
            "llm-proxy",
          ),
        }
      : null,
    skills: ctx.skills,
  };
}

/**
 * The standalone guard script body (the file at ~/.archestra/…).
 *
 * @public — consumed by the install section below and exercised directly by
 * the unit tests (bash -n + behavioral runs), which knip --production ignores.
 */
export function renderClaudeCodeStartupGuardScript(
  ctx: ClaudeCodeStartupGuardContext,
): string {
  const resources = guardResources(ctx);

  return `#!/usr/bin/env bash
# ${ctx.appName} pre-loader for Claude Code — generated by the ${ctx.appName} /connection page.
# Checks the ${ctx.appName} remotes wired into Claude Code before it starts —
# both that they are reachable and that they still exist on the platform — and
# offers to disconnect any that are gone or down (the reverse of connect).
# It never blocks the launch: the shell wrapper runs \`command claude\` no
# matter how this script exits. Disable with ARCHESTRA_CLAUDE_GUARD=0.
set -u

[ "\${ARCHESTRA_CLAUDE_GUARD:-1}" = "0" ] && exit 0
command -v curl >/dev/null 2>&1 || exit 0

APP_NAME=${sh(ctx.appName)}
GUARD_LABELS=(${resources.map((r) => sh(r.label)).join(" ")})
GUARD_URLS=(${resources.map((r) => sh(r.url)).join(" ")})
GUARD_KINDS=(${resources.map((r) => r.kind).join(" ")})
# Existence-check URLs ('' = reachability only). A health probe answers one of:
# ok (resource exists), missing (the platform says it was deleted), or a
# transport failure (platform unreachable). An older backend without the
# endpoint returns a 404 body with no "missing" marker, which reads as ok —
# version skew degrades to reachability-only, never to a false "deleted".
GUARD_HEALTH_URLS=(${resources.map((r) => sh(r.healthUrl ?? "")).join(" ")})${
    ctx.mcp
      ? `
MCP_SERVER_NAME=${sh(ctx.mcp.serverName)}`
      : ""
  }${
    ctx.skills
      ? `
SKILLS_MARKETPLACE_NAME=${sh(ctx.skills.marketplaceName)}`
      : ""
  }

# Retry budget for an UNREACHABLE remote: capped exponential backoff
# (1,2,4,4…s) + 0-1s jitter, 15s total. The status line appears after 3s,
# "hang tight" after 10s. A remote reported MISSING skips the ladder — the
# answer is authoritative, so the guard prompts immediately.
RETRY_TOTAL_SECONDS=15
NOTICE_AFTER_SECONDS=3
HANG_TIGHT_AFTER_SECONDS=10

# Each check is padded to a minimum on-screen time so the pre-loader reads as
# a deliberate step instead of a subliminal flash.
MIN_CHECK_FRAMES=7
FRAME_SLEEP=0.08

# Only drive the terminal (and prompt) when a human is watching: a real tty on
# both ends and no -p/--print run. Otherwise probe once per remote, warn on
# stderr, and get out of the way — automation must never wait on us.
INTERACTIVE=1
[ -t 0 ] && [ -t 1 ] && { : </dev/tty; } 2>/dev/null || INTERACTIVE=0
for arg in "$@"; do
  case "$arg" in
    -p|--print) INTERACTIVE=0 ;;
  esac
done

# Probe one remote. Returns 0 = ok, 1 = unreachable, 2 = removed on the
# platform. With no health URL, any HTTP response within the timeout counts
# as ok (401 included — the gateway and proxy answer auth errors when up).
probe() { # $1 data-plane url, $2 health url ('' = reachability only)
  if [ -n "$2" ]; then
    guard_health_body=$(curl -sS --connect-timeout 2 --max-time 3 "$2" 2>/dev/null) || return 1
    case "$guard_health_body" in
      *'"status":"missing"'*) return 2 ;;
    esac
    return 0
  fi
  curl -sS -o /dev/null --connect-timeout 2 --max-time 3 "$1" 2>/dev/null || return 1
  return 0
}

if [ "$INTERACTIVE" = "0" ]; then
  i=0
  while [ "$i" -lt "\${#GUARD_URLS[@]}" ]; do
    probe "\${GUARD_URLS[$i]}" "\${GUARD_HEALTH_URLS[$i]}"
    case "$?" in
      1) printf '%s\\n' "archestra: \${GUARD_LABELS[$i]} is unreachable — claude may fail to reach it. Disconnect it from the $APP_NAME /connection page, or run claude interactively to be offered a disconnect." >&2 ;;
      2) printf '%s\\n' "archestra: \${GUARD_LABELS[$i]} was removed on $APP_NAME but claude is still configured to use it — run claude interactively to disconnect it, or use the /connection page." >&2 ;;
    esac
    i=$((i+1))
  done
  exit 0
fi

if [ -z "\${NO_COLOR:-}" ]; then
  C_TITLE=$'\\033[1;36m'; C_OK=$'\\033[32m'; C_ERR=$'\\033[1;31m'
  C_WARN=$'\\033[33m'; C_DIM=$'\\033[2m'; C_RESET=$'\\033[0m'; C_LOGO=$'\\033[1m'
else
  C_TITLE=''; C_OK=''; C_ERR=''; C_WARN=''; C_DIM=''; C_RESET=''; C_LOGO=''
fi

FRAMES=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
FRAME=0

# Sub-second key polling (a smooth spinner during retries) needs bash 4's
# fractional read -t; macOS system bash 3.2 falls back to 1s ticks.
TICK=1
if [ "\${BASH_VERSINFO[0]:-3}" -ge 4 ]; then TICK=0.25; fi

line_reset() { printf '\\r\\033[2K'; }

spin() { # redraw the checking line with the next spinner frame; $1 label, $2 suffix
  FRAME=$(( (FRAME + 1) % 10 ))
  line_reset
  printf '%s%s%s %s%s' "$C_DIM" "\${FRAMES[$FRAME]}" "$C_RESET" "$1" "$2"
}

mark_ok()      { line_reset; printf '%s●%s %s\\n' "$C_OK" "$C_RESET" "$1"; }
mark_skipped() { line_reset; printf '%s○%s %s %s— skipped: still configured, claude may fail to reach it this session%s\\n' "$C_WARN" "$C_RESET" "$1" "$C_DIM" "$C_RESET"; }

disconnect_resource() { # $1 kind, $2 label
  line_reset
  case "$1" in${
    ctx.mcp
      ? `
    mcp)
      command claude mcp remove --scope user "$MCP_SERVER_NAME" </dev/null >/dev/null 2>&1 || true
      command claude mcp remove --scope local "$MCP_SERVER_NAME" </dev/null >/dev/null 2>&1 || true
      printf '%s✖%s %s %s— disconnected: removed the "%s" MCP server from Claude Code%s\\n' \\
        "$C_ERR" "$C_RESET" "$2" "$C_DIM" "$MCP_SERVER_NAME" "$C_RESET"
      ;;`
      : ""
  }${
    ctx.skills
      ? `
    skills)
      command claude plugin marketplace remove "$SKILLS_MARKETPLACE_NAME" </dev/null >/dev/null 2>&1 || true
      printf '%s✖%s %s %s— disconnected: removed the "%s" marketplace from Claude Code%s\\n' \\
        "$C_ERR" "$C_RESET" "$2" "$C_DIM" "$SKILLS_MARKETPLACE_NAME" "$C_RESET"
      ;;`
      : ""
  }${
    ctx.proxy
      ? `
    proxy)
      disconnect_proxy
      printf '%s✖%s %s %s— disconnected: claude talks to the provider directly again%s\\n' \\
        "$C_ERR" "$C_RESET" "$2" "$C_DIM" "$C_RESET"
      ;;`
      : ""
  }
  esac
}${
    ctx.proxy
      ? `

${disconnectProxyFunction(ctx)}`
      : ""
  }

prompt_missing() { # $1 label, $2 kind — the platform says the remote is gone
  line_reset
  printf '%s✖ %s was removed on %s%s %s(the platform reports it no longer exists)%s\\n' "$C_ERR" "$1" "$APP_NAME" "$C_RESET" "$C_DIM" "$C_RESET"
  printf '%s  claude is still configured to use it and will keep failing to connect.%s\\n' "$C_DIM" "$C_RESET"
  printf '  [d] disconnect it from Claude Code (recommended)   [s] keep it (default)\\n'
  key=''
  read -rs -n 1 key </dev/tty 2>/dev/null || key='s'
  case "$key" in
    d|D) disconnect_resource "$2" "$1" ;;
    *) mark_skipped "$1" ;;
  esac
  return 0
}

check_resource() { # $1 label, $2 url, $3 kind, $4 health url
  spin "$1" ''
  probe "$2" "$4"; rc=$?
  # pad to the minimum on-screen time, keeping the spinner alive
  pad=0
  while [ "$pad" -lt "$MIN_CHECK_FRAMES" ]; do
    sleep "$FRAME_SLEEP"
    spin "$1" ''
    pad=$((pad + 1))
  done
  if [ "$rc" = "0" ]; then mark_ok "$1"; return 0; fi
  if [ "$rc" = "2" ]; then prompt_missing "$1" "$3"; return 0; fi
  start=$(date +%s)
  next_delay=1
  next_attempt=$((start + 1))
  while :; do
    key=''
    read -rs -n 1 -t "$TICK" key </dev/tty 2>/dev/null || true
    case "$key" in
      s|S) mark_skipped "$1"; return 0 ;;
      d|D) disconnect_resource "$3" "$1"; return 0 ;;
    esac
    now=$(date +%s)
    if [ "$now" -ge "$next_attempt" ]; then
      probe "$2" "$4"; rc=$?
      if [ "$rc" = "0" ]; then mark_ok "$1"; return 0; fi
      if [ "$rc" = "2" ]; then prompt_missing "$1" "$3"; return 0; fi
      next_delay=$((next_delay * 2))
      [ "$next_delay" -gt 4 ] && next_delay=4
      next_attempt=$((now + next_delay + RANDOM % 2))
    fi
    elapsed=$(( $(date +%s) - start ))
    if [ "$elapsed" -ge "$RETRY_TOTAL_SECONDS" ]; then
      break
    elif [ "$elapsed" -ge "$HANG_TIGHT_AFTER_SECONDS" ]; then
      spin "$1" " $C_DIM— trying to connect... \${elapsed}s, few more seconds, hang tight...  [s] skip  [d] disconnect$C_RESET"
    elif [ "$elapsed" -ge "$NOTICE_AFTER_SECONDS" ]; then
      spin "$1" " $C_DIM— trying to connect... \${elapsed}s  [s] skip  [d] disconnect$C_RESET"
    fi
  done
  line_reset
  printf '%s✖ %s is unreachable%s %s(kept retrying for %ss)%s\\n' "$C_ERR" "$1" "$C_RESET" "$C_DIM" "$RETRY_TOTAL_SECONDS" "$C_RESET"
  printf '%s  claude is configured to use it and may fail until it is back.%s\\n' "$C_DIM" "$C_RESET"
  printf '  [s] continue without it (default)   [d] disconnect it from Claude Code\\n'
  key=''
  read -rs -n 1 key </dev/tty 2>/dev/null || key='s'
  case "$key" in
    d|D) disconnect_resource "$3" "$1" ;;
    *) mark_skipped "$1" ;;
  esac
  return 0
}

printf '\\033[2J\\033[H'
${guardHeader(ctx)}
printf 'Connecting claude via:\\n'
i=0
while [ "$i" -lt "\${#GUARD_URLS[@]}" ]; do
  check_resource "\${GUARD_LABELS[$i]}" "\${GUARD_URLS[$i]}" "\${GUARD_KINDS[$i]}" "\${GUARD_HEALTH_URLS[$i]}"
  i=$((i+1))
done
exit 0
`;
}

/**
 * The setup-script section that installs the guard: writes the script file,
 * marks it executable, and hooks the claude() wrapper into the user's shell
 * profiles inside an idempotent marker block. Relies on the setup script's
 * shared helpers (say/ok) being defined.
 */
export function buildClaudeCodeStartupGuardInstallSection(
  ctx: ClaudeCodeStartupGuardContext,
): string {
  const guardPath = `$HOME/${CLAUDE_CODE_GUARD_SCRIPT_RELPATH}`;

  return `say ${sh(`Installing the ${ctx.appName} startup guard for Claude Code`)}
mkdir -p "$(dirname "${guardPath}")"
cat > "${guardPath}" <<'${GUARD_FILE_EOF}'
${renderClaudeCodeStartupGuardScript(ctx)}${GUARD_FILE_EOF}
chmod +x "${guardPath}"

# Wrap \`claude\` in each shell profile so the guard runs before every launch.
# The block is stripped and re-added, so re-running connect never duplicates it.
archestra_install_guard_block() {
  touch "$1"
  awk -v start=${sh(CLAUDE_CODE_GUARD_MARKER_START)} -v end=${sh(CLAUDE_CODE_GUARD_MARKER_END)} '
    $0 == start {skip=1; next}
    $0 == end {skip=0; next}
    !skip {print}
  ' "$1" > "$1.archestra-tmp" && mv "$1.archestra-tmp" "$1"
  cat >> "$1" <<'${GUARD_PROFILE_EOF}'
${CLAUDE_CODE_GUARD_MARKER_START}
# Pre-flight connectivity check for ${ctx.appName}-connected Claude Code.
# Remove this block and ~/${CLAUDE_CODE_GUARD_SCRIPT_RELPATH} to uninstall.
claude() {
  if [ -x "$HOME/${CLAUDE_CODE_GUARD_SCRIPT_RELPATH}" ]; then
    "$HOME/${CLAUDE_CODE_GUARD_SCRIPT_RELPATH}" "$@" || true
  fi
  command claude "$@"
}
${CLAUDE_CODE_GUARD_MARKER_END}
${GUARD_PROFILE_EOF}
  echo "Updated $1"
}
archestra_guard_hooked=0
if [ -f "$HOME/.zshrc" ]; then archestra_install_guard_block "$HOME/.zshrc"; archestra_guard_hooked=1; fi
if [ -f "$HOME/.bashrc" ]; then archestra_install_guard_block "$HOME/.bashrc"; archestra_guard_hooked=1; fi
if [ "$archestra_guard_hooked" = "0" ]; then
  case "\${SHELL:-}" in
    *zsh*) archestra_install_guard_block "$HOME/.zshrc" ;;
    *) archestra_install_guard_block "$HOME/.bashrc" ;;
  esac
fi
ok "Startup guard installed — new terminals check your ${ctx.appName} remotes before claude starts."`;
}

// ===================================================================
// Internal helpers
// ===================================================================

/** Heredoc delimiters; must never appear on a line of the embedded bodies. */
const GUARD_FILE_EOF = "ARCHESTRA_CLAUDE_GUARD_EOF";
const GUARD_PROFILE_EOF = "ARCHESTRA_CLAUDE_GUARD_PROFILE_EOF";

/** Single-quote a value for bash; safe for arbitrary content. */
function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Public existence-check URL derived from the connect-wired data-plane URL. */
function healthUrlFor(
  fullUrl: string,
  marker: string,
  kind: "mcp-gateway" | "llm-proxy",
): string | null {
  const idx = fullUrl.indexOf(marker);
  if (idx < 0) return null;
  const origin = fullUrl.slice(0, idx);
  const ref = fullUrl.slice(idx + marker.length).replace(/[/?#].*$/, "");
  if (!ref) return null;
  return `${origin}${CONNECTION_HEALTH_PATH}?kind=${kind}&ref=${encodeURIComponent(ref)}`;
}

/**
 * The pre-loader header: the Archestra mark with the title beside it, the way
 * Claude Code draws its own logo — but only for the default brand. White-label
 * deployments get the plain title line.
 */
function guardHeader(ctx: ClaudeCodeStartupGuardContext): string {
  if (ctx.appName !== DEFAULT_APP_NAME) {
    return `printf '%s%s Pre-loader%s\\n\\n' "$C_TITLE" "$APP_NAME" "$C_RESET"`;
  }
  const [m0, m1, m2, m3, m4] = ARCHESTRA_GUARD_MARK_LINES;
  return `printf '%s${m0}%s\\n' "$C_LOGO" "$C_RESET"
printf '%s${m1}%s      %s%s Pre-loader%s\\n' "$C_LOGO" "$C_RESET" "$C_TITLE" "$APP_NAME" "$C_RESET"
printf '%s${m2}%s       %sSecure access to your AI tools%s\\n' "$C_LOGO" "$C_RESET" "$C_DIM" "$C_RESET"
printf '%s${m3}%s\\n' "$C_LOGO" "$C_RESET"
printf '%s${m4}%s\\n\\n' "$C_LOGO" "$C_RESET"`;
}

/**
 * The remotes to probe, in the order the pre-loader checks (and the demo
 * shows) them: LLM proxy, MCP gateway, skills marketplace. The skills
 * marketplace has no existence endpoint — a revoked share link never blocks a
 * claude launch — so it stays a reachability-only probe.
 */
function guardResources(ctx: ClaudeCodeStartupGuardContext): Array<{
  label: string;
  url: string;
  kind: "proxy" | "mcp" | "skills";
  healthUrl: string | null;
}> {
  const resources: Array<{
    label: string;
    url: string;
    kind: "proxy" | "mcp" | "skills";
    healthUrl: string | null;
  }> = [];
  if (ctx.proxy) {
    resources.push({
      label: `LLM proxy (${ctx.proxy.providerLabel})`,
      url: ctx.proxy.url,
      kind: "proxy",
      healthUrl: ctx.proxy.healthUrl,
    });
  }
  if (ctx.mcp) {
    resources.push({
      label: `MCP gateway (${ctx.mcp.serverName})`,
      url: ctx.mcp.url,
      kind: "mcp",
      healthUrl: ctx.mcp.healthUrl,
    });
  }
  if (ctx.skills) {
    resources.push({
      label: `Skills marketplace (${ctx.skills.marketplaceName})`,
      url: ctx.skills.cloneUrl,
      kind: "skills",
      healthUrl: null,
    });
  }
  return resources;
}

/**
 * The proxy disconnect action: strip exactly the env keys connect set (per
 * provider, from the shared {@link CLAUDE_CODE_PROXY_ENV_KEYS} list) from
 * ~/.claude/settings.json, keeping the user's own custom-header lines. Falls
 * back to printed manual steps when python3 is missing, mirroring the connect
 * script's merge fallback.
 */
function disconnectProxyFunction(ctx: ClaudeCodeStartupGuardContext): string {
  const provider = ctx.proxy?.provider ?? "anthropic";
  const envKeys = CLAUDE_CODE_PROXY_ENV_KEYS[provider];
  const ourHeaderNames = [EXTERNAL_AGENT_ID_HEADER, VIRTUAL_KEY_HEADER]
    .map((name) => `"${name.toLowerCase()}"`)
    .join(", ");
  const bedrockNote =
    provider === "bedrock"
      ? `
  printf '%s  If you exported AWS_BEARER_TOKEN_BEDROCK in your shell profile, remove it there too.%s\\n' "$C_DIM" "$C_RESET"`
      : "";

  const strippedKeysList = envKeys.map((key) => `"${key}"`).join(", ");

  return `disconnect_proxy() {
  if command -v python3 >/dev/null 2>&1; then
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
  else
    printf '%s  python3 not found — remove these keys from the env block of ~/.claude/settings.json manually: ${envKeys.join(", ")} (and our lines in ${CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY}).%s\\n' "$C_WARN" "$C_RESET"
  fi${bedrockNote}
}`;
}
