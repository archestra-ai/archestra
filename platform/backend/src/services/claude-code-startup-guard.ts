import {
  CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY,
  CLAUDE_CODE_GUARD_MARKER_END,
  CLAUDE_CODE_GUARD_MARKER_START,
  CLAUDE_CODE_GUARD_SCRIPT_RELPATH,
  CLAUDE_CODE_GUARD_SKIP_RELPATH,
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
 *   connect…" line after 3s — with the disconnect (Y/n) offer on its own
 *   line below it — and a "hang tight" nudge after 10s. `y`/`n` answer it
 *   the whole wait. If the budget runs out, every remote is treated as
 *   down;
 * - then plays the pre-loader animation resource by resource (~0.75s of
 *   appended trailing dots — append-only output cannot flicker). Every row
 *   is on screen from the start: the probing row bright, pending rows dim
 *   below it, text aligned into the glyph column. A row lands on a check
 *   for ok, "Failed to connect to <type> (<id-or-slug>)" for a down one — and
 *   after the whole turn, ONE "Disconnect … from Claude? (Y/n)" prompt covers
 *   every down remote. Everything draws on the alternate screen, so the
 *   terminal is clean again after claude exits;
 * - disconnecting runs the exact reverse of the connect steps and records the
 *   remote in a skip file so later launches don't re-check it. Once nothing
 *   connected is left to check, the guard uninstalls itself entirely (script,
 *   skip file, profile wrapper blocks) — a leftover no-op hook is a
 *   dependency that can only ever break a future claude launch;
 * - the guard always ends by letting `claude` start.
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
# one platform health request for all of them — and offers to disconnect
# everything that is down in one keypress (the reverse of connect). It never
# blocks the launch: the shell wrapper runs \`command claude\` no matter how
# this script exits. Disable with ARCHESTRA_CLAUDE_GUARD=0.
set -u

[ "\${ARCHESTRA_CLAUDE_GUARD:-1}" = "0" ] && exit 0
command -v curl >/dev/null 2>&1 || exit 0

APP_NAME=${sh(ctx.appName)}
GUARD_PATH="$HOME/${CLAUDE_CODE_GUARD_SCRIPT_RELPATH}"
# Remotes this guard's own disconnect action already removed from Claude
# Code, one kind per line. They are skipped below; connect clears the file.
SKIP_FILE="$HOME/${CLAUDE_CODE_GUARD_SKIP_RELPATH}"
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

# Each resource's turn shows ~0.75s of animation — enough to read as a
# deliberate step, short enough to never feel like waiting. A tick appends
# one unhurried trailing dot every ~250ms.
MIN_CHECK_FRAMES=3
FRAME_SLEEP=0.25

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

GUARD_SKIP=" $(tr '\\n' ' ' 2>/dev/null < "$SKIP_FILE") "
already_disconnected() { case "$GUARD_SKIP" in *" $1 "*) return 0 ;; esac; return 1; }
remember_disconnected() { printf '%s\\n' "$1" >> "$SKIP_FILE" 2>/dev/null || true; }

# Once nothing connected is left to check, the guard removes itself entirely
# — script, skip file, and the profile wrapper blocks. A leftover no-op hook
# is a dependency that can only ever break a future claude launch (deleted
# files, reconfigured shells); connect re-installs everything.
uninstall_guard() {
  rm -f "$GUARD_PATH" "$SKIP_FILE" 2>/dev/null || true
  for profile in "$HOME/.zshrc" "$HOME/.bashrc"; do
    [ -f "$profile" ] || continue
    awk -v start=${sh(CLAUDE_CODE_GUARD_MARKER_START)} -v end=${sh(CLAUDE_CODE_GUARD_MARKER_END)} '
      $0 == start {skip=1; next}
      $0 == end {skip=0; next}
      !skip {print}
    ' "$profile" > "$profile.archestra-tmp" 2>/dev/null && mv "$profile.archestra-tmp" "$profile"
  done
}

GUARD_ACTIVE=()
ACTIVE_IDXS=''
ACTIVE_TOTAL=0
FIRST_ACTIVE=0
i=0
while [ "$i" -lt "\${#GUARD_URLS[@]}" ]; do
  if already_disconnected "\${GUARD_KINDS[$i]}"; then
    GUARD_ACTIVE[$i]=0
  else
    GUARD_ACTIVE[$i]=1
    [ "$ACTIVE_TOTAL" -eq 0 ] && FIRST_ACTIVE=$i
    ACTIVE_IDXS="$ACTIVE_IDXS $i"
    ACTIVE_TOTAL=$((ACTIVE_TOTAL + 1))
  fi
  i=$((i+1))
