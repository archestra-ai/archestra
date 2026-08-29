import {
  isDefaultBrandedAppName,
  type StartupGuardClientId,
  type SupportedProvider,
} from "@archestra/shared";
import { CONNECTION_HEALTH_PATH } from "@/routes/route-paths";
import {
  ARCHESTRA_MARK,
  ARCHESTRA_MARK_GAP,
  ARCHESTRA_MARK_NAME_ROW,
  ARCHESTRA_MARK_TAGLINE,
  ARCHESTRA_MARK_TAGLINE_ROW,
} from "./archestra-mark";
import type { SetupScriptContext } from "./connection-setup-script";
import { describeMarketplaceContents } from "./marketplace-copy";

/**
 * Client-agnostic renderer for the CLI startup guard ("pre-loader"): a
 * standalone bash script the connect setup script installs at
 * ~/`<client.scriptRelpath>` plus a `<binary>()` wrapper function in the user's
 * shell profile. Everything here is the shared engine; per-client specifics
 * (the wrapped binary, install paths, and the reverse-of-connect disconnect
 * commands) arrive through a {@link StartupGuardClient} descriptor — see
 * `startup-guard.clients.ts` for the Claude Code / Codex / Copilot CLI
 * descriptors. Before every launch the guard checks the Archestra remotes
 * wired into that client — LLM proxy, MCP gateway, skills marketplace, in that
 * order — and:
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
 * - keeps a skip entry live the whole run: Space — polled between animation
 *   frames and during the retry wait — ends the pre-loader
 *   immediately and lets the client start, disconnecting and remembering
 *   nothing. Reads that must hear it carry an IFS= prefix (default IFS
 *   strips a read space into '', colliding with Enter — and Enter at the
 *   down prompt means disconnect). Bash 3.2 rejects fractional read timeouts,
 *   so a background blocking read captures its frame-level keys instead;
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

interface StartupGuardMcpSection {
  /** Logical server name registered in the client (slug). */
  serverName: string;
  /** Gateway URL, e.g. https://host/v1/mcp/<gateway-slug>. */
  url: string;
  /** Id-or-slug as embedded in the URL; null when it could not be derived. */
  ref: string | null;
}

interface StartupGuardProxySection {
  /** The proxied provider — drives the health URL's `/v1/<provider>/` path. */
  provider: SupportedProvider;
  providerLabel: string;
  /** Proxy URL, e.g. https://host/v1/anthropic/<profile-id>. */
  url: string;
  /** Id-or-slug as embedded in the URL; null when it could not be derived. */
  ref: string | null;
  /**
   * Slug of the LLM proxy (provider id in client configs). Codex's disconnect
   * strips the `[model_providers.<proxyName>]` block it wrote to config.toml.
   */
  proxyName: string;
}

interface StartupGuardSkillsSection {
  marketplaceName: string;
  cloneUrl: string;
  hasSkills?: boolean;
  pluginNames?: string[];
}

/** @public — named by the unit tests that build guard fixtures. */
export interface StartupGuardContext {
  /** White-label product name (pre-sanitized by the setup-script renderer). */
  appName: string;
  /**
   * The single /v1/health URL covering every checkable remote; null when no
   * remote ref could be derived, which degrades the guard to per-resource
   * reachability probes.
   */
  healthUrl: string | null;
  mcp: StartupGuardMcpSection | null;
  proxy: StartupGuardProxySection | null;
  skills: StartupGuardSkillsSection | null;
}

/**
 * Everything the shared guard engine needs that differs per CLI client: the
 * wrapped binary, the conversational product name shown in prompts, the
 * install locations, and the reverse-of-connect disconnect commands. One
 * descriptor per scriptable client lives in `startup-guard.clients.ts`.
 *
 * @public — descriptors are defined in a sibling module and consumed by the
 * setup-script renderers, both of which knip --production can see; the tests
 * (which it ignores) also build against this.
 */
