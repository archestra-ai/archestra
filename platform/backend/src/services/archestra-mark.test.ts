import { describe, expect, test } from "vitest";
import {
  ARCHESTRA_MARK,
  archestraMarkWithText,
} from "@/services/archestra-mark";
import { renderClaudeCodeStartupGuardPowerShell } from "@/services/claude-code-startup-guard.windows";
import {
  renderSetupScript,
  type SetupScriptContext,
} from "@/services/connection-setup-script";
import {
  buildStartupGuardContext,
  renderStartupGuardScript,
} from "@/services/startup-guard";
import { CLAUDE_CODE_GUARD_CLIENT } from "@/services/startup-guard.clients";

function setupCtx(
  platform: SetupScriptContext["platform"],
): SetupScriptContext {
  return {
    clientId: "claude-code",
    platform,
    appName: "Archestra",
    mcp: {
      serverName: "prod_gateway",
      url: "https://acme.example.com/v1/mcp/prod-gateway",
    },
    proxy: {
      authMode: "virtual-key",
      provider: "anthropic",
      providerLabel: "Anthropic",
      url: "https://acme.example.com/v1/anthropic/acme-proxy",
      proxyName: "acme_proxy",
      virtualKey: "vk",
      virtualKeyName: "k",
      passthroughVirtualKey: null,
      githubCopilot: null,
    },
    skills: null,
  };
}

// One distinctive interior line and the top border of the canonical mark — if
// these appear verbatim, the surface is drawing the exact shared logo.
const MARK_GLYPH_ROW = ARCHESTRA_MARK.unicode[2]; // "   │        ▟██▙      │"
const MARK_TOP_BORDER = ARCHESTRA_MARK.unicode[0]; // "   ╭──────────────────╮"

describe("archestraMarkWithText", () => {
  test("overlays the product name and tagline on their rows, leaving the art intact", () => {
    const lines = archestraMarkWithText({ appName: "Archestra" });
    expect(lines[0]).toBe(MARK_TOP_BORDER);
    expect(lines[3]).toBe(`${ARCHESTRA_MARK.unicode[3]}     Archestra`);
    expect(lines[4]).toBe(
      `${ARCHESTRA_MARK.unicode[4]}     Secure access to your AI tools`,
    );
  });

  test("ASCII variant preserves the same 9-line layout for the legacy console", () => {
    const ascii = archestraMarkWithText({
      appName: "Archestra",
      variant: "ascii",
    });
    expect(ascii).toHaveLength(9);
    expect(ascii[3]).toContain("Archestra");
    expect(ascii.join("\n")).not.toContain("▟"); // no block glyphs in the fallback
  });
});

describe("the identical mark is reused across every /connection surface", () => {
  test("macOS/Linux: the connect banner and the startup guard draw the same art", () => {
    const banner = renderSetupScript(setupCtx("linux"));
    const guard = renderStartupGuardScript(
      buildStartupGuardContext(setupCtx("linux")),
      CLAUDE_CODE_GUARD_CLIENT,
    );
    for (const surface of [banner, guard]) {
      expect(surface).toContain(MARK_TOP_BORDER);
      expect(surface).toContain(MARK_GLYPH_ROW);
    }
  });

  test("Windows: the guard draws the same Unicode art (it's a BOM'd UTF-8 file)", () => {
    const guard = renderClaudeCodeStartupGuardPowerShell(
      buildStartupGuardContext(setupCtx("windows")),
    );
    expect(guard).toContain(MARK_TOP_BORDER);
    expect(guard).toContain(MARK_GLYPH_ROW);
  });

  test("Windows connect banner reuses the Unicode mark, gated on capability with an ASCII fallback", () => {
    const script = renderSetupScript(setupCtx("windows"));
    // capability detection + UTF-8 switch in the preamble
    expect(script).toContain("$ArchUtf8");
    expect(script).toContain("$env:WT_SESSION");
    expect(script).toContain("[System.Text.UTF8Encoding]::new()");
    // both renditions are emitted; PowerShell picks one at runtime
    expect(script).toContain("if ($ArchUtf8) {");
    expect(script).toContain(MARK_TOP_BORDER); // the exact Unicode mark
    expect(script).toContain("`##' `'"); // the ASCII fallback mark
  });
});