done
if [ "$ACTIVE_TOTAL" -eq 0 ]; then
  uninstall_guard
  exit 0
fi

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
    if [ "\${GUARD_ACTIVE[$i]}" = "1" ] && resource_down "$i"; then
      printf '%s\\n' "archestra: failed to connect to \${GUARD_FAIL_NAMES[$i]} — claude is configured to use it and may fail. Disconnect it from the $APP_NAME /connection page, or run claude interactively to be offered a disconnect." >&2
    fi
    i=$((i+1))
  done
  exit 0
fi

if [ -z "\${NO_COLOR:-}" ]; then
  C_TITLE=$'\\033[1;36m'; C_ACCENT=$'\\033[95m'; C_ERR=$'\\033[1;31m'
  C_WARN=$'\\033[33m'; C_DIM=$'\\033[2m'; C_RESET=$'\\033[0m'; C_LOGO=$'\\033[1m'
else
  C_TITLE=''; C_ACCENT=''; C_ERR=''; C_WARN=''; C_DIM=''; C_RESET=''; C_LOGO=''
fi

# Sub-second key polling during retries needs bash 4's fractional read -t;
# macOS system bash 3.2 falls back to 1s ticks.
TICK=1
if [ "\${BASH_VERSINFO[0]:-3}" -ge 4 ]; then TICK=0.25; fi
# The [C] window on the all-healthy pass. Fractional read -t needs bash 4;
# 3.2 rounds it up to a whole second.
RECONFIG_WAIT=2
if [ "\${BASH_VERSINFO[0]:-3}" -ge 4 ]; then RECONFIG_WAIT=1.5; fi
ARCH_ESC=$(printf '\\033')

line_reset() { printf '\\r\\033[2K'; }

# Progress is the row's text growing dim trailing dots — each tick only
# APPENDS one character, never rewrites the line, so nothing can flicker
# by construction. (Glyph spinners redraw in place every frame; every
# terminal renders that as some degree of strobing — caught live on
# Windows Terminal.) The line wraps back after a few dots so a slow
# disconnect can't grow it forever. The probing row prints bright — dim is
# reserved for the pending rows waiting below it — and its two leading
# spaces reserve the glyph column, so the first text character lines up
# across pending, probing, and probed rows.
SPIN_TEXT=''
SPIN_DOTS=0
spin_start() { # $1 line text
  SPIN_TEXT="$1"
  SPIN_DOTS=0
  line_reset
  printf '  %s' "$1"
}
spin_tick() {
  SPIN_DOTS=$((SPIN_DOTS + 1))
  if [ "$SPIN_DOTS" -gt 8 ]; then
    spin_start "$SPIN_TEXT"
    return 0
  fi
  printf '%s.%s' "$C_DIM" "$C_RESET"
}

# Status glyphs stay in the narrow ranges (○ ✓ ✗) so every row's icon and
# text start in the same column — the heavy ✖/✔ render double-width in
# common Windows fonts and break the alignment.
mark_ok()   { line_reset; printf '%s✓%s %s\\n' "$C_ACCENT" "$C_RESET" "$1"; }
mark_down() { line_reset; printf '%s✗ Failed to connect to %s%s\\n' "$C_ERR" "\${GUARD_FAIL_NAMES[$1]}" "$C_RESET"; }

disconnect_actions() { # $1 kind — the reverse-of-connect commands, silenced
  case "$1" in${
    ctx.mcp
      ? `
    mcp)
      command claude mcp remove --scope user "$MCP_SERVER_NAME" </dev/null >/dev/null 2>&1 || true
      command claude mcp remove --scope local "$MCP_SERVER_NAME" </dev/null >/dev/null 2>&1 || true
      ;;`
      : ""
  }${
    ctx.skills
      ? `
    skills)
      command claude plugin marketplace remove "$SKILLS_MARKETPLACE_NAME" </dev/null >/dev/null 2>&1 || true
      ;;`
      : ""
  }${
    ctx.proxy
      ? `
    proxy)
      disconnect_proxy
      ;;`
      : ""
  }
  esac
}