export interface StartupGuardClient {
  clientId: StartupGuardClientId;
  /** The binary the guard wraps and re-execs, e.g. "claude" / "codex". */
  binary: string;
  /** Full display label, e.g. "Claude Code" / "Copilot CLI". */
  label: string;
  /**
   * Conversational product name used in the on-screen prompts ("Disconnect X
   * from <promptName> now?"), e.g. "Claude" / "Codex" / "Copilot".
   */
  promptName: string;
  /** Env var that fully disables the guard, e.g. "ARCHESTRA_CLAUDE_GUARD". */
  disableEnvVar: string;
  /** ~/-relative guard script path (`STARTUP_GUARD_INSTALL[id].scriptRelpath`). */
  scriptRelpath: string;
  /** ~/-relative PowerShell guard script path (Windows engine). */
  psScriptRelpath: string;
  /** ~/-relative skip file (remembers already-disconnected remotes). */
  skipRelpath: string;
  /** Shell-profile wrapper marker block bounds. */
  markerStart: string;
  markerEnd: string;
  /**
   * bash `case "$arg"` patterns (matched per launch arg) that mean a
   * non-interactive / one-shot run, so the guard warns on stderr and gets out
   * of the way instead of drawing the pre-loader (Claude: `-p|--print`).
   */
  nonInteractiveArgPatterns: string[];
  /**
   * Reverse-of-connect commands for the `mcp)` disconnect case — may reference
   * `$MCP_SERVER_NAME` and must run silenced (`command <binary> ...`). Only
   * emitted when the guard covers an MCP gateway.
   */
  mcpDisconnectCommands: string;
  /**
   * Reverse-of-connect commands for the `skills)` disconnect case — may
   * reference `$SKILLS_MARKETPLACE_NAME`. Only emitted when skills are covered.
   */
  skillsDisconnectCommands: string;
  /**
   * Non-interactive shell commands that refresh the configured marketplace
   * after an interactive client session exits. May reference
   * `$arch_refresh_marketplace` and newline-delimited
   * `$arch_refresh_plugin_names`; return non-zero to retry next launch.
   */
  skillsRefreshCommands?: string;
  /**
   * Optional proof that the `mcp)` removal actually took effect, run in the
   * foreground after the silenced commands above.
   *
   * The removals delegate to the vendor CLI, whose exit status cannot answer
   * "is it gone?": `codex mcp remove <missing>` exits 0 while
   * `codex plugin marketplace remove <missing>` exits 1, so a zero exit proves
   * nothing and a non-zero one may just mean "already absent". These snippets
   * therefore check the client's config on disk instead. They must print their
   * own reason and `return 1` when the entry survived; a client that omits
   * them keeps the previous assume-success behaviour.
   */
  mcpDisconnectVerify?: string;
  /** As `mcpDisconnectVerify`, for the `skills)` case. */
  skillsDisconnectVerify?: string;
  /**
   * The `disconnect_proxy()` and `proxy_disconnect_notes()` shell function
   * definitions, fully client-specific (settings.json strip / TOML block strip
   * / shell-profile export strip). Only emitted when a proxy is covered.
   */
  renderProxyDisconnect(ctx: StartupGuardContext): string;
  /**
   * The PowerShell equivalents of the disconnect actions, for the Windows guard
   * engine (`startup-guard.windows.ts`). PowerShell is a separate language, so
   * the bash fields above cannot be reused — but everything else on this
   * descriptor (binary, label, promptName, install paths,
   * nonInteractiveArgPatterns) is platform-agnostic and shared by both engines.
   */
  windows: StartupGuardWindowsClient;
}

/** The Windows/PowerShell half of a client's disconnect actions. */
export interface StartupGuardWindowsClient {
  /**
   * PowerShell statements for the `'mcp'` case of `Invoke-ArchDisconnectActions`.
   * May reference `$archRealExe` (the resolved real binary) and `$McpServerName`.
   */
  mcpDisconnect: string;
  /**
   * PowerShell statements for the `'skills'` case. May reference `$archRealExe`
   * and `$SkillsMarketplaceName`.
   */
  skillsDisconnect: string;
  /**
   * PowerShell refresh body run after an interactive client exits. May use
   * `$archRefreshReal`, `$ArchRefreshMarketplace`, and
   * `$ArchRefreshPluginNames`; return `$false` on failure.
   */
  skillsRefreshCommands?: string;
  /**
   * PowerShell body proving the `'mcp'` removal landed, for
   * `Test-ArchDisconnected`. Must `return $false` (after setting
   * `$Script:ArchDisconnectReason`) when the entry survived. See
   * {@link StartupGuardClient.mcpDisconnectVerify} for why the vendor CLI's
   * exit status cannot be used instead.
   */
  mcpDisconnectVerify?: string;
  /** As `mcpDisconnectVerify`, for the `'skills'` case. */
  skillsDisconnectVerify?: string;
  /**
   * Defines `function Disconnect-ArchProxy { … }` — the client-specific proxy
   * reversal (settings.json strip / config.toml block strip / env removal).
   */
  renderProxyDisconnect(ctx: StartupGuardContext): string;
  /**
   * A single DarkGray note line printed after a proxy remote is disconnected
   * (bedrock token reminder / codex-logout hint / copilot env note). Returns the
   * empty string for no note. The engine emits it as a quoted PowerShell string
   * literal, so it may contain arbitrary text (quotes included).
   */
  proxyDisconnectNote(ctx: StartupGuardContext): string;
}

