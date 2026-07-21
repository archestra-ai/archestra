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
 * - makes ONE health request for the whole launch:
 *   GET /v1/health?mcp=<id-or-slug>&llm=<id-or-slug>, which reports ok/down
 *   per remote. Reachability alone cannot see a remote that was deleted on
 *   the platform (the data plane answers 401/404 uniformly without auth), so
 *   the platform answers for its own resources; the skills marketplace rides
 *   on the same origin, so endpoint reachability covers it;
 * - retries that single request with capped exponential backoff + jitter for
 *   up to 15s when the platform is unreachable, surfacing a "trying to
 *   connect…" line after 3s and a "hang tight" nudge after 10s, with `s`
 *   (skip) / `d` (disconnect) live the whole time. If the budget runs out,
 *   every remote is treated as down;
 * - then plays the pre-loader animation resource by resource (spinner, ~0.5s
 *   minimum each): green for ok, and the turn STOPS on a down resource to
 *   report "Failed to connect to <type> <id-or-slug>" and prompt;
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
  /** Id-or-slug as embedded in the URL; null when it could not be derived. */
  ref: string | null;
}

interface ClaudeCodeGuardProxySection {
  /** Claude Code proxy providers only. */
  provider: "anthropic" | "bedrock";
  providerLabel: string;
  /** Proxy URL, e.g. https://host/v1/anthropic/<profile-id>. */
  url: string;
  /** Id-or-slug as embedded in the URL; null when it could not be derived. */
  ref: string | null;
}

interface ClaudeCodeGuardSkillsSection {
  marketplaceName: string;
  cloneUrl: string;
}

