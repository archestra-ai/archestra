import {
  CLAUDE_CODE_CLIENT_ID,
  DEFAULT_APP_NAME,
  EXTERNAL_AGENT_ID_HEADER,
  type SupportedProvider,
  VIRTUAL_KEY_HEADER,
} from "@archestra/shared";
import type {
  ConnectionSetupClientId,
  ConnectionSetupPlatform,
  ConnectionSetupProxyAuth,
} from "@/types";
import { renderWindowsSetupScript } from "./connection-setup-script.windows";

/**
 * Pure renderers for the /connection one-command setup scripts. Everything in
 * this module is deterministic string building — no DB, no I/O — so the route
 * can render inside its claim transaction and tests can assert exact output.
 *
 * Script contract (see plan):
 * - idempotent re-runs (remove-then-add for CLI registrations, key-scoped
 *   JSON/TOML merges with backups for config files);
 * - secrets are passed via shell variables / env / stdin, never as argv of
 *   external commands;
 * - `curl | bash` cannot export env into the parent shell, so env-based
 *   config (Copilot, Codex login) is either performed inside the script or
 *   emitted as ready-to-paste export lines;
 * - every script ends with next steps + revocation guidance.
 */

export interface SetupScriptMcpSection {
  /** Logical server name registered in the client (slug). */
  serverName: string;
  /** Gateway URL, e.g. https://host/v1/mcp/<gateway-slug>. */
  url: string;
}

export interface SetupScriptProxySection {
  /**
   * "provider-key" (passthrough): only the base URL is rewired and the user
   * keeps their own provider credentials — virtualKey/virtualKeyName are
   * null. "virtual-key": the auto-provisioned key below is injected.
   */
  authMode: ConnectionSetupProxyAuth;
  provider: SupportedProvider;
  providerLabel: string;
  /** Proxy URL, e.g. https://host/v1/anthropic/<profile-id>. */
  url: string;
  /** Slug of the LLM proxy name — provider id in client configs. */
  proxyName: string;
  /** Raw virtual key value injected at render time (virtual-key mode only). */
  virtualKey: string | null;
  /** Display name of the virtual key, for revocation guidance. */
  virtualKeyName: string | null;
  /**
   * Raw passthrough virtual key value injected at render time, sent as the
   * X-Archestra-Virtual-Key header so the proxy attributes the request to the
   * user. Set only in passthrough (provider-key) mode for the Anthropic
   * provider (Claude Code subscription passthrough); null otherwise. Orthogonal
   * to `virtualKey` — it carries no provider credential.
   */
  passthroughVirtualKey: string | null;
  /**
   * GitHub OAuth endpoints for the in-script device flow. Required when
   * provider is "github-copilot" in passthrough mode: Copilot has no static
   * API keys, so the script obtains the user's GitHub OAuth token locally
   * (reusing the Copilot CLI's stored token when one works, otherwise running
   * the device flow) and the token never leaves the machine.
   */
  githubCopilot?: {
    /** Exchange endpoint used to verify a token has an active Copilot seat. */
    tokenExchangeUrl: string;
    /** Host serving /login/device/code and /login/oauth/access_token. */
    deviceAuthBaseUrl: string;
    /** GitHub App client id for the device flow. */
    clientId: string;
  } | null;
}

export interface SetupScriptSkillsSection {
  cloneUrl: string;
  marketplaceName: string;
}

export interface SetupScriptContext {
  clientId: ConnectionSetupClientId;
  /** Target OS: "macos"/"linux" render bash, "windows" renders PowerShell. */
  platform: ConnectionSetupPlatform;
  /** White-label product name for user-facing messaging. */
  appName: string;
  mcp: SetupScriptMcpSection | null;
  proxy: SetupScriptProxySection | null;
  skills: SetupScriptSkillsSection | null;
}

/**
 * The one-liner shown in the UI. `origin` is the API origin (no /v1). Windows
 * gets a PowerShell `irm | iex` invocation; macOS/Linux get `curl | bash`.
 */
export function buildSetupCommand(params: {
  origin: string;
  rawToken: string;
  platform: ConnectionSetupPlatform;
}): string {
  const url = `${params.origin}/api/connection-setups/script/${params.rawToken}`;
  if (params.platform === "windows") {
    // single quotes: nothing in the URL may expand in PowerShell.
    return `irm ${psq(url)} | iex`;
  }
  // single quotes: nothing in the URL may expand in the user's shell.
  return `curl -fsSL ${sh(url)} | bash`;
}