/**
 * Derive the guard's context from the setup-script context: pass the remotes
 * through, extract each ref from the same URLs connect wires into the client,
 * and build the single health URL. Shared by the bash and PowerShell setup
 * renderers so the two guards can never disagree on what they probe.
 */
export function buildStartupGuardContext(
  ctx: SetupScriptContext,
): StartupGuardContext {
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
          provider: ctx.proxy.provider,
          providerLabel: ctx.proxy.providerLabel,
          url: ctx.proxy.url,
          ref: proxyParsed?.ref ?? null,
          proxyName: ctx.proxy.proxyName,
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
export function renderStartupGuardScript(
  ctx: StartupGuardContext,
  client: StartupGuardClient,
): string {
  const resources = guardResources(ctx);

  return `#!/usr/bin/env bash
# ${ctx.appName} pre-loader for ${client.label} — generated by the ${ctx.appName} /connection page.
# Checks the ${ctx.appName} remotes wired into ${client.label} before it starts —
# one platform health request for all of them — and offers to disconnect
# everything that is down in one keypress (the reverse of connect). It never
# blocks the launch: the shell wrapper runs \`command ${client.binary}\` no matter how
# this script exits. Disable with ${client.disableEnvVar}=0.
set -u

[ "\${${client.disableEnvVar}:-1}" = "0" ] && exit 0
command -v curl >/dev/null 2>&1 || exit 0

APP_NAME=${sh(ctx.appName)}
GUARD_PATH="$HOME/${client.scriptRelpath}"
# Remotes this guard's own disconnect action already removed from ${client.label},
# one kind per line. They are skipped below; connect clears the file.
SKIP_FILE="$HOME/${client.skipRelpath}"
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
    ${client.nonInteractiveArgPatterns.join("|")}) INTERACTIVE=0 ;;
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
    awk -v start=${sh(client.markerStart)} -v end=${sh(client.markerEnd)} '
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
      printf '%s\\n' "archestra: failed to connect to \${GUARD_FAIL_NAMES[$i]} — ${client.binary} is configured to use it and may fail. Disconnect it from the $APP_NAME /connection page, or run ${client.binary} interactively to be offered a disconnect." >&2
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
# Animation frames double as key polls (for Space/[C]). Bash 4+ reads with a
# fractional timeout; 3.2 uses one background blocking read that frame_tick
# polls without slowing the animation (see start_frame_key_reader).
FRAME_KEYS=0
if [ "\${BASH_VERSINFO[0]:-3}" -ge 4 ]; then FRAME_KEYS=1; fi
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

# Frame pacing that can hear the skip key: on bash ≥ 4 each animation frame
# is a fractional read on the tty. System bash 3.2 rejects fractional read
# timeouts, so one background blocking read captures the next key while the
# animation keeps its normal sleep cadence. The IFS= prefix is load-bearing:
# default IFS strips a read space into '', indistinguishable from Enter.
#
# Any OTHER key pressed mid-probe belongs to a prompt that has not appeared
# yet (a typed-ahead y for the down prompt, the 1 after a [C]); consuming it
# here would make that prompt hang. So the first such key ends the polling —
# it is kept in PENDING_KEY for the next prompt to read first, and every key
# after it stays buffered in the tty, exactly as before frames read keys.
SKIP_NOW=0
PENDING_KEY=''
PENDING_KEY_SET=0
FRAME_KEY_PID=''
FRAME_KEY_FILE=''
handle_frame_key() {
  case "$key" in
    ' ') SKIP_NOW=1 ;;
    c|C) OPEN_MENU=1; FRAME_KEYS=0 ;;
    *) PENDING_KEY="$key"; PENDING_KEY_SET=1; FRAME_KEYS=0 ;;
  esac
}
start_frame_key_reader() {
  [ "$FRAME_KEYS" = "0" ] || return 0
  FRAME_KEY_FILE=$(mktemp "\${TMPDIR:-/tmp}/archestra-guard-key.XXXXXX") || return 0
  (
    frame_key=''
    IFS= read -rs -n 1 frame_key </dev/tty 2>/dev/null || exit 0
    printf '%s' "$frame_key" >"$FRAME_KEY_FILE"
  ) &
  FRAME_KEY_PID=$!
}
poll_frame_key_reader() {
  [ -n "$FRAME_KEY_PID" ] || return 1
  kill -0 "$FRAME_KEY_PID" 2>/dev/null && return 1
  wait "$FRAME_KEY_PID" 2>/dev/null || true
  key=$(cat "$FRAME_KEY_FILE" 2>/dev/null || true)
  rm -f "$FRAME_KEY_FILE"
  FRAME_KEY_PID=''; FRAME_KEY_FILE=''
  handle_frame_key
  return 0
}
stop_frame_key_reader() {
  [ -n "$FRAME_KEY_PID" ] || return 0
  poll_frame_key_reader && return 0
  kill "$FRAME_KEY_PID" 2>/dev/null || true
  wait "$FRAME_KEY_PID" 2>/dev/null || true
  rm -f "$FRAME_KEY_FILE"
  FRAME_KEY_PID=''; FRAME_KEY_FILE=''
}
frame_tick() { # one animation frame; harvests Space/[C] pressed mid-probe
  if [ "$FRAME_KEYS" = "1" ]; then
    key=''
    IFS= read -rs -n 1 -t "$FRAME_SLEEP" key </dev/tty 2>/dev/null || return 0
    handle_frame_key
  else
    if ! poll_frame_key_reader; then
      sleep "$FRAME_SLEEP"
      poll_frame_key_reader || true
    fi
  fi
  return 0
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
${client.mcpDisconnectCommands}
      ;;`
      : ""
  }${
    ctx.skills
      ? `
    skills)
${client.skillsDisconnectCommands}
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

# Proof that a removal landed. The vendor CLIs are delegated to with their
# output silenced and their exit status is not a reliable signal, so the check
# reads the client's config instead. Runs in the FOREGROUND (unlike
# disconnect_actions) so a failing check can print why. Default: assume success,
# which is every client that ships no verifier.
disconnect_verify() { # $1 kind
  case "$1" in${
    ctx.mcp && client.mcpDisconnectVerify
      ? `
    mcp)
${client.mcpDisconnectVerify}
      ;;`
      : ""
  }${
    ctx.skills && client.skillsDisconnectVerify
      ? `
    skills)
