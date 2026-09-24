import {
  ALL_ARCHESTRA_TOKEN_PREFIXES,
  CLAUDE_CODE_CLIENT_ID,
  CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY,
  CLAUDE_CODE_PROXY_ENV_KEYS,
  COPILOT_PROVIDER_ENV_KEYS,
  DEFAULT_MODELS,
  EXTERNAL_AGENT_ID_HEADER,
  isDefaultBrandedAppName,
  OPENCODE_PASSTHROUGH_PROVIDER_ROUTES,
  openCodePassthroughBaseUrl,
  VIRTUAL_KEY_HEADER,
} from "@archestra/shared";
import type { ConnectionSetupClientId } from "@/types";
import { archestraMarkWithText } from "./archestra-mark";
import {
  claudeCodeOAuthNextStep,
  codexAttributionHeaderLines,
  copilotAttributionHeadersValue,
  opencodeOAuthNextStep,
  opencodeProviderTarget,
  opencodeProxyHeaders,
  type SetupScriptContext,
  type SetupScriptProxySection,
} from "./connection-setup-script";
import { describeMarketplaceContents } from "./marketplace-copy";
import { renderOpenCodeRoutingPlugin } from "./opencode-routing-plugin";
import {
  buildStartupGuardContext,
  type StartupGuardClient,
} from "./startup-guard";
import {
  CLAUDE_CODE_GUARD_CLIENT,
  CODEX_GUARD_CLIENT,
  COPILOT_GUARD_CLIENT,
  OPENCODE_GUARD_CLIENT,
} from "./startup-guard.clients";
import {
  buildWindowsStartupGuardInstallSection,
  buildWindowsStartupGuardUnshadowSection,
} from "./startup-guard.windows";

/**
 * PowerShell renderer for the Windows variant of the /connection one-command
 * setup flow (`irm <url> | iex`). Mirrors the bash renderer in
 * connection-setup-script.ts: deterministic string building, no DB/IO, same
 * idempotency + secret-handling contract, just expressed in PowerShell.
 *
 * Contract parity with the bash renderer:
 * - idempotent re-runs (remove-then-add for CLI registrations, key-scoped
 *   JSON merges / marker-delimited TOML blocks, backups taken once);
 * - secrets travel via PowerShell variables / request bodies / stdin, never as
 *   argv of an external command;
 * - colorized output (Cyan headers, Green success, Yellow/Red advisories),
 *   suppressed when NO_COLOR is set;
 * - ends with next steps + revocation guidance.
 *
 * Targets Windows PowerShell 5.1 (the OS default) as well as PowerShell 7+: no
 * `-AsHashtable`, ternary, or null-coalescing. A native command's non-zero exit
 * is not promoted to a terminating error ($PSNativeCommandUseErrorActionPreference),
 * but that setting does not cover stderr: under $ErrorActionPreference='Stop'
 * Windows PowerShell 5.1 turns any native-command stderr line into a terminating
 * error that 2>$null does not suppress, so the idempotent MCP remove-then-add —
 * whose remove writes "No MCP server named …" to stderr when the server is not
 * yet registered — wraps the remove in try/catch to stay idempotent.
 */
export function renderWindowsSetupScript(ctx: SetupScriptContext): string {
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
    case "opencode":
      sections.push(...opencodeSections(ctx));
      break;
  }

  sections.push(footer(ctx));
  return `${sections.join("\n\n")}\n`;
}

// ===================================================================
// Internal helpers — shared scaffolding
// ===================================================================

const CLIENT_LABELS: Record<ConnectionSetupClientId, string> = {
  "claude-desktop": "Claude Desktop",
  "claude-code": "Claude Code",
  codex: "Codex",
  "copilot-cli": "Copilot CLI",
  cursor: "Cursor",
  opencode: "OpenCode",
};

const CLIENT_BINARIES: Partial<Record<ConnectionSetupClientId, string>> = {
  "claude-code": "claude",
  codex: "codex",
  "copilot-cli": "copilot",
  opencode: "opencode",
};