/** @public — named by the unit tests that build guard fixtures. */
export interface ClaudeCodeStartupGuardContext {
  /** White-label product name (pre-sanitized by the setup-script renderer). */
  appName: string;
  /**
   * The single /v1/health URL covering every checkable remote; null when no
   * remote ref could be derived, which degrades the guard to per-resource
   * reachability probes.
   */
  healthUrl: string | null;
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
 * through, extract each ref from the same URLs connect wires into the client,
 * and build the single health URL. Shared by the bash and PowerShell setup
 * renderers so the two guards can never disagree on what they probe.
 */
export function buildClaudeCodeStartupGuardContext(
  ctx: SetupScriptContext,
): ClaudeCodeStartupGuardContext {
  const mcpParsed = ctx.mcp ? splitResourceUrl(ctx.mcp.url, "/v1/mcp/") : null;
  const proxyParsed = ctx.proxy
    ? splitResourceUrl(ctx.proxy.url, `/v1/${ctx.proxy.provider}/`)
    : null;

  const origin = mcpParsed?.origin ?? proxyParsed?.origin ?? null;
  const params: string[] = [];
  if (mcpParsed) params.push(`mcp=${encodeURIComponent(mcpParsed.ref)}`);
  if (proxyParsed) params.push(`llm=${encodeURIComponent(proxyParsed.ref)}`);
  const healthUrl =
    origin && params.length > 0
      ? `${origin}${CONNECTION_HEALTH_PATH}?${params.join("&")}`
      : null;

  return {
    appName: ctx.appName,
    healthUrl,
    mcp: ctx.mcp
      ? {
          serverName: ctx.mcp.serverName,
          url: ctx.mcp.url,
          ref: mcpParsed?.ref ?? null,
        }
      : null,
    proxy: ctx.proxy
      ? {
          provider: ctx.proxy.provider === "bedrock" ? "bedrock" : "anthropic",
          providerLabel: ctx.proxy.providerLabel,
          url: ctx.proxy.url,
          ref: proxyParsed?.ref ?? null,
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
# one platform health request for all of them — and offers to disconnect any
# that are down (the reverse of connect). It never blocks the launch: the
# shell wrapper runs \`command claude\` no matter how this script exits.
# Disable with ARCHESTRA_CLAUDE_GUARD=0.
set -u

[ "\${ARCHESTRA_CLAUDE_GUARD:-1}" = "0" ] && exit 0
command -v curl >/dev/null 2>&1 || exit 0

APP_NAME=${sh(ctx.appName)}
# One request answers for every checkable remote ('' = no health endpoint
# derivable; the guard then falls back to per-resource reachability probes).
# The platform reports ok/down per remote; a response without a down marker
# (an older backend 404ing the route, a 429) reads as ok — version skew and
# rate limiting can never look like an outage.
HEALTH_URL=${sh(ctx.healthUrl ?? "")}
GUARD_LABELS=(${resources.map((r) => sh(r.label)).join(" ")})
GUARD_URLS=(${resources.map((r) => sh(r.url)).join(" ")})
GUARD_KINDS=(${resources.map((r) => r.kind).join(" ")})
# What a failure line names: resource type followed by its id or slug.
GUARD_FAIL_NAMES=(${resources.map((r) => sh(r.failName)).join(" ")})
# The health-response marker that means this resource is down ('' = resource
# has no per-resource status; it follows overall endpoint reachability).
GUARD_DOWN_MARKERS=(${resources.map((r) => sh(r.downMarker ?? "")).join(" ")})

# Retry budget for the single health request when the platform is
# unreachable: capped exponential backoff (1,2,4,4…s) + 0-1s jitter, 15s
# total. The status line appears after 3s, "hang tight" after 10s. When the
# budget runs out every remote is treated as down.
RETRY_TOTAL_SECONDS=15
NOTICE_AFTER_SECONDS=3
HANG_TIGHT_AFTER_SECONDS=10

# Each resource's turn is padded to a minimum on-screen time so the
# pre-loader reads as a deliberate step instead of a subliminal flash.
MIN_CHECK_FRAMES=7
FRAME_SLEEP=0.08

# Only drive the terminal (and prompt) when a human is watching: a real tty on
# both ends and no -p/--print run. Otherwise check once, warn on stderr, and
# get out of the way — automation must never wait on us.
INTERACTIVE=1
[ -t 0 ] && [ -t 1 ] && { : </dev/tty; } 2>/dev/null || INTERACTIVE=0
for arg in "$@"; do
  case "$arg" in
    -p|--print) INTERACTIVE=0 ;;
  esac
done

HEALTH_BODY=''
fetch_health() { # one attempt; fills HEALTH_BODY. 0 = platform answered.
  HEALTH_BODY=$(curl -sS --connect-timeout 2 --max-time 3 "$HEALTH_URL" 2>/dev/null) || return 1
  # normalize whitespace so the down markers match regardless of how the
  # JSON is formatted (a pretty-printing proxy must not fail-open silently)
  HEALTH_BODY=$(printf '%s' "$HEALTH_BODY" | tr -d '[:space:]')
  return 0
}

# Reachability-only probe, used when no health URL could be derived.
probe_reachable() {
  curl -sS -o /dev/null --connect-timeout 2 --max-time 3 "$1" 2>/dev/null || return 1
  return 0
}

# HEALTH_STATE: ok = platform answered, down = never reached it, '' = no
# health URL (per-resource fallback).
HEALTH_STATE=''

resource_down() { # $1 index; 0 = down
  if [ -z "$HEALTH_URL" ]; then
    probe_reachable "\${GUARD_URLS[$1]}" && return 1
    return 0
  fi
  [ "$HEALTH_STATE" = "down" ] && return 0
  marker="\${GUARD_DOWN_MARKERS[$1]}"
  [ -n "$marker" ] || return 1
  case "$HEALTH_BODY" in
    *"$marker"*) return 0 ;;
  esac
  return 1
}

if [ "$INTERACTIVE" = "0" ]; then
  if [ -n "$HEALTH_URL" ]; then
    fetch_health || HEALTH_STATE='down'
  fi
  i=0
  while [ "$i" -lt "\${#GUARD_URLS[@]}" ]; do
    if resource_down "$i"; then
      printf '%s\\n' "archestra: failed to connect to \${GUARD_FAIL_NAMES[$i]} — claude is configured to use it and may fail. Disconnect it from the $APP_NAME /connection page, or run claude interactively to be offered a disconnect." >&2
    fi
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

spin() { # redraw the current line with the next spinner frame; $1 label, $2 suffix
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
    ctx.mcp
      ? `

MCP_SERVER_NAME=${sh(ctx.mcp.serverName)}`
      : ""
  }${
    ctx.skills
      ? `
SKILLS_MARKETPLACE_NAME=${sh(ctx.skills.marketplaceName)}`
      : ""
  }${
    ctx.proxy
      ? `

${disconnectProxyFunction(ctx)}`
      : ""
  }

# The turn stops on a down resource: report and prompt, default keeps it.
prompt_down() { # $1 index
  line_reset
  printf '%s✖ Failed to connect to %s%s\\n' "$C_ERR" "\${GUARD_FAIL_NAMES[$1]}" "$C_RESET"
  printf '%s  claude is configured to use it and may fail until it is reachable.%s\\n' "$C_DIM" "$C_RESET"
  printf '  [d] disconnect it from Claude Code   [s] continue without it (default)\\n'
  key=''
  read -rs -n 1 key </dev/tty 2>/dev/null || key='s'
  case "$key" in
    d|D) disconnect_resource "\${GUARD_KINDS[$1]}" "\${GUARD_LABELS[$1]}" ;;
    *) mark_skipped "\${GUARD_LABELS[$1]}" ;;
  esac
  return 0
}

