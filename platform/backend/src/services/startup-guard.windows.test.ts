import {
  CLAUDE_CODE_PROXY_ENV_KEYS,
  STARTUP_GUARD_INSTALL,
} from "@archestra/shared";
import { describe, expect, test } from "vitest";
import type {
  StartupGuardClient,
  StartupGuardContext,
} from "@/services/startup-guard";
import {
  CLAUDE_CODE_GUARD_CLIENT,
  CODEX_GUARD_CLIENT,
  COPILOT_GUARD_CLIENT,
} from "@/services/startup-guard.clients";
import {
  buildWindowsStartupGuardInstallSection,
  buildWindowsStartupGuardUnshadowSection,
  renderStartupGuardPowerShell,
} from "@/services/startup-guard.windows";

const {
  psScriptRelpath: CLAUDE_CODE_GUARD_PS_SCRIPT_RELPATH,
  skipRelpath: CLAUDE_CODE_GUARD_SKIP_RELPATH,
  markerStart: CLAUDE_CODE_GUARD_MARKER_START,
  markerEnd: CLAUDE_CODE_GUARD_MARKER_END,
} = STARTUP_GUARD_INSTALL["claude-code"];

/**
 * Structure pins for the PowerShell guard. No PowerShell runtime exists in CI,
 * so unlike the bash suite there is no syntax/behavioral pass — the contract
 * is pinned on the rendered text, mirroring the bash assertions.
 */

const CTX: StartupGuardContext = {
  appName: "Archestra",
  healthUrl:
    "https://archestra.example.com/v1/health?mcp=prod-gateway&llm=profile-123",
  proxy: {
    provider: "anthropic",
    providerLabel: "Anthropic",
    url: "https://archestra.example.com/v1/anthropic/profile-123",
    ref: "profile-123",
    proxyName: "default_proxy",
  },
  mcp: {
    serverName: "prod_gateway",
    url: "https://archestra.example.com/v1/mcp/prod-gateway",
    ref: "prod-gateway",
  },
  skills: {
    marketplaceName: "acme-skills",
    cloneUrl:
      "https://archestra.example.com/skill-marketplace/archestra_skl_token123/repo.git",
  },
};