${client.skillsDisconnectVerify}
      ;;`
      : ""
  }
  esac
  return 0
}

# Reversing a connect step animates the same way the probes do: the commands
# run in the background while the dots grow, then the row lands on a check.
#
# The explicit ( ) around the call is load-bearing, not style. Backgrounding a
# bare function call lets bash 3.2 — still /bin/bash on every macOS — replace
# the subshell with an exec of the arm's FIRST command, silently discarding the
# rest. disconnect_actions issues two removals for Claude Code (user scope then
# local scope), so without the subshell the local-scope entry was never removed
# on macOS. Wrapping in ( ) forces a real fork and runs the whole arm.
disconnect_resource() { # $1 kind, $2 label
  spin_start "Disconnecting $2"
  ( disconnect_actions "$1" ) >/dev/null 2>&1 &
  arch_dp=$!
  pad=0
  while kill -0 "$arch_dp" 2>/dev/null || [ "$pad" -lt "$MIN_CHECK_FRAMES" ]; do
    sleep "$FRAME_SLEEP"
    spin_tick
    pad=$((pad + 1))
  done
  wait "$arch_dp" 2>/dev/null || true
  line_reset
  if ! disconnect_verify "$1"; then
    printf '%s✗ Could not disconnect %s%s\\n' "$C_ERR" "$2" "$C_RESET"
    return 1
  fi
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
SKILLS_MARKETPLACE_NAME=${sh(ctx.skills.marketplaceName)}
PLUGIN_NAMES=${sh((ctx.skills.pluginNames ?? []).join("\n"))}`
      : ""
  }${
    ctx.proxy
      ? `

${client.renderProxyDisconnect(ctx)}`
      : ""
  }

# Set when any resource failed to disconnect, so the caller keeps the guard
# installed instead of deleting the only thing that could retry.
DISCONNECT_FAILED=0

disconnect_and_forget() { # $@ = resource indices: reverse connect, then skip on later launches
  for i in "$@"; do
    # Only a removal we could prove is recorded as done — remembering an
    # unverified one would skip the resource on every later launch and strand
    # the leftover permanently.
    if disconnect_resource "\${GUARD_KINDS[$i]}" "\${GUARD_LABELS[$i]}"; then
      remember_disconnected "\${GUARD_KINDS[$i]}"
    else
      DISCONNECT_FAILED=1
    fi
  done
}