# Reversing a connect step animates the same way the probes do: the commands
# run in the background while the dots grow, then the row lands on a check.
disconnect_resource() { # $1 kind, $2 label
  spin_start "Disconnecting $2"
  disconnect_actions "$1" >/dev/null 2>&1 &
  arch_dp=$!
  pad=0
  while kill -0 "$arch_dp" 2>/dev/null || [ "$pad" -lt "$MIN_CHECK_FRAMES" ]; do
    sleep "$FRAME_SLEEP"
    spin_tick
    pad=$((pad + 1))
  done
  wait "$arch_dp" 2>/dev/null || true
  line_reset
  printf '%s✓%s Disconnected %s\\n' "$C_ACCENT" "$C_RESET" "$2"${
    ctx.proxy
      ? `
  [ "$1" = "proxy" ] && proxy_disconnect_notes`
      : ""
  }
  return 0
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

disconnect_and_forget() { # $@ = resource indices: reverse connect, then skip on later launches
  for i in "$@"; do
    disconnect_resource "\${GUARD_KINDS[$i]}" "\${GUARD_LABELS[$i]}"
    remember_disconnected "\${GUARD_KINDS[$i]}"
  done
}

# ---- Reconfigure menu -------------------------------------------------
# Opened with [C] from the prompt under the rows. Every remote is already on
# screen in a stable block, so the menu just re-decorates those rows in place
# ([n] label) and reads number keys — no redraw, no layout jump. Pressing a
# number disconnects that remote (reverse-of-connect, then remembered) and
# lands its row on the purple check; Esc or Enter leaves and lets claude
# start. Removing the last connected remote takes the guard with it. Rows
# list every active remote regardless of reachability.
MENU_DONE=' '
menu_at_row()    { printf '\\033[%dA\\r\\033[2K' "$((ACTIVE_TOTAL - $1 + 1))"; }
menu_leave_row() { printf '\\033[%dB\\r' "$((ACTIVE_TOTAL - $1 + 1))"; }
menu_paint_row() { # $1 pos, $2 idx — draw its current menu state in place
  menu_at_row "$1"
  case "$MENU_DONE" in
    *" $2 "*) printf '%s✓%s Disconnected %s' "$C_ACCENT" "$C_RESET" "\${GUARD_LABELS[$2]}" ;;
    *)        printf '%s[%s]%s %s' "$C_ACCENT" "$1" "$C_RESET" "\${GUARD_LABELS[$2]}" ;;
  esac
  menu_leave_row "$1"
}
menu_disconnect_row() { # $1 pos, $2 idx — animate the reversal on its own row
  menu_at_row "$1"
  spin_start "Disconnecting \${GUARD_LABELS[$2]}"
  disconnect_actions "\${GUARD_KINDS[$2]}" >/dev/null 2>&1 &
  arch_dp=$!
  pad=0
  while kill -0 "$arch_dp" 2>/dev/null || [ "$pad" -lt "$MIN_CHECK_FRAMES" ]; do
    sleep "$FRAME_SLEEP"
    spin_tick
    pad=$((pad + 1))
  done
  wait "$arch_dp" 2>/dev/null || true
  line_reset
  printf '%s✓%s Disconnected %s' "$C_ACCENT" "$C_RESET" "\${GUARD_LABELS[$2]}"
  menu_leave_row "$1"
  remember_disconnected "\${GUARD_KINDS[$2]}"
}
reconfigure_menu() {
  GUARD_DWELL=1
  MENU_DONE=' '
  menu_pos=0
  for menu_idx in $ACTIVE_IDXS; do
    menu_pos=$((menu_pos + 1))
    menu_paint_row "$menu_pos" "$menu_idx"
  done
  printf '\\033[s\\n\\r\\033[2K%s  Press 1-%s to disconnect a resource from Claude · [Esc] Done%s\\033[u' "$C_DIM" "$ACTIVE_TOTAL" "$C_RESET"
  while :; do
    key=''
    read -rs -n 1 key </dev/tty 2>/dev/null || break
    case "$key" in
      ''|q|Q|"$ARCH_ESC") break ;;
      [1-9])
        menu_pos=0; menu_target=''
        for menu_idx in $ACTIVE_IDXS; do
          menu_pos=$((menu_pos + 1))
          [ "$menu_pos" = "$key" ] && { menu_target=$menu_idx; break; }
        done
        [ -z "$menu_target" ] && continue
        case "$MENU_DONE" in *" $menu_target "*) continue ;; esac
        menu_disconnect_row "$key" "$menu_target"
        MENU_DONE="$MENU_DONE$menu_target "
        menu_left=0
        for menu_idx in $ACTIVE_IDXS; do
          case "$MENU_DONE" in *" $menu_idx "*) ;; *) menu_left=$((menu_left + 1)) ;; esac
        done
        if [ "$menu_left" -eq 0 ]; then
          uninstall_guard
          break
        fi
        ;;
    esac
  done
  # clear the footer; repaint any still-connected row back to its check result
  printf '\\033[s\\n\\r\\033[2K\\033[u'
  menu_pos=0
  for menu_idx in $ACTIVE_IDXS; do
    menu_pos=$((menu_pos + 1))
    case "$MENU_DONE" in *" $menu_idx "*) continue ;; esac
    menu_at_row "$menu_pos"
    if resource_down "$menu_idx"; then
      printf '%s✗ Failed to connect to %s%s' "$C_ERR" "\${GUARD_FAIL_NAMES[$menu_idx]}" "$C_RESET"
    else
      printf '%s✓%s %s' "$C_ACCENT" "$C_RESET" "\${GUARD_LABELS[$menu_idx]}"
    fi
    menu_leave_row "$menu_pos"
  done
  return 0
}