describe("renderStartupGuardPowerShell (Claude Code)", () => {
  test("shows the remotes in pre-loader order with the demo visuals", () => {
    const script = renderStartupGuardPowerShell(CTX, CLAUDE_CODE_GUARD_CLIENT);
    const proxyAt = script.indexOf("LLM proxy (Anthropic)");
    const mcpAt = script.indexOf("MCP gateway (prod_gateway)");
    const skillsAt = script.indexOf("Skills marketplace (acme-skills)");
    expect(proxyAt).toBeGreaterThan(-1);
    expect(mcpAt).toBeGreaterThan(proxyAt);
    expect(skillsAt).toBeGreaterThan(mcpAt);
  });

  test("makes ONE health request for the launch; skills has no per-resource marker", () => {
    const script = renderStartupGuardPowerShell(CTX, CLAUDE_CODE_GUARD_CLIENT);
    expect(script).toContain(`$HealthUrl = '${CTX.healthUrl}'`);
    expect(script).toContain(`DownMarker = '"mcp":"down"'`);
    expect(script).toContain(`DownMarker = '"llm":"down"'`);
    expect(script).toContain("DownMarker = ''");
    expect(script).toContain("Wait-ArchHealth");
    expect(script).toContain("-TimeoutSec 3");
    // whitespace is normalized with the regex metaclass \s, not the literal
    // letter 's' — so down markers still match a pretty-printed JSON body
    expect(script).toContain("-replace '\\s', ''");
    expect(script).not.toContain("-replace 's', ''");
    // Invoke-WebRequest's progress banner paints over the header rows —
    // silencing it is what keeps the logo from flickering on every fetch
    expect(script).toContain("$ProgressPreference = 'SilentlyContinue'");
    // reachable-but-erroring servers still count as answered on both editions
    expect(script).toContain(
      "$_.Exception.PSObject.Properties['Response'] -and $_.Exception.Response",
    );
  });

  test("every down remote gets the failure copy; ONE prompt then covers them all", () => {
    const script = renderStartupGuardPowerShell(CTX, CLAUDE_CODE_GUARD_CLIENT);
    expect(script).toContain("'✗ Failed to connect to ' + $r.FailName");
    expect(script).toContain("FailName = 'LLM proxy (profile-123)'");
    expect(script).toContain("FailName = 'MCP gateway (prod-gateway)'");
    expect(script).toContain("FailName = 'Skills marketplace (acme-skills)'");
    // a single down remote gets the classic Y/n removal prompt naming it…
    expect(script).toContain(
      "'Disconnect ' + $downRemotes[0].FailName + ' from Claude now? (Y/n) '",
    );
    // …several down remotes get the remove-all-at-once variant
    expect(script).toContain(
      "'Disconnect all ' + $downRemotes.Count + ' unreachable resources from Claude now? (Y/n) '",
    );
    // Enter accepts the (Y/n) default: remove
    expect(script).toContain("$k.Key -eq 'Enter'");
    expect(script).toContain("Show-ArchDownSummaryPrompt $DownRemotes");
  });

  test("always offers a reconfigure entry under the rows; the down prompt routes [C] into the same menu", () => {
    const script = renderStartupGuardPowerShell(CTX, CLAUDE_CODE_GUARD_CLIENT);
    // the persistent [C] entry, shown on every launch, with a ~1.5s window
    // for it on the healthy pass
    expect(script).toContain("function Show-ArchReconfigureOffer");
    expect(script).toContain("function Show-ArchReconfigureHint");
    expect(script).toContain(
      "To reconfigure your ' + $AppName + ' connection press [C]",
    );
    expect(script).toContain("AddMilliseconds(1500)");
    expect(script).toContain("Show-ArchReconfigureOffer");
    // on VT the hint is drawn before the probe loop, so it shows the whole run
    expect(script).toContain(
      "Show-ArchReconfigureHint\n  Write-Host -NoNewline (\"$Esc[\" + $ActiveRemotes.Count + 'A')",
    );
    // the down prompt offers the same menu as an alternative to (Y/n)
    expect(script).toContain(
      "or press [C] to reconfigure your ' + $AppName + ' connection",
    );
    expect(script).toContain("$k.KeyChar -eq 'c' -or $k.KeyChar -eq 'C'");
    // the menu numbers every remote and disconnects the chosen one in place
    expect(script).toContain("function Invoke-ArchReconfigureMenu");
    expect(script).toContain(
      "' to disconnect a resource from Claude · [Esc] Done'",
    );
    expect(script).toContain("Disconnect-ArchMenuRow");
    // the disconnect actions are shared between the down prompt and the menu
    expect(script).toContain("function Invoke-ArchDisconnectActions");
  });

  test("remembers disconnected remotes in the skip file and uninstalls itself once nothing is left", () => {
    const script = renderStartupGuardPowerShell(CTX, CLAUDE_CODE_GUARD_CLIENT);
    expect(script).toContain(`'${CLAUDE_CODE_GUARD_SKIP_RELPATH}'`);
    // disconnected remotes are recorded and filtered out of later launches
    expect(script).toContain("Add-ArchDisconnected $r.Kind");
    expect(script).toContain(
      "$Remotes | Where-Object { $DisconnectedKinds -notcontains $_.Kind }",
    );
    // full self-uninstall: script, skip file, and the profile wrapper blocks
    expect(script).toContain("function Remove-ArchGuard");
    expect(script).toContain(
      "Remove-Item -Force -ErrorAction SilentlyContinue $GuardPath, $SkipFile",
    );
    expect(script).toContain(`'${CLAUDE_CODE_GUARD_MARKER_START}'`);
    expect(script).toContain(
      "if ($ActiveRemotes.Count -eq 0) { Remove-ArchGuard; exit 0 }",
    );
    // the self-removal is silent — no trailing explainer after the
    // Disconnected rows
    expect(script).not.toContain("Nothing connected is left to check");
  });

  test("encodes the retry contract on the single request: 15s budget, notice at 3s, hang-tight at 10s, own-line (Y/n) offer", () => {
    const script = renderStartupGuardPowerShell(CTX, CLAUDE_CODE_GUARD_CLIENT);
    expect(script).toContain("$RetryTotalSeconds = 15");
    expect(script).toContain("$NoticeAfterSeconds = 3");
    expect(script).toContain("$HangTightAfterSeconds = 10");
    expect(script).toContain("few more seconds, hang tight...");
    expect(script).toContain("trying to connect...");
    // the disconnect offer sits on its own line below the row (after a
    // blank line), drawn via cursor save/restore so the dots keep
    // appending to the row above it
    expect(script).toContain("function Show-ArchWaitPrompt");
    expect(script).toContain(
      "'Disconnect all ' + $ActiveRemotes.Count + ' unreachable resources from Claude now? (Y/n) '",
    );
    expect(script).toContain("[Math]::Min($delay * 2, 4)");
    expect(script).toContain("Get-Random -Minimum 0 -Maximum 2");
  });

  test("paces every check with ~0.75s of appended dots, on the alternate screen", () => {
    const script = renderStartupGuardPowerShell(CTX, CLAUDE_CODE_GUARD_CLIENT);
    // ~0.75s per row, one appended dot per ~250ms tick — append-only output
    // cannot flicker (glyph spinners strobed on Windows Terminal)
    expect(script).toContain("$MinCheckFrames = 3");
    expect(script).toContain("$FrameSleepMs = 250");
    expect(script).toContain("function Show-ArchSpinTick");
    // every row is visible from the start — pending rows dim below the
    // probing one, two leading spaces reserving the glyph column so text
    // aligns across pending, probing, and probed rows
    expect(script).toContain(
      "foreach ($r in $ActiveRemotes) { Write-Arch ('  ' + $r.Label) DarkGray }",
    );
    expect(script).toContain("Write-Host -NoNewline ('  ' + $text)");
    // colors go out as raw VT codes — console-API colors die on the
    // alternate screen buffer under conpty; checks are the brand purple
    expect(script).toContain("Magenta = '95'");
    // alternate screen in/out — the terminal stays clean after claude exits
    expect(script).toContain("[?1049h");
    expect(script).toContain("[?1049l");
    expect(script).toContain("function Exit-ArchGuard");
  });

  test("renders the Archestra mark for the default brand and its own variants, plain title when genuinely white-labeled", () => {
    const branded = renderStartupGuardPowerShell(CTX, CLAUDE_CODE_GUARD_CLIENT);
    expect(branded).toContain("▟██▙");
    expect(branded).toContain("Secure access to your AI tools");

    // an org named "Archestra Staging" is still Archestra's own brand — the
    // mark must not disappear just because the name isn't an exact match
    const variant = renderStartupGuardPowerShell(
      {
        ...CTX,
        appName: "Archestra Staging",
      },
      CLAUDE_CODE_GUARD_CLIENT,
    );
    expect(variant).toContain("▟██▙");
    expect(variant).toContain("'Archestra Staging'");

    const whiteLabel = renderStartupGuardPowerShell(
      {
        ...CTX,
        appName: "Acme AI",
      },
      CLAUDE_CODE_GUARD_CLIENT,
    );
    expect(whiteLabel).not.toContain("▟██▙");
    expect(whiteLabel).toContain("'Acme AI'");
  });

  test("never blocks: opt-out env var, non-interactive stderr warnings with the failure copy, exit 0", () => {
    const script = renderStartupGuardPowerShell(CTX, CLAUDE_CODE_GUARD_CLIENT);
    expect(script).toContain("ARCHESTRA_CLAUDE_GUARD");
    expect(script).toContain("[Console]::IsInputRedirected");
    expect(script).toContain("[Console]::Error.WriteLine");
    expect(script).toContain("'-p' -or $a -eq '--print'");
    expect(script).toContain(
      "'archestra: failed to connect to ' + $r.FailName",
    );
    // every interactive path funnels through Exit-ArchGuard (dwell + restore)
    expect(script.trimEnd().endsWith("Exit-ArchGuard")).toBe(true);
  });

  test("disconnect actions mirror connect and dodge the wrapper function", () => {
    const script = renderStartupGuardPowerShell(CTX, CLAUDE_CODE_GUARD_CLIENT);
    expect(script).toContain(
      "Get-Command -Name claude -CommandType Application",
    );
    expect(script).toContain("mcp remove --scope user $McpServerName");
    expect(script).toContain("mcp remove --scope local $McpServerName");
    expect(script).toContain(
      "plugin marketplace remove $SkillsMarketplaceName",
    );
    for (const key of CLAUDE_CODE_PROXY_ENV_KEYS.anthropic) {
      expect(script).toContain(`'${key}'`);
    }
    expect(script).toContain("'x-archestra-agent-id'");
    expect(script).toContain("'x-archestra-virtual-key'");
    expect(script).toContain(".archestra-guard-backup");
  });

  test("bedrock variant strips the bedrock env keys and flags the env token", () => {
    const script = renderStartupGuardPowerShell(
      {
        ...CTX,
        proxy: {
          provider: "bedrock",
          providerLabel: "AWS Bedrock",
          url: "https://archestra.example.com/v1/bedrock/profile-123",
          ref: "profile-123",
          proxyName: "default_proxy",
        },
      },
      CLAUDE_CODE_GUARD_CLIENT,
    );
    for (const key of CLAUDE_CODE_PROXY_ENV_KEYS.bedrock) {
      expect(script).toContain(`'${key}'`);
    }
    expect(script).toContain("AWS_BEARER_TOKEN_BEDROCK");
  });

  test("omitted sections render no row or disconnect machinery for them", () => {
    const script = renderStartupGuardPowerShell(
      {
        ...CTX,
        healthUrl: "https://archestra.example.com/v1/health?mcp=prod-gateway",
        skills: null,
        proxy: null,
      },
      CLAUDE_CODE_GUARD_CLIENT,
    );
    expect(script).not.toContain("Skills marketplace");
    expect(script).not.toContain("LLM proxy");
    expect(script).not.toContain("marketplace remove");
    expect(script).not.toContain("Disconnect-ArchProxy");
    expect(script).toContain("MCP gateway (prod_gateway)");
  });

  test("no line opens or closes a single-quoted here-string (the installer embeds the body in one)", () => {
    const script = renderStartupGuardPowerShell(CTX, CLAUDE_CODE_GUARD_CLIENT);
    for (const line of script.split("\n")) {
      expect(line.startsWith("'@")).toBe(false);
      expect(line.trimEnd().endsWith("@'")).toBe(false);
    }
  });
});