/** Strips the /v1 suffix the connection base URLs carry. */
export function proxyBaseUrlToOrigin(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function renderSetupScript(rawCtx: SetupScriptContext): string {
  // appName is white-label, admin-controlled text that lands in script comments
  // and bare echo strings. Collapse control characters (newlines, NUL, …) to
  // spaces so it can never break out of a comment line and execute.
  const ctx: SetupScriptContext = {
    ...rawCtx,
    appName: sanitizeAppName(rawCtx.appName),
  };

  // Windows targets a separate PowerShell renderer; macOS/Linux share bash.
  if (ctx.platform === "windows") {
    return renderWindowsSetupScript(ctx);
  }

  const sections: string[] = [header(ctx)];

  switch (ctx.clientId) {
    case "claude-code":
      sections.push(...claudeCodeSections(ctx));
      break;
    case "codex":
      sections.push(...codexSections(ctx));
      break;
    case "copilot-cli":
      sections.push(...copilotSections(ctx));
      break;
    case "cursor":
      sections.push(...cursorSections(ctx));
      break;
  }

  sections.push(footer(ctx));
  return `${sections.join("\n\n")}\n`;
}

// ===================================================================
// Internal helpers — shared scaffolding
// ===================================================================

const CLIENT_LABELS: Record<ConnectionSetupClientId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "copilot-cli": "Copilot CLI",
  cursor: "Cursor",
};

const CLIENT_BINARIES: Partial<Record<ConnectionSetupClientId, string>> = {
  "claude-code": "claude",
  codex: "codex",
  "copilot-cli": "copilot",
};