# One health request for the whole launch, retried with backoff while the
# spinner plays on the first resource row. s = stop waiting (everything
# still unknown goes down), d = disconnect the shown resource and stop.
FIRST_HANDLED=0
wait_for_health() {
  fetch_health && { HEALTH_STATE='ok'; return 0; }
  start=$(date +%s)
  next_delay=1
  next_attempt=$((start + 1))
  while :; do
    key=''
    read -rs -n 1 -t "$TICK" key </dev/tty 2>/dev/null || true
    case "$key" in
      s|S) break ;;
      d|D) disconnect_resource "\${GUARD_KINDS[0]}" "\${GUARD_LABELS[0]}"; FIRST_HANDLED=1; break ;;
    esac
    now=$(date +%s)
    if [ "$now" -ge "$next_attempt" ]; then
      fetch_health && { HEALTH_STATE='ok'; return 0; }
      next_delay=$((next_delay * 2))
      [ "$next_delay" -gt 4 ] && next_delay=4
      next_attempt=$((now + next_delay + RANDOM % 2))
    fi
    elapsed=$(( $(date +%s) - start ))
    if [ "$elapsed" -ge "$RETRY_TOTAL_SECONDS" ]; then
      break
    elif [ "$elapsed" -ge "$HANG_TIGHT_AFTER_SECONDS" ]; then
      spin "\${GUARD_LABELS[0]}" " $C_DIM— trying to connect... \${elapsed}s, few more seconds, hang tight...  [s] skip  [d] disconnect$C_RESET"
    elif [ "$elapsed" -ge "$NOTICE_AFTER_SECONDS" ]; then
      spin "\${GUARD_LABELS[0]}" " $C_DIM— trying to connect... \${elapsed}s  [s] skip  [d] disconnect$C_RESET"
    fi
  done
  HEALTH_STATE='down'
  return 1
}

printf '\\033[2J\\033[H'
${guardHeader(ctx)}
printf 'Connecting claude via:\\n'
if [ -n "$HEALTH_URL" ]; then
  spin "\${GUARD_LABELS[0]}" ''
  wait_for_health || true
fi
i=0
while [ "$i" -lt "\${#GUARD_URLS[@]}" ]; do
  if [ "$i" = "0" ] && [ "$FIRST_HANDLED" = "1" ]; then
    i=1
    continue
  fi
  spin "\${GUARD_LABELS[$i]}" ''
  pad=0
  while [ "$pad" -lt "$MIN_CHECK_FRAMES" ]; do
    sleep "$FRAME_SLEEP"
    spin "\${GUARD_LABELS[$i]}" ''
    pad=$((pad + 1))
  done
  if resource_down "$i"; then
    prompt_down "$i"
  else
    mark_ok "\${GUARD_LABELS[$i]}"
  fi
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

/** Split a connect-wired URL into origin + the id-or-slug after the marker. */
function splitResourceUrl(
  fullUrl: string,
  marker: string,
): { origin: string; ref: string } | null {
  const idx = fullUrl.indexOf(marker);
  if (idx < 0) return null;
  const origin = fullUrl.slice(0, idx);
  const ref = fullUrl.slice(idx + marker.length).replace(/[/?#].*$/, "");
  if (!ref) return null;
  return { origin, ref };
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
 * The remotes shown in the pre-loader, in check order: LLM proxy, MCP
 * gateway, skills marketplace. The gateway and proxy carry per-resource down
 * markers from the health response; the skills marketplace has no
 * per-resource status — it rides on endpoint reachability (same origin), and
 * a revoked share link never blocks a claude launch.
 */
function guardResources(ctx: ClaudeCodeStartupGuardContext): Array<{
  label: string;
  url: string;
  kind: "proxy" | "mcp" | "skills";
  failName: string;
  downMarker: string | null;
}> {
  const resources: Array<{
    label: string;
    url: string;
    kind: "proxy" | "mcp" | "skills";
    failName: string;
    downMarker: string | null;
  }> = [];
  if (ctx.proxy) {
    resources.push({
      label: `LLM proxy (${ctx.proxy.providerLabel})`,
      url: ctx.proxy.url,
      kind: "proxy",
      failName: `LLM proxy ${ctx.proxy.ref ?? ctx.proxy.providerLabel}`,
      downMarker: ctx.proxy.ref ? `"llm":"down"` : null,
    });
  }
  if (ctx.mcp) {
    resources.push({
      label: `MCP gateway (${ctx.mcp.serverName})`,
      url: ctx.mcp.url,
      kind: "mcp",
      failName: `MCP gateway ${ctx.mcp.ref ?? ctx.mcp.serverName}`,
      downMarker: ctx.mcp.ref ? `"mcp":"down"` : null,
    });
  }
  if (ctx.skills) {
    resources.push({
      label: `Skills marketplace (${ctx.skills.marketplaceName})`,
      url: ctx.skills.cloneUrl,
      kind: "skills",
      failName: `Skills marketplace ${ctx.skills.marketplaceName}`,
      downMarker: null,
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
