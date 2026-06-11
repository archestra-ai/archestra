import { DEFAULT_APP_NAME, type SupportedProvider } from "@archestra/shared";
import type {
  ConnectionSetupClientId,
  ConnectionSetupProxyAuth,
} from "@/types";

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
}

export interface SetupScriptSkillsSection {
  cloneUrl: string;
  marketplaceName: string;
}

export interface SetupScriptContext {
  clientId: ConnectionSetupClientId;
  /** White-label product name for user-facing messaging. */
  appName: string;
  mcp: SetupScriptMcpSection | null;
  proxy: SetupScriptProxySection | null;
  skills: SetupScriptSkillsSection | null;
}

/** The one-liner shown in the UI. `origin` is the API origin (no /v1). */
export function buildSetupCommand(params: {
  origin: string;
  rawToken: string;
}): string {
  // single quotes: nothing in the URL may expand in the user's shell.
  return `curl -fsSL ${sh(`${params.origin}/api/connection-setups/script/${params.rawToken}`)} | bash`;
}

/** Strips the /v1 suffix the connection base URLs carry. */
export function proxyBaseUrlToOrigin(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function renderSetupScript(rawCtx: SetupScriptContext): string {
  // appName is white-label, admin-controlled text that lands in bash comments
  // and unquoted echo strings. Collapse control characters (newlines, NUL, …)
  // to spaces so it can never break out of a comment line and execute.
  const ctx: SetupScriptContext = {
    ...rawCtx,
    appName: sanitizeAppName(rawCtx.appName),
  };
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

/** Collapse control characters so appName is safe in comments and bare echoes. */
function sanitizeAppName(appName: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  return appName.replace(/[\x00-\x1f\x7f]+/g, " ").trim() || "Archestra";
}

function header(ctx: SetupScriptContext): string {
  const label = CLIENT_LABELS[ctx.clientId];
  const binary = CLIENT_BINARIES[ctx.clientId];
  const requireBinary = binary
    ? `
if ! command -v ${binary} >/dev/null 2>&1; then
  echo "error: the '${binary}' CLI was not found on PATH. Install ${label} first, then re-run this command." >&2
  exit 1
fi`
    : "";

  return `#!/usr/bin/env bash
# ${ctx.appName} setup for ${label}.
# Generated by the ${ctx.appName} /connection page. This script contains
# credentials — do not share or commit it.
set -euo pipefail

${banner(ctx)}

say() { printf '\\n==> %s\\n' "$1"; }
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

  const logo =
    ctx.appName === DEFAULT_APP_NAME
      ? `   .----------------.
   |       __       |
   |      / /       |
   |     / /        |     ${ctx.appName}
   |    / /  __     |     Secure access to your AI tools
   |   /_/  |__|    |
   '----------------'`
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
  const lines = [`say "Done."`];

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
          `Run /plugin marketplace browse ${ctx.skills.marketplaceName} inside Claude Code to install the shared skills.`,
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
  if [ -f ${sh(params.file)} ]; then
    cp ${sh(params.file)} ${sh(`${params.file}.archestra-backup`)}
  fi
${indent(envAssignments, "  ")}
  python3 - <<'ARCHESTRA_PY'
${params.python}
ARCHESTRA_PY
else
  echo ${sh(params.fallbackMessage)}
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
    sections.push(`say ${sh(`Registering the "${ctx.skills.marketplaceName}" skills marketplace`)}
if ! claude plugin marketplace add ${sh(ctx.skills.cloneUrl)}; then
  echo "Marketplace may already be registered — run /plugin inside Claude Code to inspect."
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
path.write_text(json.dumps(settings, indent=2) + "\\n")
print(f"Updated {path}")`;

function claudeAnthropicProxySection(proxy: SetupScriptProxySection): string {
  const env: Record<string, string> = {
    ARCHESTRA_SET_ENV_ANTHROPIC_BASE_URL: proxy.url,
  };
  const manualEnv: Record<string, string> = { ANTHROPIC_BASE_URL: proxy.url };
  if (proxy.virtualKey) {
    env.ARCHESTRA_SET_ENV_ANTHROPIC_AUTH_TOKEN = proxy.virtualKey;
    manualEnv.ANTHROPIC_AUTH_TOKEN = proxy.virtualKey;
  }
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
  return `say ${sh("Routing Claude Code through the Bedrock proxy")}
${mergeJsonFileSnippet({
  file: "$HOME/.claude/settings.json",
  env: {
    ARCHESTRA_SET_ENV_CLAUDE_CODE_USE_BEDROCK: "1",
    ARCHESTRA_SET_ENV_AWS_REGION: "us-east-1",
    ARCHESTRA_SET_ENV_ANTHROPIC_BEDROCK_BASE_URL: proxy.url,
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
  cp "$CONFIG" "$CONFIG.archestra-backup"
  # drop any previous archestra-managed block for this provider
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
  echo "Marketplace may already be registered — run /plugins inside Codex to inspect."
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

  if (ctx.skills) {
    sections.push(`say ${sh(`Registering the "${ctx.skills.marketplaceName}" skills marketplace`)}
if ! copilot plugin marketplace add ${sh(ctx.skills.cloneUrl)}; then
  echo "Marketplace may already be registered — run 'copilot plugin marketplace browse' to inspect."
fi`);
  }

  return sections;
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