/** Single-quote a value for PowerShell; safe for arbitrary content. */
function psq(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Color setup + logging helpers. Colors are emitted only when NO_COLOR is
 * unset. `Say` marks section headers, `Ok` a success, `Warn`/`Err` advisory
 * and failure lines. A native command's non-zero exit is demoted from a
 * terminating error ($PSNativeCommandUseErrorActionPreference = $false); its
 * stderr — which $ErrorActionPreference='Stop' still promotes to a terminating
 * error on Windows PowerShell 5.1, past 2>$null — is instead swallowed per-call
 * (try/catch around the idempotent MCP remove) so a re-run never aborts.
 */
const SCRIPT_HELPERS = `$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$ArchUseColor = [string]::IsNullOrEmpty($env:NO_COLOR)
# Header-mark capability. Windows Terminal and PowerShell 7 render the Unicode
# braille mark (the exact macOS/Linux/guard logo); the legacy console (Windows
# PowerShell 5.1 in conhost) mojibakes braille glyphs on its OEM codepage, so it
# falls back to the ASCII mark. Switching this session to UTF-8 is best-effort
# and harmless if it fails — it only affects how the banner below is drawn.
$ArchUtf8 = $false
try {
  if ($env:WT_SESSION -or $PSVersionTable.PSVersion.Major -ge 6) {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
    $OutputEncoding = [System.Text.UTF8Encoding]::new()
    $ArchUtf8 = $true
  }
} catch { }
function Say($m)  { Write-Host ''; if ($ArchUseColor) { Write-Host ('==> ' + $m) -ForegroundColor Cyan } else { Write-Host ('==> ' + $m) } }
function Ok($m)   { if ($ArchUseColor) { Write-Host ('==> ' + $m) -ForegroundColor Green } else { Write-Host ('==> ' + $m) } }
function Warn($m) { if ($ArchUseColor) { Write-Host ('warning: ' + $m) -ForegroundColor Yellow } else { Write-Host ('warning: ' + $m) } }
function Err($m)  { if ($ArchUseColor) { Write-Host ('error: ' + $m) -ForegroundColor Red } else { Write-Host ('error: ' + $m) } }`;

function header(ctx: SetupScriptContext): string {
  const label = CLIENT_LABELS[ctx.clientId];
  const binary = CLIENT_BINARIES[ctx.clientId];
  const requireBinary = binary
    ? `
if (-not (Get-Command ${binary} -ErrorAction SilentlyContinue)) {
  Err "the '${binary}' CLI was not found on PATH. Install ${label} first, then re-run this command."
  exit 1
}`
    : "";

  return `# ${ctx.appName} setup for ${label}.
# Generated by the ${ctx.appName} /connection page. This script contains
# credentials — do not share or commit it.
${SCRIPT_HELPERS}

${banner(ctx)}

Say ${psq(`${ctx.appName} setup: ${label}`)}${requireBinary}`;
}

/**
 * Splash printed at the top of every script: the Archestra mark plus a plain
 * details block, emitted through single-quoted here-strings so nothing in them
 * is ever expanded by PowerShell. The mark is the exact canonical logo (shared
 * with the macOS/Linux banner and every startup guard) when the host can render
 * UTF-8 braille glyphs, and the portable ASCII rendition of the same composition
 * otherwise — chosen at runtime by $ArchUtf8 (set in SCRIPT_HELPERS) so a legacy
 * `irm | iex` console never mojibakes.
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
  if (ctx.skills) {
    configures.push(describeMarketplaceContents(ctx.skills).label);
  }

  const details = [
    `   Client:     ${label}`,
    configures.length > 0 ? `   Configures: ${configures.join(", ")}` : null,
    `   Note:       one-time setup — this link expires after first use.`,
  ]
    .filter(Boolean)
    .join("\n");

  const markBlock = isDefaultBrandedAppName(ctx.appName)
    ? `if ($ArchUtf8) {
Write-Host @'

${archestraMarkWithText({ appName: ctx.appName, variant: "unicode" }).join("\n")}
'@
} else {
Write-Host @'

${archestraMarkWithText({ appName: ctx.appName, variant: "ascii" }).join("\n")}
'@
}`
    : `Write-Host @'

   ${ctx.appName}
   Secure access to your AI tools
'@`;

  return `${markBlock}
Write-Host @'

${details}
'@`;
}

function footer(ctx: SetupScriptContext): string {
  const lines = [`Ok "Done."`];

  const nextSteps = nextStepsFor(ctx);
  if (nextSteps.length > 0) {
    lines.push(`Write-Host @'

Next steps:
${nextSteps.map((step, i) => `  ${i + 1}. ${step}`).join("\n")}
'@`);
  }

  const revocation: string[] = [];
  if (ctx.proxy?.virtualKeyName) {
    revocation.push(
      `delete the "${ctx.proxy.virtualKeyName}" key on the Virtual API Keys page`,
    );
  }
  if (ctx.skills) {
    revocation.push(
      `revoke the "${ctx.skills.marketplaceName}" marketplace share link`,
    );
  }
  if (revocation.length > 0) {
    lines.push(`Write-Host @'

To revoke this machine's access later in ${ctx.appName}: ${revocation.join("; ")}.
'@`);
  }

  return lines.join("\n");
}

function nextStepsFor(ctx: SetupScriptContext): string[] {
  const steps: string[] = [];
  if (ctx.clientId === "cursor") {
    steps.push(
      ctx.mcp && ctx.runtimeHandoffInstructions
        ? "Runtime handoff needs a manual step: paste the printed handoff instructions into Cursor Customize > Rules > User Rules. Keep your existing rules."
        : "If you previously added runtime handoff instructions to Cursor User Rules, remove that text to disable them.",
    );
  }
  switch (ctx.clientId) {
    case "opencode":
      if (ctx.mcp) {
        steps.push(opencodeOAuthNextStep(ctx.mcp.serverName));
      }
      if (ctx.proxy) {
        if (ctx.proxy.authMode === "provider-key") {
          steps.push(
            "Keep using OpenCode's existing provider and model picker. Providers with compatible local credentials now route through the LLM proxy without moving credentials out of OpenCode.",
          );
        } else {
          const target = opencodeProviderTarget(ctx);
          steps.push(
            `Select ${target.id}/${target.model} in OpenCode to use the virtual key-backed proxy provider.`,
          );
        }
      }
      if (ctx.mcp || ctx.proxy || ctx.skills) {
        steps.push(
          "Close every running OpenCode process. Then open a new PowerShell session and start `opencode`. The startup guard checks these remotes before every launch.",
        );
      }
      break;
    case "claude-code":
      if (ctx.mcp) {
        steps.push(claudeCodeOAuthNextStep(ctx.mcp.serverName));
      }
      if (ctx.skills && describeMarketplaceContents(ctx.skills).hasSkills) {
        steps.push(
          "The shared skills are installed for Claude Code — start `claude` and they load automatically.",
        );
      }
      if (ctx.skills?.pluginNames?.length) {
        steps.push(
          `${ctx.skills.pluginNames.length} plugin${ctx.skills.pluginNames.length === 1 ? " is" : "s are"} installed and will load automatically.`,
        );
      }
      if (ctx.mcp || ctx.proxy || ctx.skills) {
        steps.push(
          "Open a new PowerShell session so the startup guard wrapper takes effect — it checks these remotes before every `claude` launch.",
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
            "Use your existing Codex ChatGPT login, or sign in with your own OpenAI API key (codex login --with-api-key).",
          );
        }
        steps.push(
          `Open a new PowerShell session and run \`codex\` — ${ctx.proxy.proxyName} is now the default model provider.`,
        );
      }
      if (ctx.skills && describeMarketplaceContents(ctx.skills).hasSkills) {
        steps.push(
          'Run /plugins inside Codex and pick "Install Plugin" to install the included skills.',
        );
      }
      if (ctx.skills?.pluginNames?.length) {
        steps.push(
          "Run `/hooks` inside Codex and approve each delivered hook before it can execute.",
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
        // The key is applied automatically when the script knows it: a minted
        // virtual key, or the GitHub token the Copilot link section obtains.
        const keyApplied =
          Boolean(ctx.proxy.virtualKey) ||
          ctx.proxy.provider === "github-copilot";
        steps.push(
          keyApplied
            ? 'The COPILOT_* provider variables (including a default COPILOT_MODEL) were applied for you — verify with: copilot -p "Reply with exactly: archestra-copilot-cli-ok"'
            : `Set ${COPILOT_PROVIDER_ENV_KEYS.apiKey} to your own key (the other COPILOT_* variables were applied for you), then verify with: copilot -p "Reply with exactly: archestra-copilot-cli-ok"`,
        );
      }
      if (ctx.skills && describeMarketplaceContents(ctx.skills).hasSkills) {
        steps.push(
          `Browse and install the shared skills: copilot plugin marketplace browse ${ctx.skills.marketplaceName}`,
        );
      }
      if (ctx.skills?.pluginNames?.length) {
        steps.push("The plugins are installed and enabled.");
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
 * Key-scoped JSON merge using PowerShell's built-in ConvertFrom-Json /
 * ConvertTo-Json (no python dependency). Ensures the file exists, backs it up
 * once, ensures a nested object, then sets each leaf property. Works on
 * Windows PowerShell 5.1 (PSCustomObject + Add-Member, not -AsHashtable).
 */
function mergeJsonFileSnippet(params: {
  /** PowerShell expression resolving to the file path (e.g. a Join-Path). */
  pathExpr: string;
  /** Dotted accessor of the nested object to merge into, e.g. "env". */
  nestedKey: string;
  /** Leaf key/value pairs to set under the nested object. */
  values: Record<string, string>;
  removeManagedTokenKeys?: string[];
}): string {
  const removeManagedTokens = params.removeManagedTokenKeys?.length
    ? `foreach ($arch_key in @(${params.removeManagedTokenKeys.map(psq).join(", ")})) {
  $arch_property = $arch_nested.PSObject.Properties[$arch_key]
  if ($arch_property -and ($arch_property.Value -is [string])) {
    foreach ($arch_prefix in @(${ALL_ARCHESTRA_TOKEN_PREFIXES.map(psq).join(", ")})) {
      if ($arch_property.Value.StartsWith($arch_prefix, [StringComparison]::Ordinal)) {
        $arch_nested.PSObject.Properties.Remove($arch_key)
        break
      }
    }
  }
}`
    : "";
  const setLines = Object.entries(params.values)
    .map(
      ([key, value]) =>
        `if ($arch_nested.PSObject.Properties[${psq(key)}]) { $arch_nested.${psBareOrIndex(key)} = ${psq(value)} } else { $arch_nested | Add-Member -NotePropertyName ${psq(key)} -NotePropertyValue ${psq(value)} }`,
    )
    .join("\n");

  return `$arch_path = ${params.pathExpr}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $arch_path) | Out-Null
if ((Test-Path $arch_path) -and -not (Test-Path ($arch_path + '.archestra-backup'))) {
  Copy-Item -Path $arch_path -Destination ($arch_path + '.archestra-backup')
}
$arch_config = [pscustomobject]@{}
if (Test-Path $arch_path) {
  $arch_raw = Get-Content -Raw -Path $arch_path
  if ($arch_raw -and $arch_raw.Trim()) { $arch_config = $arch_raw | ConvertFrom-Json }
}
if (-not $arch_config.PSObject.Properties[${psq(params.nestedKey)}]) { $arch_config | Add-Member -NotePropertyName ${psq(params.nestedKey)} -NotePropertyValue ([pscustomobject]@{}) }
$arch_nested = $arch_config.${psBareOrIndex(params.nestedKey)}
${removeManagedTokens}
${setLines}
$arch_config | ConvertTo-Json -Depth 32 | Set-Content -Path $arch_path -Encoding utf8
Write-Host ('Updated ' + $arch_path)`;
}

/**
 * Property access for a key known to be a safe slug; falls back to a quoted
 * index for anything with non-identifier characters. Server/proxy names are
 * already slugs, so this is defensive.
 */
function psBareOrIndex(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : `${psq(key)}`;
}

// ===================================================================
// Internal helpers — Claude Code
// ===================================================================

/**
 * Wrap a CLI client's setup steps with the same startup-guard lifecycle. The
 * old guard is unshadowed before any client command runs and the refreshed
 * guard is installed only after setup succeeds.
 */
function withWindowsStartupGuard(
  ctx: SetupScriptContext,
  client: StartupGuardClient,
  sections: string[],
): string[] {
  return ctx.mcp || ctx.proxy || ctx.skills
    ? [
        `$archPreviousStartupWrapper = Get-Item Function:${client.binary} -ErrorAction SilentlyContinue
try {`,
        buildWindowsStartupGuardUnshadowSection(client),
        ...sections,
        buildWindowsStartupGuardInstallSection(
          buildStartupGuardContext(ctx),
          client,
        ),
        `} catch {
  if ($null -ne $archPreviousStartupWrapper) {
    Set-Item Function:${client.binary} -Value $archPreviousStartupWrapper.ScriptBlock
  }
  throw
} finally {
  Remove-Variable archPreviousStartupWrapper -ErrorAction SilentlyContinue
}`,
      ]
    : sections;
}

function claudeCodeSections(ctx: SetupScriptContext): string[] {
  const sections: string[] = [];

  if (ctx.mcp) {
    // Register at USER scope so the gateway is visible in every directory for
    // this user (see connection-setup-script.ts for the full rationale). Clear
    // both local and user scopes first so a stale local entry can't shadow the
    // user entry.
    sections.push(`Say ${psq(`Registering MCP gateway "${ctx.mcp.serverName}" (OAuth)`)}
try { claude mcp remove --scope local ${psq(ctx.mcp.serverName)} 2>$null | Out-Null } catch { }
try { claude mcp remove --scope user ${psq(ctx.mcp.serverName)} 2>$null | Out-Null } catch { }
claude mcp add --scope user --transport http ${psq(ctx.mcp.serverName)} ${psq(ctx.mcp.url)}
if ($LASTEXITCODE -ne 0) { throw 'Could not register the MCP gateway. Fix the error above and re-run setup.' }`);
  }

  if (ctx.proxy) {
    sections.push(
      ctx.proxy.provider === "bedrock"
        ? claudeBedrockProxySection(ctx.proxy)
        : claudeAnthropicProxySection(ctx.proxy),
    );
  }

  if (ctx.skills) {
    const hasSkills = ctx.skills.hasSkills ?? true;
    const pluginInstalls = (ctx.skills.pluginNames ?? [])
      .map((pluginName) => {
        const ref = `${pluginName}@${ctx.skills?.marketplaceName}`;
        return `claude plugin install ${psq(ref)}
if ($LASTEXITCODE -ne 0) { Warn ${psq(`Could not install plugin — run 'claude plugin install ${ref}'.`)} }`;
      })
      .join("\n");
    const pluginRef = `${ctx.skills.marketplaceName}@${ctx.skills.marketplaceName}`;
    sections.push(`Say ${psq(`Installing the "${ctx.skills.marketplaceName}" marketplace`)}
${windowsClaudeMarketplaceRegistration(ctx.skills.marketplaceName, ctx.skills.cloneUrl)}
${
  hasSkills
    ? `claude plugin install ${psq(pluginRef)}
if ($LASTEXITCODE -ne 0) { Warn ${psq(`Could not install the skills automatically — run 'claude plugin install ${pluginRef}' or open /plugin inside Claude Code.`)} }`
    : ""
}
${pluginInstalls}`);
  }

  return withWindowsStartupGuard(ctx, CLAUDE_CODE_GUARD_CLIENT, sections);
}

/**
 * Claude Code declares user marketplaces in settings.json as structured
 * sources. Compare that declaration before calling `marketplace add`: matching
 * credential-bearing URLs and equivalent Authorization headers describe the
 * same fetch identity, while changed source or credentials need replacement.
 */
function windowsClaudeMarketplaceRegistration(
  marketplaceName: string,
  cloneUrl: string,
): string {
  const add = `claude plugin marketplace add --scope user ${psq(cloneUrl)}`;
  return `function Get-ArchMarketplaceTarget($value) {
  try {
    $uri = [uri]$value
    if (-not $uri.Scheme -or -not $uri.Host) { return $null }
    $uriHost = $uri.Host.ToLowerInvariant()
    if ($uriHost.Contains(':') -and -not $uriHost.StartsWith('[')) { $uriHost = '[' + $uriHost + ']' }
    $authority = $uriHost
    if (-not $uri.IsDefaultPort) { $authority += ':' + $uri.Port }
    return @($uri.Scheme.ToLowerInvariant(), $authority, $(if ($uri.AbsolutePath) { $uri.AbsolutePath } else { '/' }), $uri.Query) -join '|'
  } catch { return $null }
}
function Get-ArchMarketplaceCredentials($value) {
  try {
    $uri = [uri]$value
    if ([string]::IsNullOrEmpty($uri.UserInfo)) { return $null }
    $parts = $uri.UserInfo.Split(':', 2)
    return [uri]::UnescapeDataString($parts[0]) + ':' + $(if ($parts.Length -gt 1) { [uri]::UnescapeDataString($parts[1]) } else { '' })
  } catch { return $null }
}
function Get-ArchMarketplaceState {
  $configDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.claude' }
  $settingsPath = Join-Path $configDir 'settings.json'
  if (-not (Test-Path $settingsPath)) { return 'add' }
  try { $settings = Get-Content -Raw -Path $settingsPath | ConvertFrom-Json } catch { return 'unknown' }
  $marketplaces = $settings.extraKnownMarketplaces
  if (-not $marketplaces -or -not $marketplaces.PSObject.Properties[${psq(marketplaceName)}]) { return 'add' }
  $source = $marketplaces.PSObject.Properties[${psq(marketplaceName)}].Value.source
  if (-not $source -or $source.source -cne 'git' -or -not $source.url) { return 'replace' }
  $desiredUrl = ${psq(cloneUrl)}
  $declaredTarget = Get-ArchMarketplaceTarget $source.url
  $desiredTarget = Get-ArchMarketplaceTarget $desiredUrl
  if ($null -eq $declaredTarget -or $null -eq $desiredTarget -or $declaredTarget -cne $desiredTarget) { return 'replace' }
  foreach ($field in @('ref', 'path', 'sparsePaths')) {
    if ($source.PSObject.Properties[$field] -and $source.$field) { return 'replace' }
  }
  $declaredCredentials = Get-ArchMarketplaceCredentials $source.url
  $desiredCredentials = Get-ArchMarketplaceCredentials $desiredUrl
  $headers = @{}
  if ($source.PSObject.Properties['headers'] -and $source.headers) {
    if ($source.headers -is [array]) {
      foreach ($header in $source.headers) {
        if ($header.name) { $headers[[string]$header.name.ToLowerInvariant()] = [string]$header.value }
      }
    } else {
      foreach ($header in $source.headers.PSObject.Properties) { $headers[$header.Name.ToLowerInvariant()] = [string]$header.Value }
    }
  }
  if ($declaredCredentials -ceq $desiredCredentials -and $headers.Count -eq 0) { return 'matching' }
  if (-not $declaredCredentials -and $desiredCredentials) {
    $basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($desiredCredentials))
    if ($headers.Count -eq 1 -and $headers['authorization'] -ceq ('Basic ' + $basic)) { return 'matching' }
  }
  return 'replace'
}
function Remove-ArchMarketplace {
  $marketplaceRemoved = $false
  try {
    claude plugin marketplace remove --scope user ${psq(marketplaceName)} 2>$null | Out-Null
    $marketplaceRemoved = $LASTEXITCODE -eq 0
  } catch { }
  return $marketplaceRemoved
}

$marketplaceState = Get-ArchMarketplaceState
if ($marketplaceState -eq 'matching') {
  Ok ${psq(`Marketplace "${marketplaceName}" is already registered with the requested source.`)}
} elseif ($marketplaceState -eq 'replace') {
  Say ${psq(`Updating the "${marketplaceName}" marketplace source`)}
  if (-not (Remove-ArchMarketplace)) {
    Err ${psq(`Could not replace the "${marketplaceName}" marketplace source. Shared skills were not installed.`)}
    exit 1
  }
  ${add}
  if ($LASTEXITCODE -ne 0) {
    Err ${psq(`Could not register the "${marketplaceName}" marketplace. Shared skills were not installed.`)}
    exit 1
  }
} else {
$marketplaceAddOutput = ''
$marketplaceAdded = $false
try {
  $marketplaceAddOutput = & ${add} 2>&1 | Out-String
  $marketplaceAdded = $LASTEXITCODE -eq 0
} catch {
  $marketplaceAddOutput += $_.Exception.Message
}
if (-not $marketplaceAdded) {
  Write-Host $marketplaceAddOutput
  if ($marketplaceAddOutput -like '*network source differs from the one declared for it in settings*') {
    Say ${psq(`Updating the "${marketplaceName}" marketplace source`)}
    if (-not (Remove-ArchMarketplace)) {
      Err ${psq(`Could not replace the "${marketplaceName}" marketplace source. Shared skills were not installed.`)}
      exit 1
    }
    claude plugin marketplace add --scope user ${psq(cloneUrl)}
    if ($LASTEXITCODE -ne 0) {
      Err ${psq(`Could not register the "${marketplaceName}" marketplace. Shared skills were not installed.`)}
      exit 1
    }
  } else {
    Err ${psq(`Could not register the "${marketplaceName}" marketplace. Shared skills were not installed.`)}
    exit 1
  }
}
}
${claudeMarketplaceAutoUpdate(marketplaceName)}`;
}

/**
 * PowerShell twin of the bash renderer's `claudeMarketplaceAutoUpdate`:
 * Claude Code keeps a third-party marketplace's plugins at the installed
 * revision unless the marketplace declares `autoUpdate`, which is off by
 * default. Set it on our declaration unless the user already chose a value.
 */
function claudeMarketplaceAutoUpdate(marketplaceName: string): string {
  return `$archAutoUpdateState = 'unavailable'
try {
  $archAutoConfigDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.claude' }
  $archAutoSettingsPath = Join-Path $archAutoConfigDir 'settings.json'
  $archAutoSettings = Get-Content -Raw -Path $archAutoSettingsPath | ConvertFrom-Json
  $archAutoEntry = $archAutoSettings.extraKnownMarketplaces.PSObject.Properties[${psq(marketplaceName)}]
  if ($archAutoEntry -and $archAutoEntry.Value) {
    if ($archAutoEntry.Value.PSObject.Properties['autoUpdate']) {
      $archAutoUpdateState = 'kept'
    } else {
      $archAutoEntry.Value | Add-Member -NotePropertyName 'autoUpdate' -NotePropertyValue $true
      [IO.File]::WriteAllText($archAutoSettingsPath, ($archAutoSettings | ConvertTo-Json -Depth 32), (New-Object System.Text.UTF8Encoding $false))
      $archAutoUpdateState = 'enabled'
    }
  }
} catch { $archAutoUpdateState = 'unavailable' }
if ($archAutoUpdateState -eq 'enabled') {
  Ok ${psq(`Enabled auto-update for the "${marketplaceName}" marketplace.`)}
} elseif ($archAutoUpdateState -ne 'kept') {
  Warn ${psq(`Could not enable auto-update for the "${marketplaceName}" marketplace. Enable it in /plugin > Marketplaces so Claude Code picks up new skill versions.`)}
}`;
}

const CLAUDE_SETTINGS_PATH =
  "(Join-Path $env:USERPROFILE '.claude\\settings.json')";

// Same shared env-key source as the bash renderer, so connect and every
// disconnect surface write/strip identical settings.json keys.
const [ANTHROPIC_BASE_URL_KEY, ANTHROPIC_AUTH_TOKEN_KEY] =
  CLAUDE_CODE_PROXY_ENV_KEYS.anthropic;
const [
  CLAUDE_USE_BEDROCK_KEY,
  AWS_REGION_KEY,
  BEDROCK_BASE_URL_KEY,
  AWS_BEARER_TOKEN_KEY,
] = CLAUDE_CODE_PROXY_ENV_KEYS.bedrock;

/**
 * Custom headers Claude Code sends on every proxied request (Anthropic and
 * Bedrock alike — ANTHROPIC_CUSTOM_HEADERS applies to both), one "Name: Value"
 * per line: X-Archestra-Agent-Id (Claude Code attribution, always) and the
 * X-Archestra-Virtual-Key passthrough header (user attribution, when present).
 */
function claudeCustomHeaderLines(proxy: SetupScriptProxySection): string[] {
  const headerLines = [`${EXTERNAL_AGENT_ID_HEADER}: ${CLAUDE_CODE_CLIENT_ID}`];
  if (proxy.passthroughVirtualKey) {
    headerLines.push(`${VIRTUAL_KEY_HEADER}: ${proxy.passthroughVirtualKey}`);
  }
  return headerLines;
}

function claudeAnthropicProxySection(proxy: SetupScriptProxySection): string {
  const values: Record<string, string> = {
    [ANTHROPIC_BASE_URL_KEY]: proxy.url,
  };
  if (proxy.virtualKey) {
    values[ANTHROPIC_AUTH_TOKEN_KEY] = proxy.virtualKey;
  }
  // Append our custom headers after the base-URL merge, preserving any the user
  // already set.
  const headerAppend = `\n${claudeCustomHeaderAppendSnippet(claudeCustomHeaderLines(proxy))}`;
  const passthroughNote = proxy.virtualKey
    ? ""
    : `
Write-Host ${psq(`Your existing ${proxy.providerLabel} credentials keep working — only the base URL changed.`)}`;

  return `Say ${psq(`Routing Claude Code through the ${proxy.providerLabel} proxy`)}
${mergeJsonFileSnippet({
  pathExpr: CLAUDE_SETTINGS_PATH,
  nestedKey: "env",
  values,
  removeManagedTokenKeys: proxy.virtualKey
    ? ["ANTHROPIC_API_KEY"]
    : [ANTHROPIC_AUTH_TOKEN_KEY, "ANTHROPIC_API_KEY"],
})}${headerAppend}${passthroughNote}`;
}

/**
 * Append-merge our headers into env.ANTHROPIC_CUSTOM_HEADERS in settings.json:
 * keep the user's other headers, replace only our lines (matched
 * case-insensitively by header name) so re-runs / key rotation never duplicate
 * or leave a stale token. Runs right after the base-URL merge created the file,
 * so it neither re-creates the dir nor re-takes the backup.
 */
function claudeCustomHeaderAppendSnippet(headerLines: string[]): string {
  const psArray = headerLines.map(psq).join(", ");
  const ownedNames = [EXTERNAL_AGENT_ID_HEADER, VIRTUAL_KEY_HEADER]
    .map((name) => psq(name.toLowerCase()))
    .join(", ");
  return `$arch_hpath = ${CLAUDE_SETTINGS_PATH}
$arch_hconfig = [pscustomobject]@{}
if (Test-Path $arch_hpath) {
  $arch_hraw = Get-Content -Raw -Path $arch_hpath
  if ($arch_hraw -and $arch_hraw.Trim()) { $arch_hconfig = $arch_hraw | ConvertFrom-Json }
}
if (-not $arch_hconfig.PSObject.Properties['env']) { $arch_hconfig | Add-Member -NotePropertyName 'env' -NotePropertyValue ([pscustomobject]@{}) }
$arch_henv = $arch_hconfig.env
$arch_hnew = @(${psArray})
$arch_hnames = @(${ownedNames})
$arch_hexisting = ''
if ($arch_henv.PSObject.Properties['${CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY}']) { $arch_hexisting = [string]$arch_henv.${CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY} }
$arch_hkept = @()
foreach ($arch_hl in ($arch_hexisting -split "\\r?\\n")) {
  if ($arch_hl.Trim() -and ($arch_hnames -notcontains ($arch_hl -split ':',2)[0].Trim().ToLower())) { $arch_hkept += $arch_hl }
}
$arch_hkept += $arch_hnew
$arch_hjoined = ($arch_hkept -join "\`n")
if ($arch_henv.PSObject.Properties['${CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY}']) { $arch_henv.${CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY} = $arch_hjoined } else { $arch_henv | Add-Member -NotePropertyName '${CLAUDE_CODE_CUSTOM_HEADERS_ENV_KEY}' -NotePropertyValue $arch_hjoined }
$arch_hconfig | ConvertTo-Json -Depth 32 | Set-Content -Path $arch_hpath -Encoding utf8
Write-Host ('Updated ' + $arch_hpath)`;
}

function claudeBedrockProxySection(proxy: SetupScriptProxySection): string {
  const values: Record<string, string> = {
    [CLAUDE_USE_BEDROCK_KEY]: "1",
    [AWS_REGION_KEY]: "us-east-1",
    [BEDROCK_BASE_URL_KEY]: proxy.url,
  };
  if (proxy.virtualKey) {
    // The virtual key authenticates against the proxy as a Bedrock bearer
    // token. Merged into settings.json env exactly like ANTHROPIC_AUTH_TOKEN
    // on the Anthropic path, so the setup needs no manual step.
    values[AWS_BEARER_TOKEN_KEY] = proxy.virtualKey;
  }
  return `Say ${psq("Routing Claude Code through the Bedrock proxy")}
${mergeJsonFileSnippet({
  pathExpr: CLAUDE_SETTINGS_PATH,
  nestedKey: "env",
  values,
  removeManagedTokenKeys: proxy.virtualKey ? [] : [AWS_BEARER_TOKEN_KEY],
})}
${claudeCustomHeaderAppendSnippet(claudeCustomHeaderLines(proxy))}
Write-Host 'Update AWS_REGION in the settings.json env block if you use a different region.'${
    proxy.virtualKey
      ? ""
      : `
Write-Host 'Your existing AWS credentials keep working — only the base URL changed.'`
  }`;
}

// ===================================================================
// Internal helpers — Codex
// ===================================================================

function codexSections(ctx: SetupScriptContext): string[] {
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
    sections.push(`Say ${psq(`Registering MCP gateway "${ctx.mcp.serverName}" (OAuth)`)}
try { codex mcp remove ${psq(ctx.mcp.serverName)} 2>$null | Out-Null } catch { }
codex mcp add ${psq(ctx.mcp.serverName)} --url ${psq(ctx.mcp.url)}
if ($LASTEXITCODE -ne 0) { throw 'Could not register the MCP gateway. Fix the error above and re-run setup.' }`);
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
  $arch_skip = $false
  $arch_in_table = $false
  foreach ($arch_line in (Get-Content -Path $arch_config)) {
    if ($arch_line -eq $arch_start) { $arch_skip = $true; continue }
    if ($arch_line -eq $arch_end) { $arch_skip = $false; continue }
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
    sections.push(`Say ${psq(`Registering the "${ctx.skills.marketplaceName}" marketplace`)}
codex plugin marketplace add ${psq(ctx.skills.cloneUrl)}
if ($LASTEXITCODE -ne 0) { Warn 'Marketplace may already be registered — run /plugins inside Codex to inspect.' }
${pluginInstalls}`);
  }

  return withWindowsStartupGuard(ctx, CODEX_GUARD_CLIENT, sections);
}

// ===================================================================
// Internal helpers — Copilot CLI
// ===================================================================

/**
 * PowerShell lines applying one env var to the current session AND persisting
 * it at User scope. `irm | iex` runs in the caller's session, so the `$env:`
 * assignment survives the script (unlike bash, where a piped script cannot
 * export into the caller's shell). [Environment]::SetEnvironmentVariable is
 * an in-process call, so unlike setx the value never appears in an argv and
 * is not subject to setx's 1024-character truncation.
 */
function psApplyUserEnv(name: string, psValueExpr: string): string {
  return `$env:${name} = ${psValueExpr}
[Environment]::SetEnvironmentVariable('${name}', ${psValueExpr}, 'User')`;
}

/** Shared success line of both Copilot provider sections. */
const PS_COPILOT_APPLIED_OK = `Ok 'Copilot provider settings applied: current session + saved to your User environment.'`;

/**
 * COPILOT_MODEL companion to the provider apply: with a BYOK provider
 * configured, the Copilot CLI refuses to launch without an explicit model
 * ("BYOK providers require an explicit model"). A model chosen in the
 * wizard's review step is the user's reviewed decision and is applied
 * outright; without one, an unset COPILOT_MODEL gets the provider's default
 * (session + User scope) and an existing value is never overwritten.
 */
function psCopilotModelApply(params: {
  chosenModel: string | null;
  defaultModel: string;
}): string {
  if (params.chosenModel) {
    return `${psApplyUserEnv(COPILOT_PROVIDER_ENV_KEYS.model, psq(params.chosenModel))}
Ok ${psq(`set ${COPILOT_PROVIDER_ENV_KEYS.model} = ${params.chosenModel} (your selection on the connection page).`)}
Write-Host 'Restart any open Copilot CLI sessions to pick this up.'`;
  }
  return `if ([string]::IsNullOrEmpty($env:${COPILOT_PROVIDER_ENV_KEYS.model})) {
  ${psApplyUserEnv(COPILOT_PROVIDER_ENV_KEYS.model, psq(params.defaultModel))}
  Ok ${psq(`set ${COPILOT_PROVIDER_ENV_KEYS.model} = ${params.defaultModel} — change it anytime ($env:${COPILOT_PROVIDER_ENV_KEYS.model}).`)}
} else {
  Write-Host ('Keeping your existing ${COPILOT_PROVIDER_ENV_KEYS.model} = ' + $env:${COPILOT_PROVIDER_ENV_KEYS.model})
}
Write-Host 'Restart any open Copilot CLI sessions to pick this up.'`;
}

function copilotSections(ctx: SetupScriptContext): string[] {
  const sections: string[] = [];

  if (ctx.mcp) {
    sections.push(`Say ${psq(`Registering MCP gateway "${ctx.mcp.serverName}" (OAuth)`)}
try { copilot mcp remove ${psq(ctx.mcp.serverName)} 2>$null | Out-Null } catch { }
copilot mcp add --transport http ${psq(ctx.mcp.serverName)} ${psq(ctx.mcp.url)}
if ($LASTEXITCODE -ne 0) { throw 'Could not register the MCP gateway. Fix the error above and re-run setup.' }
copilot mcp get ${psq(ctx.mcp.serverName)}`);
  }

  if (ctx.proxy) {
    if (ctx.proxy.provider === "github-copilot" && !ctx.proxy.virtualKey) {
      sections.push(copilotGithubLinkSection(ctx.proxy));
    } else {
      const apply = [
        psApplyUserEnv(COPILOT_PROVIDER_ENV_KEYS.type, psq("openai")),
        psApplyUserEnv(COPILOT_PROVIDER_ENV_KEYS.baseUrl, psq(ctx.proxy.url)),
        psApplyUserEnv(
          COPILOT_PROVIDER_ENV_KEYS.headers,
          psq(copilotAttributionHeadersValue(ctx.proxy)),
        ),
      ];
      if (ctx.proxy.virtualKey) {
        apply.push(
          psApplyUserEnv(
            COPILOT_PROVIDER_ENV_KEYS.apiKey,
            psq(ctx.proxy.virtualKey),
          ),
        );
      }
      sections.push(`Say ${psq(`Applying Copilot provider settings (${ctx.proxy.providerLabel} via OpenAI-compatible protocol)`)}
${apply.join("\n")}
${PS_COPILOT_APPLIED_OK}${
  ctx.proxy.virtualKey
    ? ""
    : `\nWrite-Host 'Set your own key the same way: $env:${COPILOT_PROVIDER_ENV_KEYS.apiKey} = "<your-${ctx.proxy.provider}-api-key>"'`
}
${psCopilotModelApply({
  chosenModel: ctx.proxy.model,
  defaultModel: DEFAULT_MODELS[ctx.proxy.provider],
})}`);
    }
  }

  if (ctx.skills) {
    const pluginInstalls = (ctx.skills.pluginNames ?? [])
      .map((pluginName) => {
        const ref = `${pluginName}@${ctx.skills?.marketplaceName}`;
        return `copilot plugin install ${psq(ref)}
if ($LASTEXITCODE -ne 0) { Warn ${psq(`Could not install plugin — run 'copilot plugin install ${ref}'.`)} }`;
      })
      .join("\n");
    sections.push(`Say ${psq(`Registering the "${ctx.skills.marketplaceName}" marketplace`)}
copilot plugin marketplace add ${psq(ctx.skills.cloneUrl)}
if ($LASTEXITCODE -ne 0) { Warn "Marketplace may already be registered — run 'copilot plugin marketplace browse' to inspect." }
${pluginInstalls}`);
  }

  return withWindowsStartupGuard(ctx, COPILOT_GUARD_CLIENT, sections);
}

/**
 * GitHub Copilot in passthrough mode: there is no static API key — the proxy
 * expects the user's long-lived GitHub OAuth token as the bearer. Mirrors the
 * bash device flow: reuse a token the Copilot CLI / VS Code already stored (only
 * if Copilot's token exchange accepts it), otherwise run the GitHub device flow
 * (RFC 8628). The token stays in a PowerShell variable and is passed via
 * Invoke-RestMethod headers / request bodies, never as argv to an external
 * command; it ends up applied as the COPILOT_* provider env vars (session +
 * User scope) without ever being echoed to the console.
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

  return `Say 'Linking your GitHub Copilot subscription'
$ArchGhcpToken = ''

# Probe the Copilot token exchange: succeeds only for a valid GitHub token on
# an account with an active Copilot seat. Token is sent in a request header
# (in-process), never as argv.
function Test-ArchGhcp($arch_tok) {
  if ([string]::IsNullOrEmpty($arch_tok)) { return $false }
  try {
    Invoke-RestMethod -Method Get -Uri ${psq(gh.tokenExchangeUrl)} -TimeoutSec 30 -Headers @{
      'authorization' = ('token ' + $arch_tok)
      'accept' = 'application/json'
      'editor-version' = 'vscode/1.99.0'
      'copilot-integration-id' = 'vscode-chat'
    } -ErrorAction Stop | Out-Null
    return $true
  } catch {
    return $false
  }
}

# 1. Reuse a GitHub token already stored by the Copilot CLI / VS Code.
$arch_ghcp_paths = @(
  (Join-Path $env:USERPROFILE '.config\\github-copilot\\apps.json'),
  (Join-Path $env:USERPROFILE '.config\\github-copilot\\hosts.json')
)
if ($env:LOCALAPPDATA) {
  $arch_ghcp_paths += (Join-Path $env:LOCALAPPDATA 'github-copilot\\apps.json')
  $arch_ghcp_paths += (Join-Path $env:LOCALAPPDATA 'github-copilot\\hosts.json')
}
$arch_ghcp_candidates = @()
foreach ($arch_p in $arch_ghcp_paths) {
  if (Test-Path $arch_p) {
    try {
      $arch_data = Get-Content -Raw -Path $arch_p | ConvertFrom-Json
      foreach ($arch_prop in $arch_data.PSObject.Properties) {
        $arch_v = $arch_prop.Value
        if ($arch_v -and $arch_v.PSObject.Properties['oauth_token']) {
          $arch_t = $arch_v.oauth_token
          if ($arch_t -and ($arch_ghcp_candidates -notcontains $arch_t)) { $arch_ghcp_candidates += $arch_t }
        }
      }
    } catch { }
  }
}
foreach ($arch_cand in $arch_ghcp_candidates) {
  if (Test-ArchGhcp $arch_cand) {
    $ArchGhcpToken = $arch_cand
    Write-Host 'Re-using the GitHub token stored by the Copilot CLI on this machine.'
    break
  }
}

# 2. No usable stored token: run the GitHub device flow (RFC 8628).
if ([string]::IsNullOrEmpty($ArchGhcpToken)) {
  try {
    $arch_device = Invoke-RestMethod -Method Post -Uri ${psq(deviceCodeUrl)} -TimeoutSec 30 -Headers @{ 'accept' = 'application/json' } -ContentType 'application/json' -Body ${psq(deviceRequestBody)}
  } catch {
    Err 'could not reach GitHub to start the device flow.'
    exit 1
  }
  $arch_device_code = $arch_device.device_code
  $arch_user_code = $arch_device.user_code
  $arch_verification_uri = $arch_device.verification_uri
  $arch_interval = 5
  if ($arch_device.interval) { $arch_interval = [int]$arch_device.interval }
  $arch_expires_in = 900
  if ($arch_device.expires_in) { $arch_expires_in = [int]$arch_device.expires_in }
  if ([string]::IsNullOrEmpty($arch_device_code)) {
    Err 'GitHub did not return a device code.'
    exit 1
  }
  $arch_deadline = (Get-Date).AddSeconds($arch_expires_in)
  Write-Host ''
  Write-Host ('  Open:        ' + $arch_verification_uri)
  Write-Host ('  Enter code:  ' + $arch_user_code)
  Write-Host ''
  Write-Host 'Waiting for you to authorize in the browser...'
  while ([string]::IsNullOrEmpty($ArchGhcpToken)) {
    if ((Get-Date) -ge $arch_deadline) {
      Err 'timed out waiting for GitHub authorization — re-run this command to try again.'
      exit 1
    }
    Start-Sleep -Seconds $arch_interval
    $arch_poll_body = (@{ client_id = ${psq(gh.clientId)}; device_code = $arch_device_code; grant_type = 'urn:ietf:params:oauth:grant-type:device_code' } | ConvertTo-Json -Compress)
    try {
      $arch_poll = Invoke-RestMethod -Method Post -Uri ${psq(accessTokenUrl)} -TimeoutSec 30 -Headers @{ 'accept' = 'application/json' } -ContentType 'application/json' -Body $arch_poll_body
    } catch {
      continue
    }
    if ($arch_poll.access_token) {
      $ArchGhcpToken = $arch_poll.access_token
      break
    }
    $arch_err = ''
    if ($arch_poll.PSObject.Properties['error']) { $arch_err = [string]$arch_poll.error }
    switch ($arch_err) {
      'authorization_pending' { }
      '' { }
      'slow_down' { $arch_interval = $arch_interval + 5 }
      default {
        Err ('GitHub sign-in failed: ' + $arch_err)
        exit 1
      }
    }
  }
  Ok 'GitHub account linked.'
  if (-not (Test-ArchGhcp $ArchGhcpToken)) {
    Err 'this GitHub account does not appear to have an active Copilot subscription.'
    exit 1
  }
}

Say 'Applying Copilot provider settings (GitHub Copilot via OpenAI-compatible protocol)'
${psApplyUserEnv(COPILOT_PROVIDER_ENV_KEYS.type, psq("openai"))}
${psApplyUserEnv(COPILOT_PROVIDER_ENV_KEYS.baseUrl, psq(proxy.url))}
${psApplyUserEnv(COPILOT_PROVIDER_ENV_KEYS.headers, psq(copilotAttributionHeadersValue(proxy)))}
if (-not [string]::IsNullOrEmpty($ArchGhcpToken)) {
  ${psApplyUserEnv(COPILOT_PROVIDER_ENV_KEYS.apiKey, "$ArchGhcpToken")}
  ${PS_COPILOT_APPLIED_OK}
} else {
  Write-Host 'No GitHub token was linked — set your own key the same way: $env:${COPILOT_PROVIDER_ENV_KEYS.apiKey} = "<your-github-oauth-token>"'
}
${psCopilotModelApply({
  chosenModel: proxy.model,
  defaultModel: DEFAULT_MODELS["github-copilot"],
})}`;
}

// ===================================================================
// Internal helpers — Cursor
// ===================================================================

function cursorSections(ctx: SetupScriptContext): string[] {
  const sections: string[] = [];

  if (ctx.mcp && ctx.runtimeHandoffInstructions) {
    sections.push(`Say ${psq("Runtime handoff instructions — copy into Cursor User Rules")}
Write-Host ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(ctx.runtimeHandoffInstructions).toString("base64")}')))`);
  }

  if (ctx.mcp) {
    sections.push(`Say ${psq(`Adding MCP gateway "${ctx.mcp.serverName}" to ~/.cursor/mcp.json (OAuth)`)}
$arch_path = Join-Path $env:USERPROFILE '.cursor\\mcp.json'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $arch_path) | Out-Null
if ((Test-Path $arch_path) -and -not (Test-Path ($arch_path + '.archestra-backup'))) {
  Copy-Item -Path $arch_path -Destination ($arch_path + '.archestra-backup')
}
$arch_config = [pscustomobject]@{}
if (Test-Path $arch_path) {
  $arch_raw = Get-Content -Raw -Path $arch_path
  if ($arch_raw -and $arch_raw.Trim()) { $arch_config = $arch_raw | ConvertFrom-Json }
}
if (-not $arch_config.PSObject.Properties['mcpServers']) { $arch_config | Add-Member -NotePropertyName 'mcpServers' -NotePropertyValue ([pscustomobject]@{}) }
$arch_servers = $arch_config.mcpServers
$arch_server_name = ${psq(ctx.mcp.serverName)}
$arch_entry = [pscustomobject]@{ url = ${psq(ctx.mcp.url)} }
if ($arch_servers.PSObject.Properties[$arch_server_name]) { $arch_servers.$arch_server_name = $arch_entry } else { $arch_servers | Add-Member -NotePropertyName $arch_server_name -NotePropertyValue $arch_entry }
$arch_config | ConvertTo-Json -Depth 32 | Set-Content -Path $arch_path -Encoding utf8
Write-Host ('Updated ' + $arch_path)`);
  }

  if (ctx.proxy) {
    sections.push(`Say ${psq("Cursor model settings (manual step)")}
Write-Host @'

In Cursor: Settings -> Models -> API Keys -> OpenAI API Key
  1. Turn on "Override OpenAI Base URL" and paste: ${ctx.proxy.url}
  2. ${
    ctx.proxy.virtualKey
      ? `Paste this key into the API Key field and click Verify:
     ${ctx.proxy.virtualKey}`
      : `Paste your own ${ctx.proxy.providerLabel} API key into the API Key field and click Verify.`
  }
'@`);
  }

  if (ctx.skills) {
    const pluginNames = ctx.skills.pluginNames ?? [];
    sections.push(`Say ${psq(`${describeMarketplaceContents(ctx.skills).label} (manual step)`)}
Write-Host @'

In Cursor's command palette run /add-plugin and paste:
  ${ctx.skills.cloneUrl}
${
  pluginNames.length > 0
    ? `
Then install these plugins from Customize -> Plugins:
  ${pluginNames.join("\n  ")}`
    : ""
}
'@`);
  }

  return sections;
}

// ===================================================================
// Internal helpers — OpenCode (spike)
// ===================================================================

/**
 * PowerShell twin of the bash OpenCode sections: the same owned
 * ~/.config/opencode/opencode.json, written BOM-free (Windows PowerShell 5.1's
 * `Set-Content -Encoding utf8` adds a BOM), the same key file and skills clone.
 */
function opencodeWindowsProviderMerge(params: {
  providerId: string;
  baseUrl: string;
  headers: Record<string, string>;
  apiKeyRef?: string;
  customEntry?: string;
}): string {
  const headerLines = Object.entries(params.headers)
    .map(
      ([key, value]) => `Set-ArchProp $archHeaders ${psq(key)} ${psq(value)}`,
    )
    .join("\n");
  return `$archEntryProperty = $archCfg.provider.PSObject.Properties[${psq(params.providerId)}]
$archEntry = if ($archEntryProperty) { $archEntryProperty.Value } else { [pscustomobject]@{} }
$archOptionsProperty = $archEntry.PSObject.Properties['options']
$archOptions = if ($archOptionsProperty) { $archOptionsProperty.Value } else { [pscustomobject]@{} }
$archHeadersProperty = $archOptions.PSObject.Properties['headers']
$archHeaders = if ($archHeadersProperty) { $archHeadersProperty.Value } else { [pscustomobject]@{} }
${headerLines}
Set-ArchProp $archOptions 'baseURL' ${psq(params.baseUrl)}
Set-ArchProp $archOptions 'headers' $archHeaders
${params.apiKeyRef ? `Set-ArchProp $archOptions 'apiKey' ${psq(params.apiKeyRef)}` : ""}
${params.customEntry ?? ""}
Set-ArchProp $archEntry 'options' $archOptions
Set-ArchProp $archCfg.provider ${psq(params.providerId)} $archEntry`;
}

function opencodeWindowsRoutingPluginSection(params: {
  routes: Record<string, string>;
  headers: Record<string, string>;
}): string {
  const encoded = Buffer.from(
    renderOpenCodeRoutingPlugin(params),
    "utf8",
  ).toString("base64");
  return `$archPluginDir = Join-Path $archOcDir 'plugins'
$archPluginFile = Join-Path $archPluginDir 'archestra-llm-proxy.js'
$archPluginState = Join-Path $env:USERPROFILE '.archestra/opencode-routing-plugin-state.json'
$null = New-Item -ItemType Directory -Force -Path $archPluginDir
if (-not (Test-Path $archPluginState)) {
  $archExistingPlugin = Test-Path $archPluginFile
  $archPluginBackup = if ($archExistingPlugin) { [Convert]::ToBase64String([IO.File]::ReadAllBytes($archPluginFile)) } else { $null }
  $archPluginStateValue = [pscustomobject]@{ existed = $archExistingPlugin; contentBase64 = $archPluginBackup }
  $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $archPluginState)
  [IO.File]::WriteAllText($archPluginState, ($archPluginStateValue | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding $false))
}
[IO.File]::WriteAllBytes($archPluginFile, [Convert]::FromBase64String(${psq(encoded)}))
Ok 'Installed the OpenCode LLM proxy routing guard'`;
}

function opencodeSections(ctx: SetupScriptContext): string[] {
  const sections: string[] = [
    `$archOcDir = if ($env:XDG_CONFIG_HOME) { Join-Path $env:XDG_CONFIG_HOME 'opencode' } else { Join-Path $env:USERPROFILE '.config/opencode' }
$archOcFile = Join-Path $archOcDir 'opencode.json'
function Read-ArchOcOwned {
  if (Test-Path $archOcFile) {
    $raw = Get-Content -Raw -Path $archOcFile
    if ($raw -and $raw.Trim()) { return ($raw | ConvertFrom-Json) }
  }
  return [pscustomobject]@{ '$schema' = 'https://opencode.ai/config.json' }
}
function Write-ArchOcOwned($cfg) {
  $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $archOcFile)
  $archBackup = $archOcFile + '.archestra-backup'
  if ((Test-Path $archOcFile) -and -not (Test-Path $archBackup)) { Copy-Item -Path $archOcFile -Destination $archBackup }
  [IO.File]::WriteAllText($archOcFile, ($cfg | ConvertTo-Json -Depth 32), (New-Object System.Text.UTF8Encoding $false))
  Write-Host ('Updated ' + $archOcFile)
}
function Set-ArchProp($obj, $name, $value) {
  if ($obj.PSObject.Properties[$name]) { $obj.$name = $value } else { $obj | Add-Member -NotePropertyName $name -NotePropertyValue $value }
}
function Enable-ArchOcProviders($cfg, [string[]]$providerIds) {
  $archStateFile = Join-Path $env:USERPROFILE '.archestra/opencode-connection-state.json'
  if (-not (Test-Path $archStateFile)) {
    $enabled = $cfg.PSObject.Properties['enabled_providers']
    $disabled = $cfg.PSObject.Properties['disabled_providers']
    $providerState = [pscustomobject]@{}
    foreach ($providerId in $providerIds) {
      $providerEntry = if ($cfg.PSObject.Properties['provider']) { $cfg.provider.PSObject.Properties[$providerId] } else { $null }
      $providerState | Add-Member -NotePropertyName $providerId -NotePropertyValue $(if ($providerEntry) { $providerEntry.Value } else { $null })
    }
    $state = [pscustomobject]@{
      enabledProvidersPresent = [bool]$enabled
      enabledProviders = if ($enabled) { @($enabled.Value) } else { $null }
      disabledProvidersPresent = [bool]$disabled
      disabledProviders = if ($disabled) { @($disabled.Value) } else { $null }
      providerState = $providerState
    }
    $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $archStateFile)
    [IO.File]::WriteAllText($archStateFile, ($state | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding $false))
  }
  Set-ArchProp $cfg 'enabled_providers' @($providerIds)
  $disabled = $cfg.PSObject.Properties['disabled_providers']
  if ($disabled) {
    $remaining = @($disabled.Value | Where-Object { $_ -notin $providerIds })
    if ($remaining.Count -gt 0) { Set-ArchProp $cfg 'disabled_providers' $remaining }
    else { $cfg.PSObject.Properties.Remove('disabled_providers') }
  }
}`,
  ];

  if (ctx.mcp) {
    sections.push(`Say ${psq(`Registering MCP gateway "${ctx.mcp.serverName}" (OAuth)`)}
$archCfg = Read-ArchOcOwned
if (-not $archCfg.PSObject.Properties['mcp']) { Set-ArchProp $archCfg 'mcp' ([pscustomobject]@{}) }
Set-ArchProp $archCfg.mcp ${psq(ctx.mcp.serverName)} ([pscustomobject]@{ type = 'remote'; url = ${psq(ctx.mcp.url)} })
Write-ArchOcOwned $archCfg`);
  }

  if (ctx.proxy) {
    if (ctx.proxy.authMode === "provider-key") {
      const headers = opencodeProxyHeaders(ctx.proxy);
      const legacyTarget = opencodeProviderTarget(ctx);
      const routes = Object.fromEntries(
        OPENCODE_PASSTHROUGH_PROVIDER_ROUTES.map((route) => [
          route.openCodeProviderId,
          openCodePassthroughBaseUrl(ctx.proxy?.baseUrl ?? "", route),
        ]),
      );
      const cleanup = OPENCODE_PASSTHROUGH_PROVIDER_ROUTES.map((route) => {
        const providerId = psq(route.openCodeProviderId);
        const expected = psq(
          openCodePassthroughBaseUrl(ctx.proxy?.baseUrl ?? "", route),
        );
        const managedHeaders = Object.entries(headers)
          .map(
            ([name, value]) =>
              `      if ($archHeaders.PSObject.Properties[${psq(name)}] -and $archHeaders.${psq(name)} -eq ${psq(value)}) { $archHeaders.PSObject.Properties.Remove(${psq(name)}) }`,
          )
          .join("\n");
        return `$archEntryProp = $archCfg.provider.PSObject.Properties[${providerId}]
  if ($archEntryProp -and $archEntryProp.Value.PSObject.Properties['options']) {
    $archOptions = $archEntryProp.Value.options
    if ($archOptions.PSObject.Properties['baseURL'] -and $archOptions.baseURL -eq ${expected}) { $archOptions.PSObject.Properties.Remove('baseURL') }
    $archHeadersProp = $archOptions.PSObject.Properties['headers']
    if ($archHeadersProp) {
      $archHeaders = $archHeadersProp.Value
${managedHeaders}
      if (@($archHeaders.PSObject.Properties).Count -eq 0) { $archOptions.PSObject.Properties.Remove('headers') }
    }
    if (@($archOptions.PSObject.Properties).Count -eq 0) { $archEntryProp.Value.PSObject.Properties.Remove('options') }
    if (@($archEntryProp.Value.PSObject.Properties).Count -eq 0) { $archCfg.provider.PSObject.Properties.Remove(${providerId}) }
  }`;
      }).join("\n");
      sections.push(`Say 'Routing supported OpenCode providers through the LLM proxy'
${opencodeWindowsRoutingPluginSection({ routes, headers })}
$archCfg = Read-ArchOcOwned
if (-not $archCfg.PSObject.Properties['provider']) { Set-ArchProp $archCfg 'provider' ([pscustomobject]@{}) }
if ($archCfg.PSObject.Properties['model'] -and $archCfg.model -eq ${psq(`${legacyTarget.id}/${legacyTarget.model}`)}) { $archCfg.PSObject.Properties.Remove('model') }
$archStateFile = Join-Path $env:USERPROFILE '.archestra/opencode-connection-state.json'
if (Test-Path $archStateFile) {
  $archState = Get-Content -Raw -Path $archStateFile | ConvertFrom-Json
  if ($archState.PSObject.Properties['providerState']) {
    foreach ($archSavedProvider in $archState.providerState.PSObject.Properties) {
      if ($null -ne $archSavedProvider.Value) { Set-ArchProp $archCfg.provider $archSavedProvider.Name $archSavedProvider.Value }
      else { $archCfg.provider.PSObject.Properties.Remove($archSavedProvider.Name) }
    }
  }
  if ($archState.enabledProvidersPresent) { Set-ArchProp $archCfg 'enabled_providers' @($archState.enabledProviders) }
  else { $archCfg.PSObject.Properties.Remove('enabled_providers') }
  if ($archState.disabledProvidersPresent) { Set-ArchProp $archCfg 'disabled_providers' @($archState.disabledProviders) }
  else { $archCfg.PSObject.Properties.Remove('disabled_providers') }
  Remove-Item -Force $archStateFile
} else {
${cleanup}
}
if (@($archCfg.provider.PSObject.Properties).Count -eq 0) { $archCfg.PSObject.Properties.Remove('provider') }
Write-ArchOcOwned $archCfg
Ok "OpenCode's credentialed native providers will resolve through the LLM proxy"`);
    } else {
      const target = opencodeProviderTarget(ctx);
      const apiKeyRef = ctx.proxy.virtualKey
        ? `{file:~/.archestra/opencode-${target.id}.key}`
        : "";
      const writeKey = ctx.proxy.virtualKey
        ? `
$ARCHESTRA_VIRTUAL_KEY = ${psq(ctx.proxy.virtualKey)}
$archKeyPath = Join-Path $env:USERPROFILE ${psq(`.archestra/opencode-${target.id}.key`)}
$null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $archKeyPath)
[IO.File]::WriteAllText($archKeyPath, $ARCHESTRA_VIRTUAL_KEY, (New-Object System.Text.UTF8Encoding $false))
Write-Host ('Stored the virtual key in ' + $archKeyPath)`
        : "";
      sections.push(`Say ${psq(`Routing OpenCode's "${target.id}" provider through the LLM proxy`)}${writeKey}
${opencodeWindowsRoutingPluginSection({
  routes: { [target.id]: target.baseUrl },
  headers: opencodeProxyHeaders(ctx.proxy),
})}
$archCfg = Read-ArchOcOwned
if (-not $archCfg.PSObject.Properties['provider']) { Set-ArchProp $archCfg 'provider' ([pscustomobject]@{}) }
Enable-ArchOcProviders $archCfg @(${psq(target.id)})
${opencodeWindowsProviderMerge({
  providerId: target.id,
  baseUrl: target.baseUrl,
  headers: opencodeProxyHeaders(ctx.proxy),
  apiKeyRef,
})}
Write-ArchOcOwned $archCfg
$archEffective = $null
try {
  Push-Location $env:USERPROFILE
  $archResolved = (& opencode debug config 2>$null | Out-String) | ConvertFrom-Json
  $archEffective = $archResolved.provider.${psq(target.id)}.options.baseURL
} catch { } finally { Pop-Location }
if ($archEffective -eq ${psq(target.baseUrl)}) { Ok ${psq(`OpenCode resolves "${target.id}" through the LLM proxy`)} }
else { Warn ('Another OpenCode config overrides provider.${target.id}.options.baseURL (resolved: ' + $archEffective + '). Remove that override to use the proxy.') }`);
    }
  }

  if (ctx.skills) {
    sections.push(`Say ${psq(`Installing the "${ctx.skills.marketplaceName}" skills`)}
$archSkillsDir = Join-Path $archOcDir ${psq(`skills/${ctx.skills.marketplaceName}`)}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Warn ('git not found — clone the marketplace into ' + $archSkillsDir + ' yourself.') }
elseif (Test-Path (Join-Path $archSkillsDir '.git')) {
  try { & git -C $archSkillsDir remote set-url origin ${psq(ctx.skills.cloneUrl)} 2>$null; & git -C $archSkillsDir pull --ff-only -q 2>$null } catch { }
  if ($LASTEXITCODE -ne 0) { Warn ('Could not update ' + $archSkillsDir) }
} else {
  $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $archSkillsDir)
  try { & git clone -q ${psq(ctx.skills.cloneUrl)} $archSkillsDir 2>$null } catch { }
  if ($LASTEXITCODE -ne 0) { Warn ('Could not clone the marketplace into ' + $archSkillsDir) }
}
Write-Host ('Skills folder: ' + $archSkillsDir)`);
  }

  if (ctx.mcp) {
    sections.push(`Say 'OpenCode MCP servers'
try { & opencode mcp list 2>$null | Out-Host } catch { }`);
  }
  return withWindowsStartupGuard(ctx, OPENCODE_GUARD_CLIENT, sections);
}
