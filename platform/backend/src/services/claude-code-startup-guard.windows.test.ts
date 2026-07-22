import {
  CLAUDE_CODE_GUARD_MARKER_END,
  CLAUDE_CODE_GUARD_MARKER_START,
  CLAUDE_CODE_GUARD_PS_SCRIPT_RELPATH,
  CLAUDE_CODE_GUARD_SKIP_RELPATH,
  CLAUDE_CODE_PROXY_ENV_KEYS,
} from "@archestra/shared";
import { describe, expect, test } from "vitest";
import type { ClaudeCodeStartupGuardContext } from "@/services/claude-code-startup-guard";
import {
  buildWindowsClaudeCodeStartupGuardInstallSection,
  renderClaudeCodeStartupGuardPowerShell,
} from "@/services/claude-code-startup-guard.windows";

/**
 * Structure pins for the PowerShell guard. No PowerShell runtime exists in CI,
 * so unlike the bash suite there is no syntax/behavioral pass — the contract
 * is pinned on the rendered text, mirroring the bash assertions.
 */

const CTX: ClaudeCodeStartupGuardContext = {
  appName: "Archestra",
  healthUrl:
    "https://archestra.example.com/v1/health?mcp=prod-gateway&llm=profile-123",
  proxy: {
    provider: "anthropic",
    providerLabel: "Anthropic",
    url: "https://archestra.example.com/v1/anthropic/profile-123",
    ref: "profile-123",
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

describe("renderClaudeCodeStartupGuardPowerShell", () => {
  test("shows the remotes in pre-loader order with the demo visuals", () => {
    const script = renderClaudeCodeStartupGuardPowerShell(CTX);
    const proxyAt = script.indexOf("LLM proxy (Anthropic)");
    const mcpAt = script.indexOf("MCP gateway (prod_gateway)");
    const skillsAt = script.indexOf("Skills marketplace (acme-skills)");
    expect(proxyAt).toBeGreaterThan(-1);
    expect(mcpAt).toBeGreaterThan(proxyAt);
    expect(skillsAt).toBeGreaterThan(mcpAt);
  });

  test("makes ONE health request for the launch; skills has no per-resource marker", () => {
    const script = renderClaudeCodeStartupGuardPowerShell(CTX);
    expect(script).toContain(`$HealthUrl = '${CTX.healthUrl}'`);
    expect(script).toContain(`DownMarker = '"mcp":"down"'`);
    expect(script).toContain(`DownMarker = '"llm":"down"'`);
    expect(script).toContain("DownMarker = ''");
    expect(script).toContain("Wait-ArchHealth");
    expect(script).toContain("-TimeoutSec 3");
    // reachable-but-erroring servers still count as answered on both editions
    expect(script).toContain(
      "$_.Exception.PSObject.Properties['Response'] -and $_.Exception.Response",
    );
  });

  test("every down remote gets the failure copy; ONE prompt then covers them all", () => {
    const script = renderClaudeCodeStartupGuardPowerShell(CTX);
    expect(script).toContain("'✗ Failed to connect to ' + $r.FailName");
    expect(script).toContain("FailName = 'LLM proxy (profile-123)'");
    expect(script).toContain("FailName = 'MCP gateway (prod-gateway)'");
    expect(script).toContain("FailName = 'Skills marketplace (acme-skills)'");
    // a single down remote names its resource type…
    expect(script).toContain(
      "'[d] Disconnect ' + $downRemotes[0].TypeName + '   [s] Continue without it (default)'",
    );
    expect(script).toContain("TypeName = 'MCP gateway'");
    // …several down remotes get the disconnect-all-at-once copy
    expect(script).toContain(
      "[d] Disconnect all of them   [s] Continue without them (default)",
    );
    expect(script).toContain("Show-ArchDownSummaryPrompt $DownRemotes");
  });

  test("remembers disconnected remotes in the skip file and uninstalls itself once nothing is left", () => {
    const script = renderClaudeCodeStartupGuardPowerShell(CTX);
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
    // the all-down disconnect ends with the removal note
    expect(script).toContain("Nothing connected is left to check");
  });

  test("encodes the retry contract on the single request: 15s budget, notice at 3s, hang-tight at 10s, live keys", () => {
    const script = renderClaudeCodeStartupGuardPowerShell(CTX);
    expect(script).toContain("$RetryTotalSeconds = 15");
    expect(script).toContain("$NoticeAfterSeconds = 3");
    expect(script).toContain("$HangTightAfterSeconds = 10");
    expect(script).toContain("few more seconds, hang tight...");
    expect(script).toContain("trying to connect...");
    expect(script).toContain("[s] Skip  [d] Disconnect");
    expect(script).toContain("[Math]::Min($delay * 2, 4)");
    expect(script).toContain("Get-Random -Minimum 0 -Maximum 2");
  });

  test("paces every resource's turn at ~0.2s with glyph-only spinner ticks, on the alternate screen", () => {
    const script = renderClaudeCodeStartupGuardPowerShell(CTX);
    expect(script).toContain(
      "$Frames = @('⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏')",
    );
    // ~0.35s per row at ~90ms per frame — the classic spinner cadence;
    // faster frame rates read as trembling (caught live on Windows Terminal)
    expect(script).toContain("$MinCheckFrames = 4");
    expect(script).toContain("$FrameSleepMs = 90");
    // ticks repaint only the spinner glyph — full-line repaints flicker
    expect(script).toContain("function Show-ArchSpinTick");
    // alternate screen in/out — the terminal stays clean after claude exits
    expect(script).toContain("[?1049h");
    expect(script).toContain("[?1049l");
    expect(script).toContain("function Exit-ArchGuard");
  });

  test("renders the Archestra mark for the default brand, plain title when white-labeled", () => {
    const branded = renderClaudeCodeStartupGuardPowerShell(CTX);
    expect(branded).toContain("▟██▙");
    expect(branded).toContain("Secure access to your AI tools");

    const whiteLabel = renderClaudeCodeStartupGuardPowerShell({
      ...CTX,
      appName: "Acme AI",
    });
    expect(whiteLabel).not.toContain("▟██▙");
    expect(whiteLabel).toContain("'Acme AI'");
  });

  test("never blocks: opt-out env var, non-interactive stderr warnings with the failure copy, exit 0", () => {
    const script = renderClaudeCodeStartupGuardPowerShell(CTX);
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
    const script = renderClaudeCodeStartupGuardPowerShell(CTX);
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
    const script = renderClaudeCodeStartupGuardPowerShell({
      ...CTX,
      proxy: {
        provider: "bedrock",
        providerLabel: "AWS Bedrock",
        url: "https://archestra.example.com/v1/bedrock/profile-123",
        ref: "profile-123",
      },
    });
    for (const key of CLAUDE_CODE_PROXY_ENV_KEYS.bedrock) {
      expect(script).toContain(`'${key}'`);
    }
    expect(script).toContain("AWS_BEARER_TOKEN_BEDROCK");
  });

  test("omitted sections render no row or disconnect machinery for them", () => {
    const script = renderClaudeCodeStartupGuardPowerShell({
      ...CTX,
      healthUrl: "https://archestra.example.com/v1/health?mcp=prod-gateway",
      skills: null,
      proxy: null,
    });
    expect(script).not.toContain("Skills marketplace");
    expect(script).not.toContain("LLM proxy");
    expect(script).not.toContain("marketplace remove");
    expect(script).not.toContain("Disconnect-ArchProxy");
    expect(script).toContain("MCP gateway (prod_gateway)");
  });

  test("no line opens or closes a single-quoted here-string (the installer embeds the body in one)", () => {
    const script = renderClaudeCodeStartupGuardPowerShell(CTX);
    for (const line of script.split("\n")) {
      expect(line.startsWith("'@")).toBe(false);
      expect(line.trimEnd().endsWith("@'")).toBe(false);
    }
  });
});

describe("buildWindowsClaudeCodeStartupGuardInstallSection", () => {
  test("writes the guard as BOM'd UTF-8 and hooks every PowerShell edition's profile idempotently", () => {
    const section = buildWindowsClaudeCodeStartupGuardInstallSection(CTX);
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
});