# ---- Reconfigure menu -------------------------------------------------
# Opened with [C] from the prompt under the rows. Every remote is already on
# screen in a stable block, so the menu just re-decorates those rows in place
# ([n] label) and reads number keys — no redraw, no layout jump. Pressing a
# number disconnects that remote (reverse-of-connect, verified, then
# remembered) and lands its row on the purple check — or on ✗ with its number
# still live when the removal cannot be proven; Esc or Enter leaves and lets
# claude start. Removing the last connected remote takes the guard with it,
# but only when every removal was proven. Rows list every active remote
# regardless of reachability.
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
  # Subshell for the same bash 3.2 reason as disconnect_resource above.
  ( disconnect_actions "\${GUARD_KINDS[$2]}" ) >/dev/null 2>&1 &
  arch_dp=$!
  pad=0
  while kill -0 "$arch_dp" 2>/dev/null || [ "$pad" -lt "$MIN_CHECK_FRAMES" ]; do
    sleep "$FRAME_SLEEP"
    spin_tick
    pad=$((pad + 1))
  done
  wait "$arch_dp" 2>/dev/null || true
  line_reset
  # Same contract as disconnect_resource: only a removal we can prove lands
  # the check and the skip-file entry. Verify output is suppressed because
  # this line is repainted in place — the row itself carries the verdict,
  # and an unproven removal keeps its number so it can be retried.
  if ! disconnect_verify "\${GUARD_KINDS[$2]}" >/dev/null 2>&1; then
    DISCONNECT_FAILED=1
    printf '%s✗ Could not disconnect %s — [%s] to retry%s' "$C_ERR" "\${GUARD_LABELS[$2]}" "$1" "$C_RESET"
    menu_leave_row "$1"
    return 1
  fi
  printf '%s✓%s Disconnected %s' "$C_ACCENT" "$C_RESET" "\${GUARD_LABELS[$2]}"
  menu_leave_row "$1"
  remember_disconnected "\${GUARD_KINDS[$2]}"
  return 0
}
reconfigure_menu() {
  GUARD_DWELL=1
  MENU_DONE=' '
  menu_pos=0
  for menu_idx in $ACTIVE_IDXS; do
    menu_pos=$((menu_pos + 1))
    menu_paint_row "$menu_pos" "$menu_idx"
  done
  printf '\\033[s\\n\\r\\033[2K%s  Press 1-%s to disconnect a resource from ${client.promptName} · [Esc] Done%s\\033[u' "$C_DIM" "$ACTIVE_TOTAL" "$C_RESET"
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
        menu_disconnect_row "$key" "$menu_target" || continue
        MENU_DONE="$MENU_DONE$menu_target "
        menu_left=0
        for menu_idx in $ACTIVE_IDXS; do
          case "$MENU_DONE" in *" $menu_idx "*) ;; *) menu_left=$((menu_left + 1)) ;; esac
        done
        if [ "$menu_left" -eq 0 ] && [ "$DISCONNECT_FAILED" = "0" ]; then
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
RECONFIG_HINT_TEXT="  To skip press [Space] · to reconfigure your $APP_NAME connection press [C]"
draw_reconfigure_hint() { printf '\\033[s\\n\\r\\033[2K%s%s%s\\033[u' "$C_DIM" "$RECONFIG_HINT_TEXT" "$C_RESET"; }
clear_reconfigure_hint() { printf '\\033[s\\n\\r\\033[2K\\033[u'; }