describe("buildWindowsStartupGuardInstallSection (Claude Code)", () => {
  test("writes the guard as BOM'd UTF-8 and hooks every PowerShell edition's profile idempotently", () => {
    const section = buildWindowsStartupGuardInstallSection(
      CTX,
      CLAUDE_CODE_GUARD_CLIENT,
    );
    expect(section).toContain(`'${CLAUDE_CODE_GUARD_PS_SCRIPT_RELPATH}'`);
    expect(section).toContain("New-Object System.Text.UTF8Encoding $true");
    expect(section).toContain(CLAUDE_CODE_GUARD_MARKER_START);
    expect(section).toContain(CLAUDE_CODE_GUARD_MARKER_END);
    expect(section).toContain("'WindowsPowerShell', 'PowerShell'");
    expect(section).toContain("function claude {");
    expect(section).toContain("& $archReal.Source @args");
    // a fresh connect re-arms checks a previous guard disconnected
    expect(section).toContain(
      `Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $env:USERPROFILE '${CLAUDE_CODE_GUARD_SKIP_RELPATH}')`,
    );
  });

  test("defines the wrapper in the CURRENT session too, so the screen works without a new window", () => {
    const section = buildWindowsStartupGuardInstallSection(
      CTX,
      CLAUDE_CODE_GUARD_CLIENT,
    );
    // irm|iex runs in the caller's scope, so evaluating the block here defines
    // `function claude` in the live session — not only in profile.ps1.
    expect(section).toContain("Invoke-Expression $archGuardBlock");
    // and the final message reflects that it is active immediately
    expect(section).toContain("active in this PowerShell session now");
  });
});

