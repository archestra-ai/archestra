import {
  CODEX_CLIENT_ID,
  EXTERNAL_AGENT_ID_HEADER,
  REQUIRED_OPENAPPA_TOOL_SHORT_NAMES,
  TOOL_ASK_USER_SHORT_NAME,
  VIRTUAL_KEY_HEADER,
} from "@archestra/shared";
import { CODEX_GUARD_CLIENT } from "../guard/clients";
import { starterPrompt } from "../steps/ending";
import { describeMarketplaceContents } from "../steps/marketplace-copy";
import { legacyServerNames } from "../steps/mcp";
import { psq, sh } from "../steps/quoting";
import {
  withStartupGuardBash,
  withStartupGuardPowerShell,
} from "../steps/startup-guard";
import type {
  AgentEnding,
  SetupScriptContext,
  SetupScriptMcpSection,
  SetupScriptProxySection,
  ShellAgentSetup,
} from "../types";

// Codex setup. Shared helpers first, then the bash and PowerShell section lists
// side by side, then the ending and the agent module the dispatcher in
// ../index.ts uses.

/**
 * TOML basic-string quoting for a header name/value in ~/.codex/config.toml.
 * The inputs here (attribution header names and `arch_`-prefixed key values)
 * never contain control characters or newlines, so escaping the two basic-string
 * specials — backslash and double-quote — is sufficient and correct.
 */