# The healthy pass's closing beat: the hint is already on screen, so just wait
# RECONFIG_WAIT for the key before letting claude start. A [C] pressed earlier
# while the probes ran was buffered (echo is off, so it left no smudge) and is
# read here.
offer_reconfigure_tail() {
  if [ "$PENDING_KEY_SET" = "1" ]; then
    # a key typed ahead during the probes counts as the pressed key
    key="$PENDING_KEY"; PENDING_KEY_SET=0
  else
    key=''
    IFS= read -rs -n 1 -t "$RECONFIG_WAIT" key </dev/tty 2>/dev/null || key=''
  fi
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
    down_prompt="Disconnect \${GUARD_FAIL_NAMES[$1]} from ${client.promptName} now? (Y/n)"
  else
    down_prompt="Disconnect all $DOWN_COUNT unreachable resources from ${client.promptName} now? (Y/n)"
  fi
  printf '\\033[s\\n\\r\\033[2K%s\\n\\r\\033[2K%s  or press [C] to reconfigure your %s connection%s\\033[u' "$down_prompt" "$C_DIM" "$APP_NAME" "$C_RESET"
  if [ "$PENDING_KEY_SET" = "1" ]; then
    # a key typed ahead during the probes answers this prompt
    key="$PENDING_KEY"; PENDING_KEY_SET=0
  else
    key=''
    # IFS= keeps a pressed Space as ' ': without it Space reads as '' —
    # Enter — and the advertised skip key would accept the disconnect
    IFS= read -rs -n 1 key </dev/tty 2>/dev/null || key='n'
  fi
  printf '\\033[s\\n\\r\\033[2K\\n\\r\\033[2K\\033[u'
  case "$key" in
    c|C)
      reconfigure_menu
      ;;
    y|Y|'')
      GUARD_DWELL=1
      disconnect_and_forget $DOWN_IDXS
      [ "$DOWN_COUNT" -ge "$ACTIVE_TOTAL" ] && [ "$DISCONNECT_FAILED" = "0" ] && uninstall_guard
      ;;
    *)
      line_reset
      if [ "$DOWN_COUNT" -eq 1 ]; then
        printf '%s○%s %sSkipped — still configured; ${client.promptName} may fail to reach it this session%s\\n' "$C_WARN" "$C_RESET" "$C_DIM" "$C_RESET"
      else
        printf '%s○%s %sSkipped — still configured; ${client.promptName} may fail to reach them this session%s\\n' "$C_WARN" "$C_RESET" "$C_DIM" "$C_RESET"
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
    wait_prompt="Disconnect \${GUARD_FAIL_NAMES[$FIRST_ACTIVE]} from ${client.promptName} now? (Y/n)"
  else
    wait_prompt="Disconnect all $ACTIVE_TOTAL unreachable resources from ${client.promptName} now? (Y/n)"
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
    IFS= read -rs -n 1 -t "$TICK" key </dev/tty 2>/dev/null && got_key=1
    if [ "$got_key" = "1" ]; then
      case "$key" in
        y|Y) DISC_ALL=1; break ;;
        n|N) SKIP_ALL=1; break ;;
        ' ') SKIP_NOW=1; break ;;
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
trap 'stop_frame_key_reader; stty echo </dev/tty 2>/dev/null; printf "\\033[?1049l"' EXIT
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
# Space means "get out of the way": end the pre-loader at once, disconnect and
# remember nothing — the alternate screen closes over the half-drawn rows.
if [ "$SKIP_NOW" = "1" ]; then
  finish_guard
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
  [ "$DISCONNECT_FAILED" = "0" ] && uninstall_guard
  finish_guard
fi
if [ "$SKIP_ALL" = "1" ]; then
  line_reset
  printf '%s○%s %sSkipped — remotes stay configured; ${client.promptName} may fail to reach them this session%s\\n' "$C_WARN" "$C_RESET" "$C_DIM" "$C_RESET"
  printf '\\033[J'
  finish_guard
fi
start_frame_key_reader
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
    frame_tick
    [ "$SKIP_NOW" = "1" ] && break 2
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
stop_frame_key_reader
if [ "$SKIP_NOW" = "1" ]; then
  finish_guard
fi
if [ "$DOWN_COUNT" -gt 0 ]; then
  clear_reconfigure_hint
  prompt_down_all
elif [ "$OPEN_MENU" = "1" ]; then
  # a [C] harvested by frame_tick mid-probe — the same menu the closing
  # beat's buffered read used to catch before frames read the tty
  clear_reconfigure_hint
  reconfigure_menu
else
  offer_reconfigure_tail
fi
finish_guard
`;
}

/**
 * The setup-script section that installs the guard: writes the script file,
 * marks it executable, and hooks the `<binary>()` wrapper into the user's shell
 * profiles inside an idempotent marker block. Relies on the setup script's
 * shared helpers (say/ok) being defined.
 */
export function buildStartupGuardInstallSection(
  ctx: StartupGuardContext,
  client: StartupGuardClient,
): string {
  const guardPath = `$HOME/${client.scriptRelpath}`;
  const refreshFunctionName = `archestra_refresh_${client.binary}_marketplace`;
  const refreshBlock = renderMarketplaceRefreshProfileBlock({
    ctx,
    client,
    functionName: refreshFunctionName,
  });

  return `say ${sh(`Installing the ${ctx.appName} startup guard for ${client.label}`)}
