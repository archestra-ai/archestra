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
  buildClaudeCodeStartupGuardInstallSection,
  type ClaudeCodeStartupGuardContext,
  renderClaudeCodeStartupGuardScript,
} from "@/services/claude-code-startup-guard";

const execFileAsync = promisify(execFile);

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
 * prints `body` for health probes (the reachability probe passes -o, which
 * the stub honors by staying silent, keeping stdout clean).
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
printf '%s' '${params.curlBody ?? '{"status":"ok"}'}'
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

describe("renderClaudeCodeStartupGuardScript", () => {
  test("renders parseable bash with no unrendered placeholders", async () => {
    const script = renderClaudeCodeStartupGuardScript(CTX);
    await expectValidBash(script);
    expect(script).not.toMatch(/<[a-z-]+>/);
    expect(script.startsWith("#!/usr/bin/env bash")).toBe(true);
  });

  test("probes the remotes in pre-loader order: proxy, gateway, skills", () => {
    const script = renderClaudeCodeStartupGuardScript(CTX);
    const proxyAt = script.indexOf("LLM proxy (Anthropic)");
    const mcpAt = script.indexOf("MCP gateway (prod_gateway)");
    const skillsAt = script.indexOf("Skills marketplace (acme-skills)");
    expect(proxyAt).toBeGreaterThan(-1);
    expect(mcpAt).toBeGreaterThan(proxyAt);
    expect(skillsAt).toBeGreaterThan(mcpAt);
    for (const url of [CTX.proxy?.url, CTX.mcp?.url, CTX.skills?.cloneUrl]) {
      expect(script).toContain(`'${url}'`);
    }
  });

  test("gateway and proxy get existence checks; skills stays reachability-only", () => {
    const script = renderClaudeCodeStartupGuardScript(CTX);
    expect(script).toContain(`'${CTX.proxy?.healthUrl}'`);
    expect(script).toContain(`'${CTX.mcp?.healthUrl}'`);
    // health probe reads the body (missing marker), reachability discards it
    expect(script).toContain(`'"status":"missing"'`);
    expect(script).toContain(
      'curl -sS -o /dev/null --connect-timeout 2 --max-time 3 "$1"',
    );
    expect(script).not.toContain("curl -f");
    // skills has no health URL: an empty entry in the parallel array
    expect(script).toMatch(/GUARD_HEALTH_URLS=\([^)]*''\)/);
  });

  test("a missing remote prompts immediately instead of burning the retry budget", () => {
    const script = renderClaudeCodeStartupGuardScript(CTX);
    expect(script).toContain("prompt_missing");
    expect(script).toContain("was removed on %s");
    expect(script).toContain(
      "[d] disconnect it from Claude Code (recommended)   [s] keep it (default)",
    );
    // rc 2 short-circuits before the retry ladder starts
    expect(script).toMatch(
      /if \[ "\$rc" = "2" ]; then prompt_missing "\$1" "\$3"; return 0; fi\n {2}start=/,
    );
  });

  test("encodes the retry contract: 15s budget, notice at 3s, hang-tight at 10s, live skip/disconnect keys", () => {
    const script = renderClaudeCodeStartupGuardScript(CTX);
    expect(script).toContain("RETRY_TOTAL_SECONDS=15");
    expect(script).toContain("NOTICE_AFTER_SECONDS=3");
    expect(script).toContain("HANG_TIGHT_AFTER_SECONDS=10");
    expect(script).toContain("few more seconds, hang tight...");
    expect(script).toContain("trying to connect...");
    expect(script).toContain("[s] skip  [d] disconnect");
    expect(script).toContain("next_delay=$((next_delay * 2))");
    expect(script).toContain("RANDOM % 2");
  });

  test("paces every check with an animated spinner and a minimum display time", () => {
    const script = renderClaudeCodeStartupGuardScript(CTX);
    expect(script).toContain(
      "FRAMES=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')",
    );
    expect(script).toContain("MIN_CHECK_FRAMES=7");
    expect(script).toContain("FRAME_SLEEP=0.08");
    // sub-second ticks on bash 4+, 1s fallback for macOS system bash 3.2
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

  test("the unreachable prompt defaults to continuing and always lets claude launch", () => {
    const script = renderClaudeCodeStartupGuardScript(CTX);
    expect(script).toContain(
      "[s] continue without it (default)   [d] disconnect it from Claude Code",
    );
    expect(script.trimEnd().endsWith("exit 0")).toBe(true);
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
  });

  test("bedrock variant strips the bedrock env keys and flags the shell-profile token", () => {
    const script = renderClaudeCodeStartupGuardScript({
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
      expect(script).toContain(`"${key}"`);
    }
    expect(script).toContain("AWS_BEARER_TOKEN_BEDROCK");
  });

  test("omitted sections render no probe for them", () => {
    const script = renderClaudeCodeStartupGuardScript({
      ...CTX,
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
      curlBody: '{"status":"ok"}',
    });
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });

  test("non-interactive run with unreachable remotes warns per remote on stderr and still exits 0", async () => {
    const { stdout, stderr } = await runGuardNonInteractive({
      script: renderClaudeCodeStartupGuardScript(CTX),
      curlExitCode: 7,
    });
    expect(stdout).toBe("");
    expect(stderr).toContain("LLM proxy (Anthropic) is unreachable");
    expect(stderr).toContain("MCP gateway (prod_gateway) is unreachable");
    expect(stderr).toContain("Skills marketplace (acme-skills) is unreachable");
  });

  test("non-interactive run with deleted remotes reports them as removed — the false-green regression", async () => {
    // The backend answers (so reachability is fine) but says the resources no
    // longer exist. The old reachability-only guard showed green here.
    const { stdout, stderr } = await runGuardNonInteractive({
      script: renderClaudeCodeStartupGuardScript(CTX),
      curlExitCode: 0,
      curlBody: '{"status":"missing"}',
    });
    expect(stdout).toBe("");
    expect(stderr).toContain("LLM proxy (Anthropic) was removed on Archestra");
    expect(stderr).toContain(
      "MCP gateway (prod_gateway) was removed on Archestra",
    );
    // skills has no existence check — reachable means silent
    expect(stderr).not.toContain("Skills marketplace");
  });

  test("an older backend without the health route degrades to reachability-only, never false-missing", async () => {
    // A 404 body from the then-unknown route carries no "missing" marker.
    const { stderr } = await runGuardNonInteractive({
      script: renderClaudeCodeStartupGuardScript(CTX),
      curlExitCode: 0,
      curlBody:
        '{"error":{"message":"Route GET:/api/connection-health not found"}}',
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