function tomlBasicString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Attribution headers Codex sends on every proxied request, emitted as a
 * `[model_providers.<name>.http_headers]` TOML table (Codex's equivalent of
 * Claude Code's ANTHROPIC_CUSTOM_HEADERS), one `"Name" = "Value"` per line:
 *  - X-Archestra-Agent-Id attributes the request to the Codex CLI client.
 *  - X-Archestra-Virtual-Key (passthrough) attributes it to the user; in
 *    virtual-key mode the injected key already carries that attribution.
 */
function codexAttributionHeaderLines(proxy: SetupScriptProxySection): string {
  const lines = [
    `${tomlBasicString(EXTERNAL_AGENT_ID_HEADER)} = ${tomlBasicString(CODEX_CLIENT_ID)}`,
  ];
  if (proxy.passthroughVirtualKey) {
    lines.push(
      `${tomlBasicString(VIRTUAL_KEY_HEADER)} = ${tomlBasicString(proxy.passthroughVirtualKey)}`,
    );
  }
  return lines.join("\n");
}

const CODEX_HELPER_APPROVALS_NOTICE =
  "Codex can call the guardrail helpers without asking each time. Required human reviews still apply.";

/**
 * Codex asks before each call of an MCP tool that config.toml does not
 * approve, and one call that needs a person's approval runs the guardrail
 * helpers several times. Connect approves these helpers, as it does for Claude
 * Code; other gateway tools keep Codex's question. The tables sit under the
 * gateway's own entry, the way Codex's "Always allow" writes them, so
 * `codex mcp remove` drops them with it and a rerun writes them once.
 *
 * @public — asserted by the setup script unit tests, which knip --production ignores.
 */
export function codexHelperApprovalTables(mcp: SetupScriptMcpSection): string {
  return [...REQUIRED_OPENAPPA_TOOL_SHORT_NAMES, TOOL_ASK_USER_SHORT_NAME]
    .map(
      (name) =>
        `[mcp_servers.${tomlBasicString(mcp.serverName)}.tools.${tomlBasicString(`${mcp.toolPrefix}${name}`)}]\napproval_mode = "approve"`,
    )
    .join("\n\n");
}

function codexBashSections(ctx: SetupScriptContext): string[] {
  const sections: string[] = [];

  if (ctx.mcp || ctx.proxy || ctx.skills) {
    // Codex owns config.toml wherever CODEX_HOME points (default ~/.codex),
    // and every action below edits that file — the mcp/skills registrations
    // through the codex CLI just as much as the provider block this script
    // appends itself. The one-time backup must therefore be taken before the
    // FIRST of them, or "pristine pre-Archestra config" would already contain
    // the gateway the CLI registered a moment earlier.
    sections.push(`CONFIG="\${CODEX_HOME:-$HOME/.codex}/config.toml"
if [ -f "$CONFIG" ] && [ ! -f "$CONFIG.archestra-backup" ]; then
  cp "$CONFIG" "$CONFIG.archestra-backup"
fi`);
  }

  if (ctx.mcp) {
    const stale = legacyServerNames(ctx.mcp)
      .map((name) => `cli codex mcp remove ${sh(name)} >/dev/null 2>&1 || true`)
      .join("\n");
    sections.push(`say ${sh(`Adding ${ctx.appName} tools as "${ctx.mcp.serverName}"`)}
cli codex mcp remove ${sh(ctx.mcp.serverName)} >/dev/null 2>&1 || true${stale ? `\n${stale}` : ""}
cli codex mcp add ${sh(ctx.mcp.serverName)} --url ${sh(ctx.mcp.url)}
cat >> "$CONFIG" <<'ARCHESTRA_TOML'

${codexHelperApprovalTables(ctx.mcp)}
ARCHESTRA_TOML
ok ${sh(CODEX_HELPER_APPROVALS_NOTICE)}`);
  }

  if (ctx.proxy) {
    const marker = `archestra:${ctx.proxy.proxyName}`;
    const block = `# >>> ${marker} >>>
[model_providers.${ctx.proxy.proxyName}]
name = "${ctx.proxy.proxyName}"
base_url = "${ctx.proxy.url}"
wire_api = "responses"
requires_openai_auth = true

[model_providers.${ctx.proxy.proxyName}.http_headers]
${codexAttributionHeaderLines(ctx.proxy)}
# <<< ${marker} <<<`;

    sections.push(`say ${sh(`Adding the "${ctx.proxy.proxyName}" provider to Codex's config.toml`)}
CONFIG="\${CODEX_HOME:-$HOME/.codex}/config.toml"
mkdir -p "$(dirname "$CONFIG")"
umask 077
if [ -f "$CONFIG" ]; then
  # Drop the previous managed block and any top-level provider selection.
  # Keep a table that Codex itself added inside the block.
  awk -v start=${sh(`# >>> ${marker} >>>`)} -v end=${sh(`# <<< ${marker} <<<`)} -v own=${sh(`[model_providers.${ctx.proxy.proxyName}]`)} -v own_headers=${sh(`[model_providers.${ctx.proxy.proxyName}.http_headers]`)} '
    $0 == start {skip=1; next}
    $0 == end {skip=0; next}
    skip && /^\\[/ && $0 != own && $0 != own_headers {skip=0}
    !skip {
      if ($0 ~ /^\\[/) in_table=1
      if (!in_table && $0 ~ /^[[:space:]]*model_provider[[:space:]]*=/) next
      print
    }
  ' "$CONFIG" > "$CONFIG.archestra-tmp"
else
  : > "$CONFIG.archestra-tmp"
fi
printf 'model_provider = "%s"\n' ${sh(ctx.proxy.proxyName)} > "$CONFIG.archestra-next"
cat "$CONFIG.archestra-tmp" >> "$CONFIG.archestra-next"
cat >> "$CONFIG.archestra-next" <<'ARCHESTRA_TOML'
${block}
ARCHESTRA_TOML
mv -f "$CONFIG.archestra-next" "$CONFIG"
rm "$CONFIG.archestra-tmp"
echo "Updated $CONFIG"${
      ctx.proxy.virtualKey
        ? `

say ${sh("Signing Codex in with your virtual key")}
ARCHESTRA_VIRTUAL_KEY=${sh(ctx.proxy.virtualKey)}
printf '%s' "$ARCHESTRA_VIRTUAL_KEY" | codex login --with-api-key`
        : `
echo "Codex uses your existing ChatGPT or OpenAI API-key login."`
    }`);
  }

  if (ctx.skills) {
    const installs = (ctx.skills.pluginNames ?? []).map((pluginName) => {
      const ref = `${pluginName}@${ctx.skills?.marketplaceName}`;
      return `if ! cli codex plugin add ${sh(ref)}; then
  warn ${sh(`Could not deliver plugin — run 'codex plugin add ${ref}'.`)}
fi`;
    });
    // Each setup gets a new clone URL, and Codex refuses to add a marketplace
    // name again from a different source. Remove the earlier registration
    // first; plugins installed from it stay installed.
    sections.push(`say ${sh(`Registering the "${ctx.skills.marketplaceName}" marketplace`)}
cli codex plugin marketplace remove ${sh(ctx.skills.marketplaceName)} >/dev/null 2>&1 || true
if ! cli codex plugin marketplace add ${sh(ctx.skills.cloneUrl)}; then
  err "Marketplace registration failed. Review the Git error above; HTTP 502 means the server could not serve the repository. Registration has not been verified. Run /plugins to inspect existing registrations, then retry setup after resolving the error."
  exit 1
fi
${installs.join("\n")}`);
  }

  return withStartupGuardBash(ctx, CODEX_GUARD_CLIENT, sections);
}

function codexPowerShellSections(ctx: SetupScriptContext): string[] {
  const sections: string[] = [];

  if (ctx.mcp || ctx.proxy || ctx.skills) {
    // Codex owns config.toml wherever CODEX_HOME points (default ~/.codex),
    // and every action below edits that file — the mcp/skills registrations
    // through the codex CLI just as much as the provider block this script
    // appends itself. The one-time backup must therefore be taken before the
    // FIRST of them, or "pristine pre-Archestra config" would already contain
    // the gateway the CLI registered a moment earlier.
    sections.push(`$arch_config = Join-Path $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }) 'config.toml'
if ((Test-Path $arch_config) -and -not (Test-Path ($arch_config + '.archestra-backup'))) {
  Copy-Item -Path $arch_config -Destination ($arch_config + '.archestra-backup')
}`);
  }

  if (ctx.mcp) {
    const stale = legacyServerNames(ctx.mcp)
      .map(
        (name) =>
          `try { codex mcp remove ${psq(name)} 2>$null | Out-Null } catch { }`,
      )
      .join("\n");
    sections.push(`Say ${psq(`Adding ${ctx.appName} tools as "${ctx.mcp.serverName}"`)}
try { codex mcp remove ${psq(ctx.mcp.serverName)} 2>$null | Out-Null } catch { }${stale ? `\n${stale}` : ""}
codex mcp add ${psq(ctx.mcp.serverName)} --url ${psq(ctx.mcp.url)}
if ($LASTEXITCODE -ne 0) { throw 'Could not register the MCP gateway. Fix the error above and re-run setup.' }
Add-Content -Path $arch_config -Encoding utf8 -Value @'

${codexHelperApprovalTables(ctx.mcp)}
'@
Ok ${psq(CODEX_HELPER_APPROVALS_NOTICE)}`);
  }

  if (ctx.proxy) {
    const marker = `archestra:${ctx.proxy.proxyName}`;
    const block = `# >>> ${marker} >>>
[model_providers.${ctx.proxy.proxyName}]
name = "${ctx.proxy.proxyName}"
base_url = "${ctx.proxy.url}"
wire_api = "responses"
requires_openai_auth = true

[model_providers.${ctx.proxy.proxyName}.http_headers]
${codexAttributionHeaderLines(ctx.proxy)}
# <<< ${marker} <<<`;

    sections.push(`Say ${psq(`Adding the "${ctx.proxy.proxyName}" provider to Codex's config.toml`)}
$arch_config = Join-Path $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }) 'config.toml'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $arch_config) | Out-Null
$arch_keep = New-Object System.Collections.Generic.List[string]
if (Test-Path $arch_config) {
  # Drop any previous archestra-managed block for this provider (idempotent).
  $arch_start = ${psq(`# >>> ${marker} >>>`)}
  $arch_end = ${psq(`# <<< ${marker} <<<`)}
  $arch_own = @(${psq(`[model_providers.${ctx.proxy.proxyName}]`)}, ${psq(`[model_providers.${ctx.proxy.proxyName}.http_headers]`)})
  $arch_skip = $false
  $arch_in_table = $false
  foreach ($arch_line in (Get-Content -Path $arch_config)) {
    if ($arch_line -eq $arch_start) { $arch_skip = $true; continue }
    if ($arch_line -eq $arch_end) { $arch_skip = $false; continue }
    # Keep a table that Codex itself added inside the block.
    if ($arch_skip -and $arch_line -match '^\\[' -and $arch_own -notcontains $arch_line) { $arch_skip = $false }
    if ($arch_skip) { continue }
    if ($arch_line -match '^\\[') { $arch_in_table = $true }
    if (-not $arch_in_table -and $arch_line -match '^\\s*model_provider\\s*=') { continue }
    $arch_keep.Add($arch_line)
  }
}
$arch_next = $arch_config + '.archestra-next'
Set-Content -Path $arch_next -Encoding utf8 -Value ${psq(`model_provider = "${ctx.proxy.proxyName}"`)}
if ($arch_keep.Count -gt 0) { Add-Content -Path $arch_next -Encoding utf8 -Value $arch_keep }
Add-Content -Path $arch_next -Encoding utf8 -Value @'
${block}
'@
Move-Item -Force -Path $arch_next -Destination $arch_config
Write-Host ('Updated ' + $arch_config)${
      ctx.proxy.virtualKey
        ? `

Say ${psq("Signing Codex in with your virtual key")}
$ArchVirtualKey = ${psq(ctx.proxy.virtualKey)}
$ArchVirtualKey | codex login --with-api-key`
        : `
Write-Host 'Codex uses your existing ChatGPT or OpenAI API-key login.'`
    }`);
  }

  if (ctx.skills) {
    const pluginInstalls = (ctx.skills.pluginNames ?? [])
      .map((pluginName) => {
        const ref = `${pluginName}@${ctx.skills?.marketplaceName}`;
        return `codex plugin add ${psq(ref)}
if ($LASTEXITCODE -ne 0) { Warn ${psq(`Could not deliver plugin — run 'codex plugin add ${ref}'.`)} }`;
      })
      .join("\n");
    // Remove the earlier registration first, as in the bash script.
    sections.push(`Say ${psq(`Registering the "${ctx.skills.marketplaceName}" marketplace`)}
try { codex plugin marketplace remove ${psq(ctx.skills.marketplaceName)} 2>$null | Out-Null } catch { }
codex plugin marketplace add ${psq(ctx.skills.cloneUrl)}
if ($LASTEXITCODE -ne 0) { throw 'Marketplace registration failed. Review the Git error above; HTTP 502 means the server could not serve the repository. Registration has not been verified. Run /plugins to inspect existing registrations, then retry setup after resolving the error.' }
${pluginInstalls}`);
  }

  return withStartupGuardPowerShell(ctx, CODEX_GUARD_CLIENT, sections);
}

function codexEnding(ctx: SetupScriptContext): AgentEnding {
  const notes: string[] = [];
  if (ctx.skills && describeMarketplaceContents(ctx.skills).hasSkills) {
    notes.push(
      'In Codex, run /plugins and choose "Install Plugin" to add the shared skills.',
    );
  }
  if (ctx.skills?.pluginNames?.length) {
    notes.push(
      "In Codex, run /hooks and approve each new hook before it runs.",
    );
  }
  return {
    parts:
      ctx.mcp || ctx.proxy || ctx.skills
        ? [{ name: "Launch check", detail: "Runs each time you start codex" }]
        : [],
    signIn: ctx.mcp
      ? {
          command: ["codex", "mcp", "login", ctx.mcp.serverName],
          howTo: `Run codex mcp login ${ctx.mcp.serverName} and finish the sign-in in your browser.`,
        }
      : null,
    launch: ["codex", starterPrompt(ctx)],
    notes,
  };
}

export const codexSetup: ShellAgentSetup = {
  label: "Codex",
  binary: "codex",
  bash: { sections: codexBashSections },
  powerShell: {
    sections: codexPowerShellSections,
  },
  ending: codexEnding,
};