# The persistent entry under the rows. It is drawn once BEFORE the first
# probe and stays on screen the whole run — through every check and the
# healthy pass's closing beat — so [C] is always offered, never just at the
# end. Drawn one line below the block via save/restore, so the rows above
# keep animating without touching it.
RECONFIG_HINT_TEXT="  To reconfigure your $APP_NAME connection press [C]"
draw_reconfigure_hint() { printf '\\033[s\\n\\r\\033[2K%s%s%s\\033[u' "$C_DIM" "$RECONFIG_HINT_TEXT" "$C_RESET"; }
clear_reconfigure_hint() { printf '\\033[s\\n\\r\\033[2K\\033[u'; }

# The healthy pass's closing beat: the hint is already on screen, so just wait
# RECONFIG_WAIT for the key before letting claude start. A [C] pressed earlier
# while the probes ran was buffered (echo is off, so it left no smudge) and is
# read here.
offer_reconfigure_tail() {
  key=''
  read -rs -n 1 -t "$RECONFIG_WAIT" key </dev/tty 2>/dev/null || key=''
  clear_reconfigure_hint
  case "$key" in
    c|C) reconfigure_menu ;;
  esac
  return 0
}

# When something is down: the quick (Y/n) reverses everything that failed in
# one keypress, and [C] opens the full reconfigure menu instead. Anything
# else keeps them. When every remote is down and the user disconnects them
# all, nothing is left to check, so the guard silently removes itself too —
# the Disconnected rows say everything.
prompt_down_all() {
  if [ "$DOWN_COUNT" -eq 1 ]; then
    set -- $DOWN_IDXS
    down_prompt="Disconnect \${GUARD_FAIL_NAMES[$1]} from Claude now? (Y/n)"
  else
    down_prompt="Disconnect all $DOWN_COUNT unreachable resources from Claude now? (Y/n)"
  fi
  printf '\\033[s\\n\\r\\033[2K%s\\n\\r\\033[2K%s  or press [C] to reconfigure your %s connection%s\\033[u' "$down_prompt" "$C_DIM" "$APP_NAME" "$C_RESET"
  key=''
  read -rs -n 1 key </dev/tty 2>/dev/null || key='n'
  printf '\\033[s\\n\\r\\033[2K\\n\\r\\033[2K\\033[u'
  case "$key" in
    c|C)
      reconfigure_menu
      ;;
    y|Y|'')
      GUARD_DWELL=1
      disconnect_and_forget $DOWN_IDXS
      [ "$DOWN_COUNT" -ge "$ACTIVE_TOTAL" ] && uninstall_guard
      ;;
    *)
      line_reset
      if [ "$DOWN_COUNT" -eq 1 ]; then
        printf '%s○%s %sSkipped — still configured; Claude may fail to reach it this session%s\\n' "$C_WARN" "$C_RESET" "$C_DIM" "$C_RESET"
      else
        printf '%s○%s %sSkipped — still configured; Claude may fail to reach them this session%s\\n' "$C_WARN" "$C_RESET" "$C_DIM" "$C_RESET"
      fi
      ;;
  esac
  return 0
}