/** Single-quote a value for bash; safe for arbitrary content. */
function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Single-quote a value for PowerShell; safe for arbitrary content. */
function psq(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Collapse control characters so appName is safe in comments and bare echoes. */
function sanitizeAppName(appName: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  return appName.replace(/[\x00-\x1f\x7f]+/g, " ").trim() || "Archestra";
}

/**
 * Color setup + logging helpers shared by every script. Colors are emitted
 * only when stdout is a TTY and NO_COLOR is unset, so piping the output to a
 * file or a non-interactive shell keeps it clean ANSI-free text. `say` marks
 * section headers, `ok` a success, `warn`/`err` advisory and failure lines
 * (err goes to stderr so `curl -f | bash` surfaces it).
 */
const SCRIPT_HELPERS = `if [ -t 1 ] && [ -z "\${NO_COLOR:-}" ]; then
  ARCH_C_RESET=$'\\033[0m'; ARCH_C_HEAD=$'\\033[1;36m'; ARCH_C_OK=$'\\033[1;32m'
  ARCH_C_WARN=$'\\033[1;33m'; ARCH_C_ERR=$'\\033[1;31m'
else
  ARCH_C_RESET=''; ARCH_C_HEAD=''; ARCH_C_OK=''; ARCH_C_WARN=''; ARCH_C_ERR=''
fi
say()  { printf '\\n%s==> %s%s\\n' "$ARCH_C_HEAD" "$1" "$ARCH_C_RESET"; }
ok()   { printf '%s==>%s %s\\n' "$ARCH_C_OK" "$ARCH_C_RESET" "$1"; }
warn() { printf '%swarning:%s %s\\n' "$ARCH_C_WARN" "$ARCH_C_RESET" "$1"; }
err()  { printf '%serror:%s %s\\n' "$ARCH_C_ERR" "$ARCH_C_RESET" "$1" >&2; }`;

function header(ctx: SetupScriptContext): string {
  const label = CLIENT_LABELS[ctx.clientId];
  const binary = CLIENT_BINARIES[ctx.clientId];
  const requireBinary = binary
    ? `
if ! command -v ${binary} >/dev/null 2>&1; then
  err "the '${binary}' CLI was not found on PATH. Install ${label} first, then re-run this command."
  exit 1
fi`
    : "";

  return `#!/usr/bin/env bash
# ${ctx.appName} setup for ${label}.
# Generated by the ${ctx.appName} /connection page. This script contains
# credentials — do not share or commit it.
set -euo pipefail

${SCRIPT_HELPERS}

${banner(ctx)}

say ${sh(`${ctx.appName} setup: ${label}`)}${requireBinary}`;
}

/**
 * Splash printed at the very top of every script: the Archestra ASCII mark
 * (only when not white-labeled — printing the Archestra icon under a custom
 * brand would be wrong) plus a portable, plain-ASCII details block. Printed
 * through a quoted heredoc so nothing in it is ever expanded by bash.
 */
function banner(ctx: SetupScriptContext): string {
  const label = CLIENT_LABELS[ctx.clientId];

  const configures: string[] = [];
  if (ctx.mcp) configures.push("MCP gateway (OAuth)");
  if (ctx.proxy) {
    configures.push(
      `${ctx.proxy.providerLabel} via the LLM proxy${
        ctx.proxy.virtualKey ? " (virtual key)" : ""
      }`,
    );
  }
  if (ctx.skills) configures.push("Skills marketplace");

  // A monospace rendition of the Archestra mark: a white tilted rounded bar
  // and dot on the terminal's dark field, echoing the real logo-icon.svg.
  // Block/quadrant glyphs (UTF-8) render as solid shapes in any modern terminal.
  const logo =
    ctx.appName === DEFAULT_APP_NAME
      ? `   ╭──────────────────╮
   │                  │
   │        ▟██▙      │
   │        ████      │     ${ctx.appName}
   │       ████       │     Secure access to your AI tools
   │       ████ ▟▙    │
   │      ▜██▛  ▜▛    │
   │                  │
   ╰──────────────────╯`
      : `   ${ctx.appName}
   Secure access to your AI tools`;

  const details = [
    `   Client:     ${label}`,
    configures.length > 0 ? `   Configures: ${configures.join(", ")}` : null,
    `   Note:       one-time setup — this link expires after first use.`,
  ]
    .filter(Boolean)
    .join("\n");

  return `cat <<'ARCHESTRA_BANNER'

${logo}

${details}
ARCHESTRA_BANNER`;
}

function footer(ctx: SetupScriptContext): string {
  const lines = [`ok "Done."`];

  const nextSteps = nextStepsFor(ctx);
  if (nextSteps.length > 0) {
    lines.push(`cat <<'ARCHESTRA_NEXT'

Next steps:
${nextSteps.map((step, i) => `  ${i + 1}. ${step}`).join("\n")}
ARCHESTRA_NEXT`);
  }

  const revocation: string[] = [];
  if (ctx.proxy?.virtualKeyName) {
    revocation.push(
      `delete the "${ctx.proxy.virtualKeyName}" key on the Virtual API Keys page`,
    );
  }
  if (ctx.skills) {
    revocation.push(
      `revoke the "${ctx.skills.marketplaceName}" share link on the Skills page`,
    );
  }
  if (revocation.length > 0) {
    lines.push(`cat <<'ARCHESTRA_REVOKE'

To revoke this machine's access later in ${ctx.appName}: ${revocation.join("; ")}.
ARCHESTRA_REVOKE`);
  }

  return lines.join("\n");
}

function nextStepsFor(ctx: SetupScriptContext): string[] {
  const steps: string[] = [];
  switch (ctx.clientId) {
    case "claude-code":
      if (ctx.mcp) {
        steps.push(
          `Run \`claude\` and use /mcp to finish the OAuth flow for "${ctx.mcp.serverName}".`,
        );
      }
      if (ctx.proxy?.provider === "bedrock" && ctx.proxy.virtualKey) {
        steps.push(
          "Paste the AWS_BEARER_TOKEN_BEDROCK export printed above into your shell profile.",
        );
      }
      if (ctx.skills) {
        steps.push(
          "The shared skills are installed for Claude Code — start `claude` and they load automatically.",
        );
      }
      break;
    case "codex":
      if (ctx.mcp) {
        steps.push(
          `Run \`codex\` — it opens your browser to finish the OAuth handshake for "${ctx.mcp.serverName}".`,
        );
      }
      if (ctx.proxy) {
        if (!ctx.proxy.virtualKey) {
          steps.push(
            "Make sure Codex is signed in with your own OpenAI API key (printenv OPENAI_API_KEY | codex login --with-api-key).",
          );
        }
        steps.push(
          `Start Codex through the proxy: codex -c model_provider=${ctx.proxy.proxyName}`,
        );
      }
      if (ctx.skills) {
        steps.push(
          'Run /plugins inside Codex and pick "Install Plugin" to install the bundled skills.',
        );
      }
      break;
    case "copilot-cli":
      if (ctx.mcp) {
        steps.push(
          "Copilot opens your browser to complete OAuth when the gateway asks for it.",
        );
      }
      if (ctx.proxy) {
        steps.push(
          'Paste the export lines printed above into your shell profile, set COPILOT_MODEL, then verify with: copilot -p "Reply with exactly: archestra-copilot-cli-ok"',
        );
      }
      if (ctx.skills) {
        steps.push(
          `Browse and install the shared skills: copilot plugin marketplace browse ${ctx.skills.marketplaceName}`,
        );
      }
      break;
    case "cursor":
      if (ctx.mcp) {
        steps.push(
          `Open Cursor settings → MCP and toggle on "${ctx.mcp.serverName}"; Cursor handles the OAuth flow.`,
        );
      }
      if (ctx.proxy) {
        steps.push(
          "Apply the Cursor model settings printed above (Settings → Models → OpenAI API Key).",
        );
      }
      if (ctx.skills) {
        steps.push(
          "Run /add-plugin in Cursor's command palette and paste the clone URL printed above.",
        );
      }
      break;
  }
  return steps;
}

/**
 * Key-scoped JSON merge via python3 (no jq dependency). Values arrive through
 * the child process env, never argv. Backs the file up before writing.
 */
function mergeJsonFileSnippet(params: {
  file: string;
  env: Record<string, string>;
  python: string;
  fallbackMessage: string;
  fallbackSnippet: string;
}): string {
  const envAssignments = Object.entries(params.env)
    .map(([key, value]) => `export ${key}=${sh(value)}`)
    .join("\n");

  return `if command -v python3 >/dev/null 2>&1; then
  mkdir -p "$(dirname ${sh(params.file)})"
  # Back up once: a re-run must not overwrite the pristine pre-Archestra copy
  # with our already-modified file. The merge below is itself idempotent.
  if [ -f ${sh(params.file)} ] && [ ! -f ${sh(`${params.file}.archestra-backup`)} ]; then
    cp ${sh(params.file)} ${sh(`${params.file}.archestra-backup`)}
  fi
${indent(envAssignments, "  ")}
  python3 - <<'ARCHESTRA_PY'
${params.python}
ARCHESTRA_PY
else
  warn ${sh(params.fallbackMessage)}
  cat <<'ARCHESTRA_MANUAL'
${params.fallbackSnippet}
ARCHESTRA_MANUAL
fi`;
}

function indent(block: string, prefix: string): string {
  return block
    .split("\n")
    .map((line) => (line.length > 0 ? `${prefix}${line}` : line))
    .join("\n");
}

// ===================================================================
// Internal helpers — Claude Code
// ===================================================================

function claudeCodeSections(ctx: SetupScriptContext): string[] {
  const sections: string[] = [];

  if (ctx.mcp) {
    sections.push(`say ${sh(`Registering MCP gateway "${ctx.mcp.serverName}" (OAuth)`)}
claude mcp remove ${sh(ctx.mcp.serverName)} >/dev/null 2>&1 || true
claude mcp add --transport http ${sh(ctx.mcp.serverName)} ${sh(ctx.mcp.url)}`);
  }

  if (ctx.proxy) {
    sections.push(
      ctx.proxy.provider === "bedrock"
        ? claudeBedrockProxySection(ctx.proxy)
        : claudeAnthropicProxySection(ctx.proxy),
    );
  }

  if (ctx.skills) {
    const pluginRef = `${ctx.skills.marketplaceName}@${ctx.skills.marketplaceName}`;
    sections.push(`say ${sh(`Installing the "${ctx.skills.marketplaceName}" skills bundle`)}
if ! claude plugin marketplace add ${sh(ctx.skills.cloneUrl)}; then
  warn "Marketplace may already be registered — continuing."
fi
if ! claude plugin install ${sh(pluginRef)}; then
  warn ${sh(`Could not install the skills automatically — run 'claude plugin install ${pluginRef}' or open /plugin inside Claude Code.`)}
fi`);
  }

  return sections;
}

const CLAUDE_SETTINGS_MERGE_PY = `import json, os, pathlib
path = pathlib.Path(os.path.expanduser("~/.claude/settings.json"))
settings = {}
if path.exists():
    raw = path.read_text().strip()
    if raw:
        settings = json.loads(raw)
env = settings.setdefault("env", {})
for key in os.environ:
    if key.startswith("ARCHESTRA_SET_ENV_"):
        env[key.removeprefix("ARCHESTRA_SET_ENV_")] = os.environ[key]
# Append-merge our custom headers into ANTHROPIC_CUSTOM_HEADERS: keep the user's
# other headers, replace only our lines (matched case-insensitively by header
# name) so re-runs and key rotation never duplicate or leave a stale one. The
# append var carries one "Name: Value" per line (e.g. the agent-id attribution
# header and the passthrough key header).
append_headers = os.environ.get("ARCHESTRA_APPEND_ANTHROPIC_CUSTOM_HEADERS")
if append_headers:
    new_lines = [ln for ln in append_headers.splitlines() if ln.strip()]
    new_names = {ln.split(":", 1)[0].strip().lower() for ln in new_lines}
    existing = env.get("ANTHROPIC_CUSTOM_HEADERS", "") or ""
    lines = [
        ln for ln in existing.splitlines()
        if ln.strip() and ln.split(":", 1)[0].strip().lower() not in new_names
    ]
    lines.extend(new_lines)
    env["ANTHROPIC_CUSTOM_HEADERS"] = "\\n".join(lines)
path.write_text(json.dumps(settings, indent=2) + "\\n")
print(f"Updated {path}")`;

/**
 * Custom headers Claude Code sends on every proxied request (Anthropic and
 * Bedrock alike — ANTHROPIC_CUSTOM_HEADERS applies to both), one "Name: Value"
 * per line:
 *  - X-Archestra-Agent-Id attributes the request to the Claude Code client.
 *  - X-Archestra-Virtual-Key (passthrough) attributes it to the user.
 */
function claudeCustomHeaders(proxy: SetupScriptProxySection): string {
  const headerLines = [`${EXTERNAL_AGENT_ID_HEADER}: ${CLAUDE_CODE_CLIENT_ID}`];
  if (proxy.passthroughVirtualKey) {
    headerLines.push(`${VIRTUAL_KEY_HEADER}: ${proxy.passthroughVirtualKey}`);
  }
  return headerLines.join("\n");
}

function claudeAnthropicProxySection(proxy: SetupScriptProxySection): string {
  const env: Record<string, string> = {
    ARCHESTRA_SET_ENV_ANTHROPIC_BASE_URL: proxy.url,
  };
  const manualEnv: Record<string, string> = { ANTHROPIC_BASE_URL: proxy.url };
  if (proxy.virtualKey) {
    env.ARCHESTRA_SET_ENV_ANTHROPIC_AUTH_TOKEN = proxy.virtualKey;
    manualEnv.ANTHROPIC_AUTH_TOKEN = proxy.virtualKey;
  }
  // The merge appends/replaces only our header lines, never clobbering headers
  // the user already set.
  const customHeaders = claudeCustomHeaders(proxy);
  env.ARCHESTRA_APPEND_ANTHROPIC_CUSTOM_HEADERS = customHeaders;
  manualEnv.ANTHROPIC_CUSTOM_HEADERS = customHeaders;
  const passthroughNote = proxy.virtualKey
    ? ""
    : `
echo "Your existing ${proxy.providerLabel} credentials keep working — only the base URL changed."`;

  return `say ${sh(`Routing Claude Code through the ${proxy.providerLabel} proxy`)}
${mergeJsonFileSnippet({
  file: "$HOME/.claude/settings.json",
  env,
  python: CLAUDE_SETTINGS_MERGE_PY,
  fallbackMessage:
    "python3 not found — merge this into ~/.claude/settings.json manually:",
  fallbackSnippet: JSON.stringify({ env: manualEnv }, null, 2),
})}${passthroughNote}`;
}

function claudeBedrockProxySection(proxy: SetupScriptProxySection): string {
  const customHeaders = claudeCustomHeaders(proxy);
  return `say ${sh("Routing Claude Code through the Bedrock proxy")}
${mergeJsonFileSnippet({
  file: "$HOME/.claude/settings.json",
  env: {
    ARCHESTRA_SET_ENV_CLAUDE_CODE_USE_BEDROCK: "1",
    ARCHESTRA_SET_ENV_AWS_REGION: "us-east-1",
    ARCHESTRA_SET_ENV_ANTHROPIC_BEDROCK_BASE_URL: proxy.url,
    ARCHESTRA_APPEND_ANTHROPIC_CUSTOM_HEADERS: customHeaders,
  },
  python: CLAUDE_SETTINGS_MERGE_PY,
  fallbackMessage:
    "python3 not found — merge this into ~/.claude/settings.json manually:",
  fallbackSnippet: JSON.stringify(
    {
      env: {
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_REGION: "us-east-1",
        ANTHROPIC_BEDROCK_BASE_URL: proxy.url,
        ANTHROPIC_CUSTOM_HEADERS: customHeaders,
      },
    },
    null,
    2,
  ),
})}
echo "Update AWS_REGION in ~/.claude/settings.json if you use a different region."
${
  proxy.virtualKey
    ? `cat <<'ARCHESTRA_BEDROCK'

Add this to your shell profile (kept out of files claude reads):
  export AWS_BEARER_TOKEN_BEDROCK=${sh(proxy.virtualKey)}
ARCHESTRA_BEDROCK`
    : `echo "Your existing AWS credentials keep working — only the base URL changed."`
}`;
}

// ===================================================================
// Internal helpers — Codex
// ===================================================================

function codexSections(ctx: SetupScriptContext): string[] {
  const sections: string[] = [];

  if (ctx.mcp) {
    sections.push(`say ${sh(`Registering MCP gateway "${ctx.mcp.serverName}" (OAuth)`)}
codex mcp remove ${sh(ctx.mcp.serverName)} >/dev/null 2>&1 || true
codex mcp add ${sh(ctx.mcp.serverName)} --url ${sh(ctx.mcp.url)}`);
  }

  if (ctx.proxy) {
    const marker = `archestra:${ctx.proxy.proxyName}`;
    const block = `# >>> ${marker} >>>
[model_providers.${ctx.proxy.proxyName}]
name = "${ctx.proxy.proxyName}"
base_url = "${ctx.proxy.url}"
wire_api = "responses"
requires_openai_auth = true
# <<< ${marker} <<<`;

    sections.push(`say ${sh(`Adding the "${ctx.proxy.proxyName}" provider to ~/.codex/config.toml`)}
mkdir -p "$HOME/.codex"
CONFIG="$HOME/.codex/config.toml"
if [ -f "$CONFIG" ]; then
  # Back up once so re-runs preserve the pristine pre-Archestra config.
  [ -f "$CONFIG.archestra-backup" ] || cp "$CONFIG" "$CONFIG.archestra-backup"
  # drop any previous archestra-managed block for this provider (idempotent)
  awk -v start=${sh(`# >>> ${marker} >>>`)} -v end=${sh(`# <<< ${marker} <<<`)} '
    $0 == start {skip=1; next}
    $0 == end {skip=0; next}
    !skip {print}
  ' "$CONFIG" > "$CONFIG.archestra-tmp" && mv "$CONFIG.archestra-tmp" "$CONFIG"
fi
cat >> "$CONFIG" <<'ARCHESTRA_TOML'
${block}
ARCHESTRA_TOML
echo "Updated $CONFIG"${
      ctx.proxy.virtualKey
        ? `

say ${sh("Signing Codex in with your virtual key")}
ARCHESTRA_VIRTUAL_KEY=${sh(ctx.proxy.virtualKey)}
printf '%s' "$ARCHESTRA_VIRTUAL_KEY" | codex login --with-api-key`
        : `
echo "Codex keeps using your own OpenAI API key login."`
    }`);
  }

  if (ctx.skills) {
    sections.push(`say ${sh(`Registering the "${ctx.skills.marketplaceName}" skills marketplace`)}
if ! codex plugin marketplace add ${sh(ctx.skills.cloneUrl)}; then
  warn "Marketplace may already be registered — run /plugins inside Codex to inspect."
fi`);
  }

  return sections;
}

// ===================================================================
// Internal helpers — Copilot CLI
// ===================================================================

function copilotSections(ctx: SetupScriptContext): string[] {
  const sections: string[] = [];

  if (ctx.mcp) {
    sections.push(`say ${sh(`Registering MCP gateway "${ctx.mcp.serverName}" (OAuth)`)}
copilot mcp remove ${sh(ctx.mcp.serverName)} >/dev/null 2>&1 || true
copilot mcp add --transport http ${sh(ctx.mcp.serverName)} ${sh(ctx.mcp.url)}
copilot mcp get ${sh(ctx.mcp.serverName)}`);
  }

  if (ctx.proxy) {
    if (ctx.proxy.provider === "github-copilot" && !ctx.proxy.virtualKey) {
      sections.push(copilotGithubLinkSection(ctx.proxy));
    } else {
      // A piped script cannot export into the caller's shell; print the lines.
      sections.push(`say ${sh(`Copilot provider settings (${ctx.proxy.providerLabel} via OpenAI-compatible protocol)`)}
cat <<'ARCHESTRA_COPILOT'

Add these lines to your shell profile (e.g. ~/.zshrc), set COPILOT_MODEL to the model you use:
  export COPILOT_PROVIDER_TYPE="openai"
  export COPILOT_PROVIDER_BASE_URL=${sh(ctx.proxy.url)}
  export COPILOT_PROVIDER_API_KEY=${
    ctx.proxy.virtualKey
      ? sh(ctx.proxy.virtualKey)
      : `"<your-${ctx.proxy.provider}-api-key>"`
  }
  export COPILOT_MODEL="<model-name>"
ARCHESTRA_COPILOT`);
    }
  }

  if (ctx.skills) {
    sections.push(`say ${sh(`Registering the "${ctx.skills.marketplaceName}" skills marketplace`)}
if ! copilot plugin marketplace add ${sh(ctx.skills.cloneUrl)}; then
  warn "Marketplace may already be registered — run 'copilot plugin marketplace browse' to inspect."
fi`);
  }

  return sections;
}

/**
 * GitHub Copilot in passthrough mode: there is no static API key — the proxy
 * expects the user's long-lived GitHub OAuth token as the bearer. The script
 * obtains one locally and prints it in the export lines, so the token never
 * leaves the machine:
 *  1. reuse a token the Copilot CLI / VS Code already stored in
 *     ~/.config/github-copilot/{apps,hosts}.json — but only if Copilot's token
 *     exchange accepts it (valid + active Copilot seat);
 *  2. otherwise run the GitHub device flow (RFC 8628): show a code, poll
 *     until the user authorizes in the browser, honoring interval/slow_down
 *     with a hard deadline from expires_in.
 * The token is never passed as argv to external commands (curl reads it via
 * stdin config / request bodies via stdin).
 */
function copilotGithubLinkSection(proxy: SetupScriptProxySection): string {
  const gh = proxy.githubCopilot;
  if (!gh) {
    throw new Error(
      "github-copilot passthrough proxy section requires githubCopilot device-flow configuration",
    );
  }

  const deviceCodeUrl = `${gh.deviceAuthBaseUrl.replace(/\/+$/, "")}/login/device/code`;
  const accessTokenUrl = `${gh.deviceAuthBaseUrl.replace(/\/+$/, "")}/login/oauth/access_token`;
  const deviceRequestBody = JSON.stringify({
    client_id: gh.clientId,
    scope: "read:user",
  });

  return `say 'Linking your GitHub Copilot subscription'
ARCHESTRA_GHCP_TOKEN=""

# Probe the Copilot token exchange: succeeds only for a valid GitHub token on
# an account with an active Copilot seat. Token goes via stdin, never argv.
ghcp_validate() {
  [ -n "$1" ] || return 1
  printf 'header = "authorization: token %s"\\n' "$1" | curl -fsS -o /dev/null \\
    --connect-timeout 10 --max-time 30 -K - \\
    -H 'accept: application/json' \\
    -H 'editor-version: vscode/1.99.0' \\
    -H 'copilot-integration-id: vscode-chat' \\
    ${sh(gh.tokenExchangeUrl)} 2>/dev/null
}

if ! command -v python3 >/dev/null 2>&1; then
  cat <<'ARCHESTRA_GHCP_MANUAL'
python3 not found — skipping the automatic GitHub sign-in.
Sign in manually instead: run the Copilot CLI once and complete its login,
then use the "oauth_token" value from ~/.config/github-copilot/apps.json
as COPILOT_PROVIDER_API_KEY below.
ARCHESTRA_GHCP_MANUAL
else
  # 1. Reuse a GitHub token already stored by the Copilot CLI / VS Code.
  ghcp_candidates="$(python3 - "$HOME/.config/github-copilot/apps.json" "$HOME/.config/github-copilot/hosts.json" <<'ARCHESTRA_GHCP_PY'
import json, sys
seen = []
for path in sys.argv[1:]:
    try:
        with open(path) as f:
            data = json.load(f)
    except Exception:
        continue
    if not isinstance(data, dict):
        continue
    for value in data.values():
        if isinstance(value, dict):
            token = value.get("oauth_token")
            if isinstance(token, str) and token and token not in seen:
                seen.append(token)
print("\\n".join(seen))
ARCHESTRA_GHCP_PY
)" || ghcp_candidates=""
  for ghcp_candidate in $ghcp_candidates; do
    if ghcp_validate "$ghcp_candidate"; then
      ARCHESTRA_GHCP_TOKEN="$ghcp_candidate"
      echo "Re-using the GitHub token stored by the Copilot CLI on this machine."
      break
    fi
  done

  # 2. No usable stored token: run the GitHub device flow.
  if [ -z "$ARCHESTRA_GHCP_TOKEN" ]; then
    ghcp_device="$(printf '%s' ${sh(deviceRequestBody)} | curl -fsS --connect-timeout 10 --max-time 30 \\
      -X POST -H 'accept: application/json' -H 'content-type: application/json' \\
      --data @- ${sh(deviceCodeUrl)})" || {
      err "could not reach GitHub to start the device flow."
      exit 1
    }
    ghcp_field() { printf '%s' "$ghcp_device" | python3 -c "import json,sys; print(json.load(sys.stdin).get('$1',''))"; }
    ghcp_device_code="$(ghcp_field device_code)"
    ghcp_user_code="$(ghcp_field user_code)"
    ghcp_verification_uri="$(ghcp_field verification_uri)"
    ghcp_interval="$(ghcp_field interval)"
    ghcp_expires_in="$(ghcp_field expires_in)"
    [ -n "$ghcp_interval" ] || ghcp_interval=5
    [ -n "$ghcp_expires_in" ] || ghcp_expires_in=900
    if [ -z "$ghcp_device_code" ]; then
      err "GitHub did not return a device code."
      exit 1
    fi
    ghcp_deadline=$(( $(date +%s) + ghcp_expires_in ))
    echo
    printf '  Open:        %s\\n' "$ghcp_verification_uri"
    printf '  Enter code:  %s\\n' "$ghcp_user_code"
    echo
    echo 'Waiting for you to authorize in the browser...'
    while [ -z "$ARCHESTRA_GHCP_TOKEN" ]; do
      if [ "$(date +%s)" -ge "$ghcp_deadline" ]; then
        err "timed out waiting for GitHub authorization — re-run this command to try again."
        exit 1
      fi
      sleep "$ghcp_interval"
      ghcp_poll="$(printf '{"client_id":"%s","device_code":"%s","grant_type":"urn:ietf:params:oauth:grant-type:device_code"}' ${sh(gh.clientId)} "$ghcp_device_code" | \\
        curl -sS --connect-timeout 10 --max-time 30 \\
          -X POST -H 'accept: application/json' -H 'content-type: application/json' \\
          --data @- ${sh(accessTokenUrl)})" || continue
      ghcp_token="$(printf '%s' "$ghcp_poll" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access_token","") or "")' 2>/dev/null)" || ghcp_token=""
      if [ -n "$ghcp_token" ]; then
        ARCHESTRA_GHCP_TOKEN="$ghcp_token"
        break
      fi
      ghcp_error="$(printf '%s' "$ghcp_poll" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("error",""))' 2>/dev/null)" || ghcp_error=""
      case "$ghcp_error" in
        # keep polling on pending and on transient/parse hiccups
        authorization_pending|"") ;;
        slow_down) ghcp_interval=$((ghcp_interval + 5)) ;;
        *) err "GitHub sign-in failed: $ghcp_error"; exit 1 ;;
      esac
    done
    ok "GitHub account linked."
    if ! ghcp_validate "$ARCHESTRA_GHCP_TOKEN"; then
      err "this GitHub account does not appear to have an active Copilot subscription."
      exit 1
    fi
  fi