mkdir -p "$(dirname "${guardPath}")"
cat > "${guardPath}" <<'${GUARD_FILE_EOF}'
${renderStartupGuardScript(ctx, client)}${GUARD_FILE_EOF}
chmod +x "${guardPath}"
# A fresh connect re-arms every check: forget remotes a previous guard
# disconnected.
rm -f "$HOME/${client.skipRelpath}"

# Wrap \`${client.binary}\` in each shell profile so the guard runs before every launch.
# The block is stripped and re-added, so re-running connect never duplicates it.
archestra_install_guard_block() {
  touch "$1"
  awk -v start=${sh(client.markerStart)} -v end=${sh(client.markerEnd)} '
    $0 == start {skip=1; next}
    $0 == end {skip=0; next}
    !skip {print}
  ' "$1" > "$1.archestra-tmp" && mv "$1.archestra-tmp" "$1"
  cat >> "$1" <<'${GUARD_PROFILE_EOF}'
${client.markerStart}
# Pre-flight connectivity check for ${ctx.appName}-connected ${client.label}.
# Remove this block and ~/${client.scriptRelpath} to uninstall.
${refreshBlock}
${client.binary}() {
  if [ -x "$HOME/${client.scriptRelpath}" ]; then
    "$HOME/${client.scriptRelpath}" "$@" || true
  fi
  command ${client.binary} "$@"
  archestra_client_status=$?
  ${refreshBlock ? `${refreshFunctionName} "$@" || true` : ":"}
  return "$archestra_client_status"
}
${client.markerEnd}
${GUARD_PROFILE_EOF}
  echo "Updated $1"
}

# Hook the CURRENT shell's rc first — creating it if needed — so the activation
# hint below always resolves to a profile that carries the wrapper, then hook the
# other rc too when it exists (covers users who switch shells). This script runs
# in a child \`curl | bash\`, which cannot define the wrapper in the interactive
# shell you launched it from, so the hint is how you arm it without a new terminal.
case "\${SHELL:-}" in
  *zsh*) archestra_guard_profile="$HOME/.zshrc" ;;
  *)     archestra_guard_profile="$HOME/.bashrc" ;;
esac
archestra_install_guard_block "$archestra_guard_profile"
if [ -f "$HOME/.zshrc" ] && [ "$archestra_guard_profile" != "$HOME/.zshrc" ]; then archestra_install_guard_block "$HOME/.zshrc"; fi
if [ -f "$HOME/.bashrc" ] && [ "$archestra_guard_profile" != "$HOME/.bashrc" ]; then archestra_install_guard_block "$HOME/.bashrc"; fi
ok "Startup guard installed for ${client.binary}."
printf '   It runs automatically in new terminals. To arm it in THIS terminal now,\n'
printf '   reload your shell:  %ssource %s%s   (or just open a new terminal).\n' "$ARCH_C_OK" "$archestra_guard_profile" "$ARCH_C_RESET"`;
}

function renderMarketplaceRefreshProfileBlock(params: {
  ctx: StartupGuardContext;
  client: StartupGuardClient;
  functionName: string;
}): string {
  const { ctx, client, functionName } = params;
  if (!ctx.skills || !client.skillsRefreshCommands) return "";
  const pluginNames = [
    ...(ctx.skills.hasSkills !== false && client.clientId === "claude-code"
      ? [ctx.skills.marketplaceName]
      : []),
    ...(ctx.skills.pluginNames ?? []),
  ];
  const nonInteractivePatterns = client.nonInteractiveArgPatterns.join("|");
  return `${functionName}() {
  for archestra_arg in "$@"; do
    case "$archestra_arg" in ${nonInteractivePatterns}) return 0 ;; esac
  done
  arch_refresh_dir="\${XDG_STATE_HOME:-$HOME/.local/state}/archestra"
  arch_refresh_stamp="$arch_refresh_dir/${client.binary}-${ctx.skills.marketplaceName}.refresh"
  arch_refresh_now=$(date +%s)
  if [ -f "$arch_refresh_stamp" ]; then
    IFS= read -r arch_refresh_last < "$arch_refresh_stamp" || arch_refresh_last=0
    case "$arch_refresh_last" in *[!0-9]*|'') arch_refresh_last=0 ;; esac
    [ "$((arch_refresh_now - arch_refresh_last))" -lt 86400 ] && return 0
  fi
  arch_refresh_marketplace=${sh(ctx.skills.marketplaceName)}
  arch_refresh_plugin_names=${sh(pluginNames.join("\n"))}