# The disconnect offer during the retry ladder is the same classic (Y/n)
# prompt, on its own line below the row after a blank line — drawn once via
# cursor save/restore so the dots keep appending to the row above it, and
# wiped again the moment the wait resolves. The platform being unreachable
# affects every active remote, so answering yes disconnects them all.
WAIT_PROMPT_SHOWN=0
show_wait_prompt() {
  [ "$WAIT_PROMPT_SHOWN" = "1" ] && return 0
  WAIT_PROMPT_SHOWN=1
  if [ "$ACTIVE_TOTAL" -eq 1 ]; then
    wait_prompt="Disconnect \${GUARD_FAIL_NAMES[$FIRST_ACTIVE]} from Claude now? (Y/n)"
  else
    wait_prompt="Disconnect all $ACTIVE_TOTAL unreachable resources from Claude now? (Y/n)"
  fi
  # two lines below the block: the persistent [C] hint sits at +1, this
  # (Y/n) offer at +2, so both stay visible during the outage wait
  printf '\\033[s\\033[%dB\\r\\033[2K%s \\033[u' "$((ACTIVE_TOTAL + 2))" "$wait_prompt"
}
clear_wait_prompt() {
  [ "$WAIT_PROMPT_SHOWN" = "1" ] && printf '\\033[s\\033[%dB\\r\\033[2K\\033[u' "$((ACTIVE_TOTAL + 2))"
  WAIT_PROMPT_SHOWN=0
  return 0
}

# One health request for the whole launch, retried with backoff while the
# spinner plays on the first resource row. y = disconnect every remote now
# (they are all unreachable) — and with nothing left to check, remove the
# startup check itself; n = skip the checks for this launch. Both answer
# keys are live the whole wait; bare Enter accepts the disconnect default
# only once the prompt is actually on screen.
SKIP_ALL=0
DISC_ALL=0
LAST_WAIT_NOTE=''
wait_for_health() {
  fetch_health && { HEALTH_STATE='ok'; return 0; }
  start=$(date +%s)
  next_delay=1
  next_attempt=$((start + 1))
  last_elapsed=0
  while :; do
    key=''
    got_key=0
    read -rs -n 1 -t "$TICK" key </dev/tty 2>/dev/null && got_key=1
    if [ "$got_key" = "1" ]; then
      case "$key" in
        y|Y) DISC_ALL=1; break ;;
        n|N) SKIP_ALL=1; break ;;
        c|C) OPEN_MENU=1; break ;;
        '') [ "$WAIT_PROMPT_SHOWN" = "1" ] && { DISC_ALL=1; break; } ;;
      esac
    fi
    now=$(date +%s)
    if [ "$now" -ge "$next_attempt" ]; then
      if fetch_health; then
        HEALTH_STATE='ok'
        clear_wait_prompt
        return 0
      fi
      next_delay=$((next_delay * 2))
      [ "$next_delay" -gt 4 ] && next_delay=4
      next_attempt=$((now + next_delay + RANDOM % 2))
    fi
    elapsed=$(( $(date +%s) - start ))
    # the wall clock can step backwards mid-wait (NTP); the counter on
    # screen must never run back (caught live on WSL2)
    [ "$elapsed" -lt "$last_elapsed" ] && elapsed=$last_elapsed
    last_elapsed=$elapsed
    if [ "$elapsed" -ge "$RETRY_TOTAL_SECONDS" ]; then
      break
    fi
    wait_note=''
    if [ "$elapsed" -ge "$HANG_TIGHT_AFTER_SECONDS" ]; then
      wait_note=" — trying to connect... \${elapsed}s, few more seconds, hang tight..."
    elif [ "$elapsed" -ge "$NOTICE_AFTER_SECONDS" ]; then
      wait_note=" — trying to connect... \${elapsed}s"
    fi
    # redraw the full line only when its text changed; otherwise just the
    # spinner glyph moves (see spin_tick)
    if [ "$wait_note" = "$LAST_WAIT_NOTE" ]; then
      spin_tick
    else
      LAST_WAIT_NOTE="$wait_note"
      spin_start "\${GUARD_LABELS[$FIRST_ACTIVE]}$wait_note"
      [ -n "$wait_note" ] && show_wait_prompt
    fi
  done
  clear_wait_prompt
  HEALTH_STATE='down'
  return 1
}

