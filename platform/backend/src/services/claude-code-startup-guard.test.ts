import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  CLAUDE_CODE_GUARD_MARKER_END,
  CLAUDE_CODE_GUARD_MARKER_START,
  CLAUDE_CODE_GUARD_SCRIPT_RELPATH,
  CLAUDE_CODE_GUARD_SKIP_RELPATH,
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
 * A sandboxed $HOME the guard can freely mutate: the guard file at its real
 * install path, shell profiles carrying the wrapper marker block, a proxy
 * settings.json, a `claude` stub that logs its argv, and a `curl` stub that
 * answers the health fetch. Everything the guard's disconnect/uninstall
 * actions touch lives here, never in the developer's real home.
 */
interface GuardHome {
  dir: string;
  home: string;
  guardFile: string;
  skipFile: string;
  claudeLog: string;
  settingsFile: string;
  env: Record<string, string>;
}

const PROFILE_SENTINEL = "export ARCHESTRA_TEST_SENTINEL=1";

async function makeGuardHome(params: {
  script: string;
  curlExitCode: number;
  curlBody?: string;
  /** Pre-recorded disconnected kinds, one per line. */
  skipFileContent?: string;
}): Promise<GuardHome> {
  const dir = await mkdtemp(path.join(tmpdir(), "archestra-guard-run-"));
  const home = path.join(dir, "home");
  const bin = path.join(dir, "bin");
  const guardFile = path.join(home, CLAUDE_CODE_GUARD_SCRIPT_RELPATH);
  const skipFile = path.join(home, CLAUDE_CODE_GUARD_SKIP_RELPATH);
  const claudeLog = path.join(home, "claude-calls.log");
  const settingsFile = path.join(home, ".claude", "settings.json");

  await mkdir(path.dirname(guardFile), { recursive: true });
  await mkdir(path.dirname(settingsFile), { recursive: true });
  await mkdir(bin, { recursive: true });

  await writeFile(guardFile, params.script, "utf8");
  await chmod(guardFile, 0o755);
  if (params.skipFileContent !== undefined) {
    await writeFile(skipFile, params.skipFileContent, "utf8");
  }

  const profileBlock = `${PROFILE_SENTINEL}\n${CLAUDE_CODE_GUARD_MARKER_START}\nclaude() { command claude "$@"; }\n${CLAUDE_CODE_GUARD_MARKER_END}\n`;
  await writeFile(path.join(home, ".zshrc"), profileBlock, "utf8");
  await writeFile(path.join(home, ".bashrc"), profileBlock, "utf8");

  await writeFile(
    settingsFile,
    `${JSON.stringify(
      {
        env: {
          ANTHROPIC_BASE_URL: "https://archestra.example.com/v1/anthropic/p",
          ANTHROPIC_AUTH_TOKEN: "vk-secret",
          ANTHROPIC_CUSTOM_HEADERS:
            "X-Archestra-Agent-Id: claude-code\nX-Archestra-Virtual-Key: vk-secret",
          USER_OWNED_KEY: "keep-me",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const curlStub = path.join(bin, "curl");
  await writeFile(
    curlStub,
    `#!/bin/sh
case "$*" in *" -o "*) exit ${params.curlExitCode};; esac
printf '%s' '${params.curlBody ?? '{"mcp":"ok","llm":"ok"}'}'
exit ${params.curlExitCode}
`,
    "utf8",
  );
  const claudeStub = path.join(bin, "claude");
  await writeFile(
    claudeStub,
    `#!/bin/sh
echo "$@" >> "$HOME/claude-calls.log"
exit 0
`,
    "utf8",
  );
  await chmod(curlStub, 0o755);
  await chmod(claudeStub, 0o755);

  return {
    dir,
    home,
    guardFile,
    skipFile,
    claudeLog,
    settingsFile,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
    } as Record<string, string>,
  };
}

/**
 * Runs the guard with stdin/stdout as pipes, so it takes its non-interactive
 * path — the one automation hits — which must never prompt and always exit 0
 * (execFile rejects on non-zero exit, so a resolved promise IS that
 * assertion).
 */
async function runGuardNonInteractive(params: {
  script: string;
  curlExitCode: number;
  curlBody?: string;
  skipFileContent?: string;
  args?: string[];
  env?: Record<string, string>;
}): Promise<{ stdout: string; stderr: string; guardHome: GuardHome }> {
  const guardHome = await makeGuardHome(params);
  const { stdout, stderr } = await execFileAsync(
    "bash",
    [guardHome.guardFile, ...(params.args ?? [])],
    { env: { ...guardHome.env, ...params.env } },
  );
  return { stdout, stderr, guardHome };
}

/**
 * A python pty driver, so the guard sees a real tty on both ends and takes
 * its interactive path. `keys` is typed into the pty up front and sits in
 * the input queue until the guard reads it — during the retry ladder or at
 * the combined down prompt.
 */
const PTY_DRIVER = `import os, pty, select, sys
guard = sys.argv[1]
keys = sys.argv[2]
pid, master = os.forkpty()
if pid == 0:
    os.execvp("bash", ["bash", guard])
if keys:
    os.write(master, keys.encode())
out = b""
while True:
    try:
        r, _, _ = select.select([master], [], [], 30)
    except OSError:
        break
    if not r:
        os.kill(pid, 9)
        break
    try:
        chunk = os.read(master, 4096)
    except OSError:
        break
    if not chunk:
        break
    out += chunk
os.waitpid(pid, 0)
sys.stdout.buffer.write(out)
`;

async function runGuardInteractive(params: {
  script: string;
  curlExitCode: number;
  curlBody?: string;
  skipFileContent?: string;
  keys: string;
}): Promise<{ output: string; guardHome: GuardHome }> {
  const guardHome = await makeGuardHome(params);
  const driver = path.join(guardHome.dir, "pty.py");
  await writeFile(driver, PTY_DRIVER, "utf8");
  const { stdout } = await execFileAsync(
    "python3",
    [driver, guardHome.guardFile, params.keys],
    { env: guardHome.env, timeout: 60_000 },
  );
  return { output: stdout, guardHome };
}

async function readClaudeLog(guardHome: GuardHome): Promise<string> {
  return existsSync(guardHome.claudeLog)
    ? await readFile(guardHome.claudeLog, "utf8")
    : "";
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

  test("every down remote gets the failure copy; ONE prompt then covers them all", () => {
    const script = renderClaudeCodeStartupGuardScript(CTX);
    expect(script).toContain("✗ Failed to connect to");
    expect(script).toContain("'LLM proxy (profile-123)'");
    expect(script).toContain("'MCP gateway (prod-gateway)'");
    expect(script).toContain("'Skills marketplace (acme-skills)'");
    // a single down remote gets the classic Y/n removal prompt naming it…
    expect(script).toContain(
      "Disconnect ${GUARD_FAIL_NAMES[$1]} from Claude now? (Y/n)",
    );
    // …several down remotes get the remove-all-at-once variant
    expect(script).toContain(
      "Disconnect all $DOWN_COUNT unreachable resources from Claude now? (Y/n)",
    );
  });

  test("always offers a reconfigure entry under the rows; the down prompt routes [C] into the same menu", () => {
    const script = renderClaudeCodeStartupGuardScript(CTX);
    // the persistent [C] entry, present on every launch
    expect(script).toContain("To reconfigure your");
    expect(script).toContain("press [C]");
    expect(script).toContain("offer_reconfigure_tail");
    expect(script).toContain("reconfigure_menu");
    // it is drawn BEFORE the first probe (so it shows the whole run), not
    // just in the closing tail: the hint call sits right after the rows are
    // printed and immediately before the cursor moves back up to probe
    expect(script).toContain(
      `draw_reconfigure_hint\nprintf '\\033[%dA' "$ACTIVE_TOTAL"`,
    );
    // the healthy pass waits a beat for [C] before launching
    expect(script).toContain("RECONFIG_WAIT=1.5");
    expect(script).toContain('read -rs -n 1 -t "$RECONFIG_WAIT" key');
    // the down prompt offers the same menu as an alternative to (Y/n)
    expect(script).toContain("or press [C] to reconfigure");
    // the menu numbers every remote and disconnects the chosen one in place
    expect(script).toContain("Press 1-");
    expect(script).toContain("menu_disconnect_row");
  });

  test("encodes the retry contract on the single request: 15s budget, notice at 3s, hang-tight at 10s, own-line (Y/n) offer", () => {
    const script = renderClaudeCodeStartupGuardScript(CTX);
    expect(script).toContain("RETRY_TOTAL_SECONDS=15");
    expect(script).toContain("NOTICE_AFTER_SECONDS=3");
    expect(script).toContain("HANG_TIGHT_AFTER_SECONDS=10");
    expect(script).toContain("few more seconds, hang tight...");
    expect(script).toContain("trying to connect...");
    // the disconnect offer sits two lines below the block — the persistent
    // [C] hint takes +1, this (Y/n) offer +2 — so both stay visible, drawn
    // via cursor save/restore so the dots keep appending to the row above
    expect(script).toContain(
      "Disconnect all $ACTIVE_TOTAL unreachable resources from Claude now? (Y/n)",
    );
    expect(script).toContain(
      "printf '\\033[s\\033[%dB\\r\\033[2K%s \\033[u' \"$((ACTIVE_TOTAL + 2))\"",
    );
    expect(script).toContain("next_delay=$((next_delay * 2))");
    expect(script).toContain("RANDOM % 2");
    // the budget running out downs everything
    expect(script).toContain("HEALTH_STATE='down'");
  });

  test("paces every check with ~0.75s of appended dots, on the alternate screen", () => {
    const script = renderClaudeCodeStartupGuardScript(CTX);
    // ~0.75s per row, one appended dot per ~250ms tick — append-only output
    // cannot flicker (glyph spinners strobed on Windows Terminal)
    expect(script).toContain("MIN_CHECK_FRAMES=3");
    expect(script).toContain("FRAME_SLEEP=0.25");
    expect(script).toContain("spin_tick()");
    // a tick appends; it never clears or rewrites the line
    expect(script).not.toMatch(/spin_tick\(\) \{[^}]*2K/);
    // every row is visible from the start — pending rows dim below the
    // probing one, two leading spaces reserving the glyph column so text
    // aligns across pending, probing, and probed rows
    expect(script).toContain(`printf '  %s%s%s\\n' "$C_DIM"`);
    expect(script).toContain(`printf '\\033[%dA' "$ACTIVE_TOTAL"`);
    expect(script).toContain("printf '  %s' \"$1\"");
    // alternate screen in, restored on ANY exit — the terminal stays clean
    // after claude exits
    expect(script).toContain("\\033[?1049h");
    expect(script).toContain(
      `trap 'stty echo </dev/tty 2>/dev/null; printf "\\033[?1049l"' EXIT`,
    );
    // echo off for the whole interactive run so keys buffered during the
    // probe animation leave no smudge
    expect(script).toContain("stty -echo </dev/tty");
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
    expect(whiteLabel).toContain("'Acme AI'");
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
    // every interactive path funnels through finish_guard (dwell + exit 0)
    expect(script.trimEnd().endsWith("finish_guard")).toBe(true);
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
    expect(stderr).toContain("failed to connect to LLM proxy (profile-123)");
    expect(stderr).toContain("failed to connect to MCP gateway (prod-gateway)");
    expect(stderr).toContain(
      "failed to connect to Skills marketplace (acme-skills)",
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
    expect(stderr).toContain("failed to connect to LLM proxy (profile-123)");
    expect(stderr).toContain("failed to connect to MCP gateway (prod-gateway)");
    // endpoint reachable => the same-origin skills marketplace is fine
    expect(stderr).not.toContain("Skills marketplace");
  });

  test("one down resource warns only for itself", async () => {
    const { stderr } = await runGuardNonInteractive({
      script: renderClaudeCodeStartupGuardScript(CTX),
      curlExitCode: 0,
      curlBody: '{"mcp":"down","llm":"ok"}',
    });
    expect(stderr).toContain("failed to connect to MCP gateway (prod-gateway)");
    expect(stderr).not.toContain("LLM proxy");
  });

  test("down markers match pretty-printed JSON too (whitespace-normalized body)", async () => {
    const { stderr } = await runGuardNonInteractive({
      script: renderClaudeCodeStartupGuardScript(CTX),
      curlExitCode: 0,
      curlBody: '{"mcp": "down", "llm": "ok"}',
    });
    expect(stderr).toContain("failed to connect to MCP gateway (prod-gateway)");
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

  test("a remote the guard already disconnected is never re-checked or re-flagged", async () => {
    // The platform still reports the gateway down (it was deleted there),
    // but a previous launch already disconnected it from Claude Code — the
    // skip file must silence it for good instead of re-prompting forever.
    const { stdout, stderr } = await runGuardNonInteractive({
      script: renderClaudeCodeStartupGuardScript(CTX),
      curlExitCode: 0,
      curlBody: '{"mcp":"down","llm":"ok"}',
      skipFileContent: "mcp\n",
    });
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });

  test("with every remote already disconnected the guard uninstalls itself and gets out of the way", async () => {
    const { stdout, stderr, guardHome } = await runGuardNonInteractive({
      script: renderClaudeCodeStartupGuardScript(CTX),
      curlExitCode: 7,
      skipFileContent: "proxy\nmcp\nskills\n",
    });
    expect(stdout).toBe("");
    expect(stderr).toBe("");
    expect(existsSync(guardHome.guardFile)).toBe(false);
    expect(existsSync(guardHome.skipFile)).toBe(false);
    for (const profile of [".zshrc", ".bashrc"]) {
      const content = await readFile(
        path.join(guardHome.home, profile),
        "utf8",
      );
      expect(content).not.toContain(CLAUDE_CODE_GUARD_MARKER_START);
      expect(content).toContain(PROFILE_SENTINEL);
    }
  });

  test("interactive, platform unreachable, y during the wait: disconnects EVERYTHING and removes the guard itself", async () => {
    const { output, guardHome } = await runGuardInteractive({
      script: renderClaudeCodeStartupGuardScript(CTX),
      curlExitCode: 7,
      keys: "y",
    });
    // every remote's connect step is reversed…
    const log = await readClaudeLog(guardHome);
    expect(log).toContain("mcp remove --scope user prod_gateway");
    expect(log).toContain("mcp remove --scope local prod_gateway");
    expect(log).toContain("plugin marketplace remove acme-skills");
    const settings = JSON.parse(await readFile(guardHome.settingsFile, "utf8"));
    expect(settings.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(settings.env.USER_OWNED_KEY).toBe("keep-me");
    // …and with nothing left to check, the guard removes itself entirely:
    // script, skip file, and the profile wrapper blocks
    expect(existsSync(guardHome.guardFile)).toBe(false);
    expect(existsSync(guardHome.skipFile)).toBe(false);
    for (const profile of [".zshrc", ".bashrc"]) {
      const content = await readFile(
        path.join(guardHome.home, profile),
        "utf8",
      );
      expect(content).not.toContain(CLAUDE_CODE_GUARD_MARKER_START);
      expect(content).toContain(PROFILE_SENTINEL);
    }
    // the self-removal is silent — no trailing explainer after the
    // Disconnected rows
    expect(output).toContain("Disconnected Skills marketplace (acme-skills)");
    expect(output).not.toContain("Nothing connected is left to check");
  });

  test("interactive, one remote down, d at the prompt: disconnects only it and keeps the guard for the rest", async () => {
    const { output, guardHome } = await runGuardInteractive({
      script: renderClaudeCodeStartupGuardScript(CTX),
      curlExitCode: 0,
      curlBody: '{"mcp":"down","llm":"ok"}',
      keys: "y",
    });
    expect(output).toContain("Failed to connect to MCP gateway (prod-gateway)");
    expect(output).toContain(
      "Disconnect MCP gateway (prod-gateway) from Claude now? (Y/n)",
    );
    expect(output).toContain("Disconnected MCP gateway (prod_gateway)");
    const log = await readClaudeLog(guardHome);
    expect(log).toContain("mcp remove --scope user prod_gateway");
    expect(log).not.toContain("plugin marketplace remove");
    // the proxy stays wired up
    const settings = JSON.parse(await readFile(guardHome.settingsFile, "utf8"));
    expect(settings.env.ANTHROPIC_BASE_URL).toBeDefined();
    // guard survives (other remotes still connected) and remembers the
    // disconnect so later launches skip the gateway
    expect(existsSync(guardHome.guardFile)).toBe(true);
    expect(await readFile(guardHome.skipFile, "utf8")).toBe("mcp\n");
    const zshrc = await readFile(path.join(guardHome.home, ".zshrc"), "utf8");
    expect(zshrc).toContain(CLAUDE_CODE_GUARD_MARKER_START);
  });

  test("interactive, several remotes down: ONE prompt disconnects them all at once", async () => {
    const { output, guardHome } = await runGuardInteractive({
      script: renderClaudeCodeStartupGuardScript(CTX),
      curlExitCode: 0,
      curlBody: '{"mcp":"down","llm":"down"}',
      // Enter alone accepts the (Y/n) default: remove
      keys: "\r",
    });
    expect(output).toContain("Failed to connect to LLM proxy (profile-123)");
    expect(output).toContain("Failed to connect to MCP gateway (prod-gateway)");
    expect(output).toContain(
      "Disconnect all 2 unreachable resources from Claude now? (Y/n)",
    );
    const log = await readClaudeLog(guardHome);
    expect(log).toContain("mcp remove --scope user prod_gateway");
    expect(log).not.toContain("plugin marketplace remove");
    const settings = JSON.parse(await readFile(guardHome.settingsFile, "utf8"));
    expect(settings.env.ANTHROPIC_BASE_URL).toBeUndefined();
    // skills is still healthy and connected, so the guard stays installed
    expect(existsSync(guardHome.guardFile)).toBe(true);
    const skip = await readFile(guardHome.skipFile, "utf8");
    expect(skip).toContain("proxy");
    expect(skip).toContain("mcp");
    expect(skip).not.toContain("skills");
  });

  test("interactive, down remotes skipped: nothing is disconnected and nothing is remembered", async () => {
    const { output, guardHome } = await runGuardInteractive({
      script: renderClaudeCodeStartupGuardScript(CTX),
      curlExitCode: 0,
      curlBody: '{"mcp":"down","llm":"ok"}',
      keys: "n",
    });
    expect(output).toContain("Skipped");
    expect(await readClaudeLog(guardHome)).toBe("");
    expect(existsSync(guardHome.skipFile)).toBe(false);
    expect(existsSync(guardHome.guardFile)).toBe(true);
  });

  test("interactive, all healthy, [C] opens the menu; a number disconnects that (healthy) remote in place", async () => {
    // everything is reachable, but the user still opens the reconfigure menu
    // and removes the LLM proxy — row 1 — then leaves with Enter. NOTE: the
    // forkpty harness re-runs the guard once under node, so assert only what
    // holds regardless of pass count (skills always stays connected, so the
    // guard survives either way) — the same immunity the tests above rely on.
    const { output, guardHome } = await runGuardInteractive({
      script: renderClaudeCodeStartupGuardScript(CTX),
      curlExitCode: 0,
      curlBody: '{"mcp":"ok","llm":"ok"}',
      keys: "c1\r",
    });
    expect(output).toContain(
      "To reconfigure your Archestra connection press [C]",
    );
    // the numbered menu opened (the number glyph carries its own color, so
    // assert the footer that names the range instead of the split "[1] …")
    expect(output).toContain("Press 1-3 to disconnect a resource from Claude");
    // the chosen remote's row lands on the disconnected check, in place
    expect(output).toContain("Disconnected LLM proxy (Anthropic)");
    // the healthy proxy's settings keys are stripped, the user's own key stays
    const settings = JSON.parse(await readFile(guardHome.settingsFile, "utf8"));
    expect(settings.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(settings.env.USER_OWNED_KEY).toBe("keep-me");
    // the proxy is remembered as disconnected, and the guard survives because
    // the skills marketplace is still connected
    expect(await readFile(guardHome.skipFile, "utf8")).toContain("proxy");
    expect(existsSync(guardHome.guardFile)).toBe(true);
  });

  test("interactive, [C] menu, removing every remote uninstalls the guard entirely", async () => {
    const { guardHome } = await runGuardInteractive({
      script: renderClaudeCodeStartupGuardScript(CTX),
      curlExitCode: 0,
      curlBody: '{"mcp":"ok","llm":"ok"}',
      // open the menu, then disconnect rows 1, 2 and 3
      keys: "c123",
    });
    const log = await readClaudeLog(guardHome);
    expect(log).toContain("mcp remove --scope user prod_gateway");
    expect(log).toContain("plugin marketplace remove acme-skills");
    // nothing connected is left, so the guard removes itself entirely
    expect(existsSync(guardHome.guardFile)).toBe(false);
    expect(existsSync(guardHome.skipFile)).toBe(false);
    for (const profile of [".zshrc", ".bashrc"]) {
      const content = await readFile(
        path.join(guardHome.home, profile),
        "utf8",
      );
      expect(content).not.toContain(CLAUDE_CODE_GUARD_MARKER_START);
      expect(content).toContain(PROFILE_SENTINEL);
    }
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
    // a fresh connect re-arms checks a previous guard disconnected
    expect(section).toContain(
      `rm -f "$HOME/${CLAUDE_CODE_GUARD_SKIP_RELPATH}"`,
    );
    // wrapper always falls through to the real binary
    expect(section).toContain('command claude "$@"');
    // strip-then-append keeps re-runs from duplicating the block
    expect(section).toContain("awk -v start=");
  });
});