${client.skillsRefreshCommands}
  mkdir -p "$arch_refresh_dir"
  printf '%s\n' "$arch_refresh_now" > "$arch_refresh_stamp.tmp"
  mv "$arch_refresh_stamp.tmp" "$arch_refresh_stamp"
}`;
}

/**
 * The setup-script step that unshadows the client binary for THIS shell — emitted
 * BEFORE the connect steps run the client CLI. A previous connect may have
 * installed the guard's `<binary>()` wrapper into a profile that this shell has
 * already sourced; left in place, it would splash/animate every time the connect
 * steps below invoke `<binary>`. Dropping the wrapper function makes those calls
 * reach the real `<binary>`.
 *
 * It is deliberately NON-destructive: it never deletes the installed guard files
 * and never edits a shell profile. That is the whole point — the connect steps
 * between here and the install section run under `set -euo pipefail`, so if any
 * of them fails the script aborts before the install section is reached. Were
 * this step to delete the persisted guard (as an earlier version did), that
 * abort would strand the user with no startup screen at all. Leaving the on-disk
 * guard untouched means a failed connect keeps the existing guard intact, while
 * a successful connect refreshes it: {@link buildStartupGuardInstallSection}
 * overwrites the guard file and rewrites the profile block idempotently, so it
 * both de-duplicates and delivers updates on its own. Silent no-op when nothing
 * is installed yet (first-ever connect).
 */
export function buildStartupGuardUnshadowSection(
  client: StartupGuardClient,
): string {
  return `# A previous connect may have installed the ${client.binary} startup guard, whose
# \`${client.binary}()\` wrapper this shell may already have sourced — it would splash
# over the steps below. Drop it from this shell so those steps reach the real
# \`${client.binary}\`. Deliberately non-destructive: it never deletes the installed
# guard or edits a profile, so a failing step below (this script runs under
# \`set -e\`) can never strand you without a startup screen. The install section at
# the end overwrites the guard with the current version. No-op when nothing is
# installed yet.
unset -f ${client.binary} 2>/dev/null || true`;
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
 * Claude Code draws its own logo — but only for the default brand or one of
 * its own variants (e.g. "Archestra Staging"). White-label deployments get
 * the plain title line.
 */
function guardHeader(ctx: StartupGuardContext): string {
  if (!isDefaultBrandedAppName(ctx.appName)) {
    return `printf '%s%s%s\\n\\n' "$C_TITLE" "$APP_NAME" "$C_RESET"`;
  }
  // The exact canonical mark, colored per line: the braille art in C_LOGO with
  // the product name (C_TITLE) and tagline (C_DIM) overlaid on their rows. The
  // art lines carry no `%`, so they are safe inside the printf format string;
  // the app name is always passed as an argument, never interpolated into it.
  const lines = ARCHESTRA_MARK.unicode;
  return lines
    .map((line, i) => {
      const tail = i === lines.length - 1 ? "\\n\\n" : "\\n";
      if (i === ARCHESTRA_MARK_NAME_ROW) {
        return `printf '%s${line}%s${ARCHESTRA_MARK_GAP}%s%s%s${tail}' "$C_LOGO" "$C_RESET" "$C_TITLE" "$APP_NAME" "$C_RESET"`;
      }
      if (i === ARCHESTRA_MARK_TAGLINE_ROW) {
        return `printf '%s${line}%s${ARCHESTRA_MARK_GAP}%s${ARCHESTRA_MARK_TAGLINE}%s${tail}' "$C_LOGO" "$C_RESET" "$C_DIM" "$C_RESET"`;
      }
      return `printf '%s${line}%s${tail}' "$C_LOGO" "$C_RESET"`;
    })
    .join("\n");
}

/**
 * The remotes shown in the pre-loader, in check order: LLM proxy, MCP
 * gateway, skills marketplace. The gateway and proxy carry per-resource down
 * markers from the health response; the skills marketplace has no
 * per-resource status — it rides on endpoint reachability (same origin), and
 * a revoked share link never blocks a claude launch.
 */
function guardResources(ctx: StartupGuardContext): Array<{
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
    const label = `${describeMarketplaceContents(ctx.skills).label} (${ctx.skills.marketplaceName})`;
    resources.push({
      label,
      url: ctx.skills.cloneUrl,
      kind: "skills",
      failName: label,
      downMarker: null,
    });
  }
  return resources;
}
