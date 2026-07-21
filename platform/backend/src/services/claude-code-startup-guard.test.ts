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
  },
  mcp: {
    serverName: "prod_gateway",
    url: "https://archestra.example.com/v1/mcp/prod-gateway",
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
 * one automation hits — which must never prompt and always exit 0.
 */
async function runGuardNonInteractive(params: {
  script: string;
  curlExitCode: number;
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
      `#!/bin/sh\nexit ${params.curlExitCode}\n`,
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

  test("keeps the reachability probe a connectivity check (no curl -f) with tight timeouts", () => {
    const script = renderClaudeCodeStartupGuardScript(CTX);
    expect(script).toContain(
      'curl -sS -o /dev/null --connect-timeout 2 --max-time 3 "$1"',
    );
    expect(script).not.toContain("curl -f");
  });

  test("encodes the retry contract: 15s budget, notice at 3s, hang-tight at 10s, live skip/disconnect keys", () => {
    const script = renderClaudeCodeStartupGuardScript(CTX);
    expect(script).toContain("RETRY_TOTAL_SECONDS=15");
    expect(script).toContain("NOTICE_AFTER_SECONDS=3");
    expect(script).toContain("HANG_TIGHT_AFTER_SECONDS=10");
    expect(script).toContain("few more seconds, hang tight...");
    expect(script).toContain("trying to connect...");
    expect(script).toContain("[s] skip  [d] disconnect");
    // backoff doubles and is capped, with jitter
    expect(script).toContain("next_delay=$((next_delay * 2))");
    expect(script).toContain("RANDOM % 2");
  });

  test("the failure prompt defaults to continuing and always lets claude launch", () => {
    const script = renderClaudeCodeStartupGuardScript(CTX);
    expect(script).toContain(
      "[s] continue without it (default)   [d] disconnect it from Claude Code",
    );
    expect(script.trimEnd().endsWith("exit 0")).toBe(true);
  });

  test("disconnect actions mirror the connect steps for each remote", () => {
    const script = renderClaudeCodeStartupGuardScript(CTX);
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
    // headers are stripped line-wise, never the whole key of a user who added their own
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

  test("non-interactive run with reachable remotes is silent and exits 0", async () => {
    const { stderr } = await runGuardNonInteractive({
      script: renderClaudeCodeStartupGuardScript(CTX),
      curlExitCode: 0,
    });
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