# The whole pre-loader draws on the terminal's alternate screen — the same
# way claude itself does — so nothing lingers in the scrollback after claude
# exits. When the launch needed attention, the outcome is held briefly
# before the alternate screen closes over it.
printf '\\033[?1049h\\033[H\\033[2J'
# Echo off for the whole interactive run: keys pressed while the probes animate
# (before any read) would otherwise smudge the screen. Restored on exit.
stty -echo </dev/tty 2>/dev/null || true
trap 'stty echo </dev/tty 2>/dev/null; printf "\\033[?1049l"' EXIT
GUARD_DWELL=0
OPEN_MENU=0
finish_guard() {
  [ "$GUARD_DWELL" = "1" ] && sleep 1.2
  exit 0
}
${guardHeader(ctx)}
# Every row is on screen from the start: probed rows keep their glyph, the
# probing row is bright, and everything still waiting sits dim below it. The
# [C] reconfigure entry is drawn right here, before the first probe, so it is
# on screen the entire run — not just at the end.
for i in $ACTIVE_IDXS; do
  printf '  %s%s%s\\n' "$C_DIM" "\${GUARD_LABELS[$i]}" "$C_RESET"
done
draw_reconfigure_hint
printf '\\033[%dA' "$ACTIVE_TOTAL"
if [ -n "$HEALTH_URL" ]; then
  spin_start "\${GUARD_LABELS[$FIRST_ACTIVE]}"
  wait_for_health || true
fi
if [ "$OPEN_MENU" = "1" ]; then
  printf '\\033[%dB\\r' "$ACTIVE_TOTAL"
  clear_reconfigure_hint
  reconfigure_menu
  finish_guard
fi
if [ "$DISC_ALL" = "1" ]; then
  line_reset
  GUARD_DWELL=1
  disconnect_and_forget $ACTIVE_IDXS
  uninstall_guard
  finish_guard
fi
if [ "$SKIP_ALL" = "1" ]; then
  line_reset
  printf '%s○%s %sSkipped — remotes stay configured; Claude may fail to reach them this session%s\\n' "$C_WARN" "$C_RESET" "$C_DIM" "$C_RESET"
  printf '\\033[J'
  finish_guard
fi
DOWN_IDXS=''
DOWN_COUNT=0
i=0
while [ "$i" -lt "\${#GUARD_URLS[@]}" ]; do
  if [ "\${GUARD_ACTIVE[$i]}" != "1" ]; then
    i=$((i+1))
    continue
  fi
  spin_start "\${GUARD_LABELS[$i]}"
  pad=0
  while [ "$pad" -lt "$MIN_CHECK_FRAMES" ]; do
    sleep "$FRAME_SLEEP"
    spin_tick
    pad=$((pad + 1))
  done
  if resource_down "$i"; then
    mark_down "$i"
    DOWN_IDXS="$DOWN_IDXS $i"
    DOWN_COUNT=$((DOWN_COUNT + 1))
  else
    mark_ok "\${GUARD_LABELS[$i]}"
  fi
  i=$((i+1))
done
if [ "$DOWN_COUNT" -gt 0 ]; then
  clear_reconfigure_hint
  prompt_down_all
else
  offer_reconfigure_tail
fi
finish_guard
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
# A fresh connect re-arms every check: forget remotes a previous guard
# disconnected.
rm -f "$HOME/${CLAUDE_CODE_GUARD_SKIP_RELPATH}"

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
    return `printf '%s%s%s\\n\\n' "$C_TITLE" "$APP_NAME" "$C_RESET"`;
  }
  const [m0, m1, m2, m3, m4] = ARCHESTRA_GUARD_MARK_LINES;
  return `printf '%s${m0}%s\\n' "$C_LOGO" "$C_RESET"
printf '%s${m1}%s      %s%s%s\\n' "$C_LOGO" "$C_RESET" "$C_TITLE" "$APP_NAME" "$C_RESET"
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
      failName: `LLM proxy (${ctx.proxy.ref ?? ctx.proxy.providerLabel})`,
      downMarker: ctx.proxy.ref ? `"llm":"down"` : null,
    });
  }
  if (ctx.mcp) {
    resources.push({
      label: `MCP gateway (${ctx.mcp.serverName})`,
      url: ctx.mcp.url,
      kind: "mcp",
      failName: `MCP gateway (${ctx.mcp.ref ?? ctx.mcp.serverName})`,
      downMarker: ctx.mcp.ref ? `"mcp":"down"` : null,
    });
  }
  if (ctx.skills) {
    resources.push({
      label: `Skills marketplace (${ctx.skills.marketplaceName})`,
      url: ctx.skills.cloneUrl,
      kind: "skills",
      failName: `Skills marketplace (${ctx.skills.marketplaceName})`,
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