fi

say 'Copilot provider settings (GitHub Copilot via OpenAI-compatible protocol)'
echo
echo 'Add these lines to your shell profile (e.g. ~/.zshrc), set COPILOT_MODEL to the model you use:'
printf '  export COPILOT_PROVIDER_TYPE="openai"\\n'
printf '  export COPILOT_PROVIDER_BASE_URL="%s"\\n' ${sh(proxy.url)}
if [ -n "$ARCHESTRA_GHCP_TOKEN" ]; then
  printf '  export COPILOT_PROVIDER_API_KEY="%s"\\n' "$ARCHESTRA_GHCP_TOKEN"
else
  printf '  export COPILOT_PROVIDER_API_KEY="%s"\\n' '<your-github-oauth-token>'
fi
printf '  export COPILOT_MODEL="<model-name>"\\n'`;
}

// ===================================================================
// Internal helpers — Cursor
// ===================================================================

const CURSOR_MCP_MERGE_PY = `import json, os, pathlib
path = pathlib.Path(os.path.expanduser("~/.cursor/mcp.json"))
config = {}
if path.exists():
    raw = path.read_text().strip()
    if raw:
        config = json.loads(raw)
servers = config.setdefault("mcpServers", {})
servers[os.environ["ARCHESTRA_MCP_SERVER_NAME"]] = {
    "url": os.environ["ARCHESTRA_MCP_SERVER_URL"],
}
path.write_text(json.dumps(config, indent=2) + "\\n")
print(f"Updated {path}")`;

function cursorSections(ctx: SetupScriptContext): string[] {
  const sections: string[] = [];

  if (ctx.mcp) {
    sections.push(`say ${sh(`Adding MCP gateway "${ctx.mcp.serverName}" to ~/.cursor/mcp.json (OAuth)`)}