describe("buildWindowsStartupGuardUnshadowSection (Claude Code)", () => {
  test("unhooks the wrapper from the current session but is non-destructive", () => {
    const unshadow = buildWindowsStartupGuardUnshadowSection(
      CLAUDE_CODE_GUARD_CLIENT,
    );
    // irm|iex runs in the current session — dropping the loaded function is what
    // stops a previously-installed guard from splashing during this connect
    expect(unshadow).toContain(
      "Remove-Item Function:claude -ErrorAction SilentlyContinue",
    );
    // …and it does NOTHING else. A connect step failing under 'Stop' runs between
    // this step and the install section, so this step must never delete the
    // persisted guard or edit a profile — otherwise a mid-connect abort would
    // strand the user with no startup screen (the regression this pins against).
    expect(unshadow).not.toContain("Remove-Item -Force");
    expect(unshadow).not.toContain(CLAUDE_CODE_GUARD_PS_SCRIPT_RELPATH);
    expect(unshadow).not.toContain(CLAUDE_CODE_GUARD_SKIP_RELPATH);
    expect(unshadow).not.toContain(CLAUDE_CODE_GUARD_MARKER_START);
    expect(unshadow).not.toContain("Set-Content");
  });
});

// The shared engine already has full Claude behavioral coverage above; these
// pin only what each descriptor makes different on Windows — the wrapped binary,
// its disable env var / non-interactive args, and the reverse-of-connect
// disconnect actions — so Codex and Copilot get a real, correct guard too.
describe.each([
  {
    name: "Codex",
    client: CODEX_GUARD_CLIENT,
    binary: "codex",
    disableEnvVar: "ARCHESTRA_CODEX_GUARD",
    nonInteractive: "$a -eq 'exec'",
    proxyConfig: ".codex\\config.toml",
    proxyNote: "Removed the Archestra provider from ~/.codex/config.toml",
  },
  {
    name: "Copilot CLI",
    client: COPILOT_GUARD_CLIENT,
    binary: "copilot",
    disableEnvVar: "ARCHESTRA_COPILOT_GUARD",
    nonInteractive: "$a -eq '-p' -or $a -eq '--prompt'",
    proxyConfig: "COPILOT_PROVIDER_TYPE",
    proxyNote: "Removed the COPILOT_PROVIDER_* environment variables",
  },
])("renderStartupGuardPowerShell ($name)", ({
  client,
  binary,
  disableEnvVar,
  nonInteractive,
  proxyConfig,
  proxyNote,
}) => {
  const render = (c: StartupGuardClient = client) =>
    renderStartupGuardPowerShell(CTX, c);

  test("wraps the client's own binary, disable flag, and non-interactive args", () => {
    const script = render();
    expect(script).toContain(`if ($env:${disableEnvVar} -eq '0') { exit 0 }`);
    expect(script).toContain(`the real ${binary} no matter how`);
    // resolve the real exe by the client's own name, not claude's
    expect(script).toContain(
      `Get-Command -Name ${binary} -CommandType Application`,
    );
    expect(script).toContain(
      `if (${nonInteractive}) { $Interactive = $false }`,
    );
  });

  test("reuses the shared engine: same health request, retry ladder, alt-screen, reconfigure menu", () => {
    const script = render();
    expect(script).toContain(`$HealthUrl = '${CTX.healthUrl}'`);
    expect(script).toContain("$RetryTotalSeconds = 15");
    expect(script).toContain("[?1049h");
    expect(script).toContain("function Invoke-ArchReconfigureMenu");
    expect(script).toContain("function Wait-ArchHealth");
    // prompts name this client, not Claude
    expect(script).toContain(`from ${client.promptName} now? (Y/n) `);
    expect(script).not.toContain("from Claude now? (Y/n) ");
  });

  test("disconnect actions are the client's reverse-of-connect, via the resolved real exe", () => {
    const script = render();
    expect(script).toContain("$archRealExe = Get-ArchRealExe");
    expect(script).toContain("& $archRealExe.Source mcp remove");
    expect(script).toContain(
      "& $archRealExe.Source plugin marketplace remove $SkillsMarketplaceName",
    );
    // the client-specific proxy reversal + its note
    expect(script).toContain("function Disconnect-ArchProxy");
    expect(script).toContain(proxyConfig);
    expect(script).toContain(proxyNote);
  });

  test("install writes the client's own wrapper + guard path, and unshadow drops only its function", () => {
    const install = buildWindowsStartupGuardInstallSection(CTX, client);
    expect(install).toContain(`function ${binary} {`);
    expect(install).toContain(`'${client.psScriptRelpath}'`);
    expect(install).toContain(client.markerStart);
    // current-session arming works the same for every client
    expect(install).toContain("Invoke-Expression $archGuardBlock");

    const unshadow = buildWindowsStartupGuardUnshadowSection(client);
    expect(unshadow).toContain(
      `Remove-Item Function:${binary} -ErrorAction SilentlyContinue`,
    );
    // non-destructive, same invariant as Claude
    expect(unshadow).not.toContain("Remove-Item -Force");
    expect(unshadow).not.toContain("Set-Content");
  });
});
