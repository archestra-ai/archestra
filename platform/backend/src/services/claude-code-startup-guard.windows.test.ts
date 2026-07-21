import {
  CLAUDE_CODE_GUARD_MARKER_END,
  CLAUDE_CODE_GUARD_MARKER_START,
  CLAUDE_CODE_GUARD_PS_SCRIPT_RELPATH,
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
  proxy: {
    provider: "anthropic",
    providerLabel: "Anthropic",
    url: "https://archestra.example.com/v1/anthropic/profile-123",
    healthUrl:
      "https://archestra.example.com/api/connection-health?kind=llm-proxy&ref=profile-123",
  },
  mcp: {
    serverName: "prod_gateway",
    url: "https://archestra.example.com/v1/mcp/prod-gateway",
    healthUrl:
      "https://archestra.example.com/api/connection-health?kind=mcp-gateway&ref=prod-gateway",
  },
  skills: {
    marketplaceName: "acme-skills",
    cloneUrl:
      "https://archestra.example.com/skill-marketplace/archestra_skl_token123/repo.git",
  },
};

describe("renderClaudeCodeStartupGuardPowerShell", () => {
  test("probes the remotes in pre-loader order with the demo visuals", () => {
    const script = renderClaudeCodeStartupGuardPowerShell(CTX);
    const proxyAt = script.indexOf("LLM proxy (Anthropic)");
    const mcpAt = script.indexOf("MCP gateway (prod_gateway)");
    const skillsAt = script.indexOf("Skills marketplace (acme-skills)");
    expect(proxyAt).toBeGreaterThan(-1);
    expect(mcpAt).toBeGreaterThan(proxyAt);
    expect(skillsAt).toBeGreaterThan(mcpAt);
    expect(script).toContain("Pre-loader");
    expect(script).toContain("Connecting claude via:");
    for (const url of [CTX.proxy?.url, CTX.mcp?.url, CTX.skills?.cloneUrl]) {
      expect(script).toContain(`'${url}'`);
    }
  });

  test("gateway and proxy get existence checks; skills stays reachability-only", () => {
    const script = renderClaudeCodeStartupGuardPowerShell(CTX);
    expect(script).toContain(`'${CTX.proxy?.healthUrl}'`);
    expect(script).toContain(`'${CTX.mcp?.healthUrl}'`);
    expect(script).toContain(`'"status":"missing"'`);
    // skills entry carries an empty HealthUrl
    expect(script).toContain("HealthUrl = ''");
    // reachable-but-erroring servers still count as reachable on both editions
    expect(script).toContain(
      "$_.Exception.PSObject.Properties['Response'] -and $_.Exception.Response",
    );
    expect(script).toContain("-TimeoutSec 3");
  });

  test("a missing remote prompts immediately instead of burning the retry budget", () => {
    const script = renderClaudeCodeStartupGuardPowerShell(CTX);
    expect(script).toContain("Show-ArchMissingPrompt");
    expect(script).toContain("was removed on ");
    expect(script).toContain(
      "[d] disconnect it from Claude Code (recommended)   [s] keep it (default)",
    );
    expect(script).toMatch(
      /if \(\$state -eq 'missing'\) \{ Show-ArchMissingPrompt \$r\.Label \$r\.Kind; return \}\n {2}\$start =/,
    );
  });

  test("encodes the retry contract: 15s budget, notice at 3s, hang-tight at 10s, live skip/disconnect keys", () => {
    const script = renderClaudeCodeStartupGuardPowerShell(CTX);
    expect(script).toContain("$RetryTotalSeconds = 15");
    expect(script).toContain("$NoticeAfterSeconds = 3");
    expect(script).toContain("$HangTightAfterSeconds = 10");
    expect(script).toContain("few more seconds, hang tight...");
    expect(script).toContain("trying to connect...");
    expect(script).toContain("[s] skip  [d] disconnect");
    expect(script).toContain("[Math]::Min($delay * 2, 4)");
    expect(script).toContain("Get-Random -Minimum 0 -Maximum 2");
  });

  test("paces every check with an animated spinner and a minimum display time", () => {
    const script = renderClaudeCodeStartupGuardPowerShell(CTX);
    expect(script).toContain(
      "$Frames = @('⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏')",
    );
    expect(script).toContain("$MinCheckFrames = 7");
    expect(script).toContain("$FrameSleepMs = 80");
    expect(script).toContain("Show-ArchSpin");
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
    expect(whiteLabel).toContain("Pre-loader");
  });

  test("never blocks: opt-out env var, non-interactive stderr warnings for down AND removed, exit 0", () => {
    const script = renderClaudeCodeStartupGuardPowerShell(CTX);
    expect(script).toContain("ARCHESTRA_CLAUDE_GUARD");
    expect(script).toContain("[Console]::IsInputRedirected");
    expect(script).toContain("[Console]::Error.WriteLine");
    expect(script).toContain("'-p' -or $a -eq '--print'");
    expect(script).toContain("' is unreachable — claude may fail");
    expect(script).toContain("' was removed on '");
    expect(script).toContain(
      "[s] continue without it (default)   [d] disconnect it from Claude Code",
    );
    expect(script.trimEnd().endsWith("exit 0")).toBe(true);
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
        healthUrl:
          "https://archestra.example.com/api/connection-health?kind=llm-proxy&ref=profile-123",
      },
    });
    for (const key of CLAUDE_CODE_PROXY_ENV_KEYS.bedrock) {
      expect(script).toContain(`'${key}'`);
    }
    expect(script).toContain("AWS_BEARER_TOKEN_BEDROCK");
  });

  test("omitted sections render no probe or disconnect machinery for them", () => {
    const script = renderClaudeCodeStartupGuardPowerShell({
      ...CTX,
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
  });
});