${mergeJsonFileSnippet({
  file: "$HOME/.cursor/mcp.json",
  env: {
    ARCHESTRA_MCP_SERVER_NAME: ctx.mcp.serverName,
    ARCHESTRA_MCP_SERVER_URL: ctx.mcp.url,
  },
  python: CURSOR_MCP_MERGE_PY,
  fallbackMessage:
    "python3 not found — merge this into ~/.cursor/mcp.json manually:",
  fallbackSnippet: JSON.stringify(
    { mcpServers: { [ctx.mcp.serverName]: { url: ctx.mcp.url } } },
    null,
    2,
  ),
})}`);
  }

  if (ctx.proxy) {
    // Cursor's model settings are UI-only; print everything needed for paste.
    sections.push(`say ${sh("Cursor model settings (manual step)")}
cat <<'ARCHESTRA_CURSOR'

In Cursor: Settings -> Models -> API Keys -> OpenAI API Key
  1. Turn on "Override OpenAI Base URL" and paste: ${ctx.proxy.url}
  2. ${
    ctx.proxy.virtualKey
      ? `Paste this key into the API Key field and click Verify:
     ${ctx.proxy.virtualKey}`
      : `Paste your own ${ctx.proxy.providerLabel} API key into the API Key field and click Verify.`
  }
ARCHESTRA_CURSOR`);
  }

  if (ctx.skills) {
    sections.push(`say ${sh(`Skills marketplace (manual step)`)}
cat <<'ARCHESTRA_CURSOR_SKILLS'

In Cursor's command palette run /add-plugin and paste:
  ${ctx.skills.cloneUrl}
ARCHESTRA_CURSOR_SKILLS`);
  }

  return sections;
}
