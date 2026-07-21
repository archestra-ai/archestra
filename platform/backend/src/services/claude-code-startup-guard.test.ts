import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  CLAUDE_CODE_GUARD_MARKER_END,
  CLAUDE_CODE_GUARD_MARKER_START,
  CLAUDE_CODE_GUARD_SCRIPT_RELPATH,
  CLAUDE_CODE_PROXY_ENV_KEYS,
} from "@archestra/shared";
import { describe, expect, test } from "vitest";
import {
  buildClaudeCodeStartupGuardContext,
  buildClaudeCodeStartupGuardInstallSection,
  type ClaudeCodeStartupGuardContext,
  renderClaudeCodeStartupGuardScript,
} from "@/services/claude-code-startup-guard";
import type { SetupScriptContext } from "@/services/connection-setup-script";

const execFileAsync = promisify(execFile);

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

async function expectValidBash(script: string): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "archestra-guard-"));
  const file = path.join(dir, "guard.sh");
  try {
    await writeFile(file, script, "utf8");
    await execFileAsync("bash", ["-n", file]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Runs the rendered guard through real bash with a stubbed `curl` on PATH.
 * stdin/stdout are pipes, so the guard takes its non-interactive path — the
 * one automation hits — which must never prompt and always exit 0. The stub
 * prints `body` for the health fetch (reachability probes pass -o, which the
 * stub honors by staying silent, keeping stdout clean).
 */
async function runGuardNonInteractive(params: {
  script: string;
  curlExitCode: number;
  curlBody?: string;
  args?: string[];
  env?: Record<string, string>;
}): Promise<{ stdout: string; stderr: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "archestra-guard-run-"));
  const guardFile = path.join(dir, "guard.sh");
  const curlStub = path.join(dir, "curl");
  try {
    await writeFile(guardFile, params.script, "utf8");
    await writeFile(
      curlStub,
      `#!/bin/sh
case "$*" in *" -o "*) exit ${params.curlExitCode};; esac
printf '%s' '${params.curlBody ?? '{"mcp":"ok","llm":"ok"}'}'
exit ${params.curlExitCode}
`,
      "utf8",
    );
    await chmod(guardFile, 0o755);
    await chmod(curlStub, 0o755);
    // execFile rejects on non-zero exit, so a resolved promise IS the
    // always-exit-0 assertion.
    return await execFileAsync("bash", [guardFile, ...(params.args ?? [])], {
      env: {
        ...process.env,
        ...params.env,
        PATH: `${dir}:${process.env.PATH}`,
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("buildClaudeCodeStartupGuardContext", () => {
  test("derives refs and the single health URL from the connect-wired URLs", () => {
    const setupCtx: SetupScriptContext = {
      clientId: "claude-code",
      platform: "macos",
      appName: "Archestra",
      mcp: {
        serverName: "prod_gateway",
        url: "https://archestra.example.com/v1/mcp/prod-gateway",
      },
      proxy: {
        authMode: "provider-key",
        provider: "anthropic",
        providerLabel: "Anthropic",
        url: "https://archestra.example.com/v1/anthropic/profile-123",
        proxyName: "default_proxy",
        virtualKey: null,
        virtualKeyName: null,
        passthroughVirtualKey: null,
      },
      skills: null,
    };
    const guardCtx = buildClaudeCodeStartupGuardContext(setupCtx);
    expect(guardCtx.healthUrl).toBe(
      "https://archestra.example.com/v1/health?mcp=prod-gateway&llm=profile-123",
    );
    expect(guardCtx.mcp?.ref).toBe("prod-gateway");
    expect(guardCtx.proxy?.ref).toBe("profile-123");

    // gateway-only connects still get a health URL with just the mcp param
    const mcpOnly = buildClaudeCodeStartupGuardContext({
      ...setupCtx,
      proxy: null,
    });
    expect(mcpOnly.healthUrl).toBe(
      "https://archestra.example.com/v1/health?mcp=prod-gateway",
    );
  });
});

describe("renderClaudeCodeStartupGuardScript", () => {
  test("renders parseable bash with no unrendered placeholders", async () => {
    const script = renderClaudeCodeStartupGuardScript(CTX);
    await expectValidBash(script);
    expect(script).not.toMatch(/<[a-z-]+>/);
    expect(script.startsWith("#!/usr/bin/env bash")).toBe(true);
  });

  test("shows the remotes in pre-loader order: proxy, gateway, skills", () => {
    const script = renderClaudeCodeStartupGuardScript(CTX);
    const proxyAt = script.indexOf("LLM proxy (Anthropic)");
    const mcpAt = script.indexOf("MCP gateway (prod_gateway)");
    const skillsAt = script.indexOf("Skills marketplace (acme-skills)");
    expect(proxyAt).toBeGreaterThan(-1);
    expect(mcpAt).toBeGreaterThan(proxyAt);
    expect(skillsAt).toBeGreaterThan(mcpAt);
  });

  test("makes ONE health request for the launch; skills has no per-resource marker", () => {
    const script = renderClaudeCodeStartupGuardScript(CTX);
    expect(script).toContain(`HEALTH_URL='${CTX.healthUrl}'`);
    expect(script).toContain(`'"mcp":"down"'`);
    expect(script).toContain(`'"llm":"down"'`);
    // skills follows overall endpoint reachability: empty down marker
    expect(script).toMatch(/GUARD_DOWN_MARKERS=\([^)]*''\)/);
    expect(script).toContain("wait_for_health");
    expect(script).not.toContain("curl -f");
  });

  test("a down resource stops the turn with the failure copy naming type and id-or-slug", () => {
    const script = renderClaudeCodeStartupGuardScript(CTX);
    expect(script).toContain("✖ Failed to connect to");
    expect(script).toContain("'LLM proxy profile-123'");
    expect(script).toContain("'MCP gateway prod-gateway'");
    expect(script).toContain("'Skills marketplace acme-skills'");
    expect(script).toContain(
      "[d] disconnect it from Claude Code   [s] continue without it (default)",
    );
  });

  test("encodes the retry contract on the single request: 15s budget, notice at 3s, hang-tight at 10s, live keys", () => {
    const script = renderClaudeCodeStartupGuardScript(CTX);
    expect(script).toContain("RETRY_TOTAL_SECONDS=15");
    expect(script).toContain("NOTICE_AFTER_SECONDS=3");
    expect(script).toContain("HANG_TIGHT_AFTER_SECONDS=10");
    expect(script).toContain("few more seconds, hang tight...");
    expect(script).toContain("trying to connect...");
    expect(script).toContain("[s] skip  [d] disconnect");
    expect(script).toContain("next_delay=$((next_delay * 2))");
    expect(script).toContain("RANDOM % 2");
    // the budget running out downs everything
    expect(script).toContain("HEALTH_STATE='down'");
  });

  test("paces every resource's turn with an animated spinner and a minimum display time", () => {
    const script = renderClaudeCodeStartupGuardScript(CTX);
    expect(script).toContain(
      "FRAMES=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')",
    );
    expect(script).toContain("MIN_CHECK_FRAMES=7");
    expect(script).toContain("FRAME_SLEEP=0.08");
    expect(script).toContain(
      'if [ "${BASH_VERSINFO[0]:-3}" -ge 4 ]; then TICK=0.25; fi',
    );
    expect(script).toContain('read -rs -n 1 -t "$TICK" key');
  });

  test("renders the Archestra mark for the default brand, plain title when white-labeled", () => {
    const branded = renderClaudeCodeStartupGuardScript(CTX);
    expect(branded).toContain("▟██▙");
    expect(branded).toContain("Secure access to your AI tools");

    const whiteLabel = renderClaudeCodeStartupGuardScript({
      ...CTX,
      appName: "Acme AI",
    });
    expect(whiteLabel).not.toContain("▟██▙");
    expect(whiteLabel).toContain("Pre-loader");
  });

  test("disconnect actions mirror the connect steps for each remote", () => {
    const script = renderClaudeCodeStartupGuardScript(CTX);
    // the variables the disconnect actions dereference MUST be assigned —
    // under set -u a missing assignment kills the guard exactly when the
    // user presses d (caught live; pinned here)
    expect(script).toContain("MCP_SERVER_NAME='prod_gateway'");
    expect(script).toContain("SKILLS_MARKETPLACE_NAME='acme-skills'");
    expect(script).toContain(
      'command claude mcp remove --scope user "$MCP_SERVER_NAME"',
    );
    expect(script).toContain(
      'command claude mcp remove --scope local "$MCP_SERVER_NAME"',
    );
    expect(script).toContain(
      'command claude plugin marketplace remove "$SKILLS_MARKETPLACE_NAME"',
    );
    for (const key of CLAUDE_CODE_PROXY_ENV_KEYS.anthropic) {
      expect(script).toContain(`"${key}"`);
    }
    expect(script).toContain('"x-archestra-agent-id"');
    expect(script).toContain('"x-archestra-virtual-key"');
    expect(script.trimEnd().endsWith("exit 0")).toBe(true);
  });

  test("bedrock variant strips the bedrock env keys and flags the shell-profile token", () => {
    const script = renderClaudeCodeStartupGuardScript({
      ...CTX,
      proxy: {
        provider: "bedrock",
        providerLabel: "AWS Bedrock",
        url: "https://archestra.example.com/v1/bedrock/profile-123",
        ref: "profile-123",
      },
    });
    for (const key of CLAUDE_CODE_PROXY_ENV_KEYS.bedrock) {
      expect(script).toContain(`"${key}"`);
    }
    expect(script).toContain("AWS_BEARER_TOKEN_BEDROCK");
  });

  test("omitted sections render no row for them", () => {
    const script = renderClaudeCodeStartupGuardScript({
      ...CTX,
      healthUrl: "https://archestra.example.com/v1/health?mcp=prod-gateway",
      skills: null,
      proxy: null,
    });
    expect(script).not.toContain("Skills marketplace");
    expect(script).not.toContain("LLM proxy");
    expect(script).toContain("MCP gateway (prod_gateway)");
  });

  test("non-interactive run with healthy remotes is silent and exits 0", async () => {
    const { stdout, stderr } = await runGuardNonInteractive({
      script: renderClaudeCodeStartupGuardScript(CTX),
      curlExitCode: 0,
      curlBody: '{"mcp":"ok","llm":"ok"}',
    });
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });

  test("non-interactive run with the platform unreachable downs every remote on stderr, exit 0", async () => {
    const { stdout, stderr } = await runGuardNonInteractive({
      script: renderClaudeCodeStartupGuardScript(CTX),
      curlExitCode: 7,
    });
    expect(stdout).toBe("");
    expect(stderr).toContain("failed to connect to LLM proxy profile-123");
    expect(stderr).toContain("failed to connect to MCP gateway prod-gateway");
    expect(stderr).toContain(
      "failed to connect to Skills marketplace acme-skills",
    );
  });

  test("non-interactive run with platform-reported down remotes warns per remote — the false-green regression", async () => {
    // The platform answers (reachability fine) but reports both resources
    // down. The old reachability-only guard showed green here.
    const { stdout, stderr } = await runGuardNonInteractive({
      script: renderClaudeCodeStartupGuardScript(CTX),
      curlExitCode: 0,
      curlBody: '{"mcp":"down","llm":"down"}',
    });
    expect(stdout).toBe("");
    expect(stderr).toContain("failed to connect to LLM proxy profile-123");
    expect(stderr).toContain("failed to connect to MCP gateway prod-gateway");
    // endpoint reachable => the same-origin skills marketplace is fine
    expect(stderr).not.toContain("Skills marketplace");
  });

  test("one down resource warns only for itself", async () => {
    const { stderr } = await runGuardNonInteractive({
      script: renderClaudeCodeStartupGuardScript(CTX),
      curlExitCode: 0,
      curlBody: '{"mcp":"down","llm":"ok"}',
    });
    expect(stderr).toContain("failed to connect to MCP gateway prod-gateway");
    expect(stderr).not.toContain("LLM proxy");
  });

  test("down markers match pretty-printed JSON too (whitespace-normalized body)", async () => {
    const { stderr } = await runGuardNonInteractive({
      script: renderClaudeCodeStartupGuardScript(CTX),
      curlExitCode: 0,
      curlBody: '{"mcp": "down", "llm": "ok"}',
    });
    expect(stderr).toContain("failed to connect to MCP gateway prod-gateway");
    expect(stderr).not.toContain("LLM proxy");
  });

  test("an older backend without the health route degrades to reachable-silent, never false-down", async () => {
    const { stderr } = await runGuardNonInteractive({
      script: renderClaudeCodeStartupGuardScript(CTX),
      curlExitCode: 0,
      curlBody: '{"error":{"message":"Route GET:/v1/health not found"}}',
    });
    expect(stderr).toBe("");
  });

  test("ARCHESTRA_CLAUDE_GUARD=0 disables the guard entirely", async () => {
    const { stdout, stderr } = await runGuardNonInteractive({
      script: renderClaudeCodeStartupGuardScript(CTX),
      curlExitCode: 7,
      env: { ARCHESTRA_CLAUDE_GUARD: "0" },
    });
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });
});

describe("buildClaudeCodeStartupGuardInstallSection", () => {
  test("writes the guard file and hooks an idempotent marker block into shell profiles", () => {
    const section = buildClaudeCodeStartupGuardInstallSection(CTX);
    expect(section).toContain(`$HOME/${CLAUDE_CODE_GUARD_SCRIPT_RELPATH}`);
    expect(section).toContain(CLAUDE_CODE_GUARD_MARKER_START);
    expect(section).toContain(CLAUDE_CODE_GUARD_MARKER_END);
    expect(section).toContain(
      `chmod +x "$HOME/${CLAUDE_CODE_GUARD_SCRIPT_RELPATH}"`,
    );
    // wrapper always falls through to the real binary
    expect(section).toContain('command claude "$@"');
    // strip-then-append keeps re-runs from duplicating the block
    expect(section).toContain("awk -v start=");
  });
});
