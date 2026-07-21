import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  CLAUDE_CODE_CLIENT_ID,
  CODEX_CLIENT_ID,
  EXTERNAL_AGENT_ID_HEADER,
} from "@archestra/shared";
import { describe, expect, test } from "vitest";
import {
  buildSetupCommand,
  proxyBaseUrlToOrigin,
  renderSetupScript,
  type SetupScriptContext,
} from "@/services/connection-setup-script";

const execFileAsync = promisify(execFile);

/** The client-attribution header line the Claude Code setup script emits. */
const AGENT_ID_HEADER_LINE = `${EXTERNAL_AGENT_ID_HEADER}: ${CLAUDE_CODE_CLIENT_ID}`;

/** The client-attribution header line the Codex setup script writes to config.toml. */
const CODEX_AGENT_ID_TOML_LINE = `"${EXTERNAL_AGENT_ID_HEADER}" = "${CODEX_CLIENT_ID}"`;

const MCP = {
  serverName: "prod_gateway",
  url: "https://archestra.example.com/v1/mcp/prod-gateway",
};

const PROXY = {
  authMode: "virtual-key" as const,
  provider: "anthropic" as const,
  providerLabel: "Anthropic",
  url: "https://archestra.example.com/v1/anthropic/profile-123",
  proxyName: "default_proxy",
  virtualKey: "arch_deadbeefcafe",
  virtualKeyName: "Connection setup — user@example.com",
  passthroughVirtualKey: null,
};

/**
 * Claude Code's Anthropic subscription passthrough: no provider credential is
 * injected (the subscription token passes through), only the attribution header.
 */
const ANTHROPIC_PASSTHROUGH_PROXY = {
  authMode: "provider-key" as const,
  provider: "anthropic" as const,
  providerLabel: "Anthropic",
  url: "https://archestra.example.com/v1/anthropic/profile-123",
  proxyName: "default_proxy",
  virtualKey: null,
  virtualKeyName: null,
  passthroughVirtualKey: "arch_passthroughcafe",
};

/**
 * Codex ChatGPT-subscription passthrough: no virtual key credential is injected
 * (Codex keeps its own login), so only the attribution headers are emitted —
 * including the passthrough key that attributes the request to the user.
 */
const OPENAI_PASSTHROUGH_PROXY = {
  authMode: "provider-key" as const,
  provider: "openai" as const,
  providerLabel: "OpenAI",
  url: "https://archestra.example.com/v1/openai/profile-123",
  proxyName: "default_proxy",
  virtualKey: null,
  virtualKeyName: null,
  passthroughVirtualKey: "arch_passthroughcafe",
};

const GITHUB_COPILOT_PROXY = {
  authMode: "provider-key" as const,
  provider: "github-copilot" as const,
  providerLabel: "GitHub Copilot",
  url: "https://archestra.example.com/v1/github-copilot/profile-123",
  proxyName: "default_proxy",
  virtualKey: null,
  virtualKeyName: null,
  passthroughVirtualKey: null,
  githubCopilot: {
    tokenExchangeUrl:
      "https://api.github.example.com/copilot_internal/v2/token",
    deviceAuthBaseUrl: "https://github.example.com",
    clientId: "Iv1.testclientid",
  },
};

const SKILLS = {
  cloneUrl:
    "https://archestra.example.com/skill-marketplace/archestra_skl_token123/repo.git",
  marketplaceName: "acme-skills",
};

function fullContext(
  clientId: SetupScriptContext["clientId"],
  platform: SetupScriptContext["platform"] = "macos",
): SetupScriptContext {
  return {
    clientId,
    platform,
    appName: "Archestra",
    mcp: MCP,
    proxy:
      clientId === "claude-code"
        ? PROXY
        : { ...PROXY, provider: "openai", providerLabel: "OpenAI" },
    skills: SKILLS,
  };
}

/** Every rendered variant must be parseable bash. */
async function expectValidBash(script: string): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "archestra-script-"));
  const file = path.join(dir, "setup.sh");
  try {
    await writeFile(file, script, "utf8");
    await execFileAsync("bash", ["-n", file]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Runs the real ~/.claude/settings.json merge (the python extracted from the
 * rendered claude-code passthrough script) against a temp HOME, so the
 * append/dedupe behavior is asserted end-to-end rather than by string match.
 */
async function runClaudeSettingsMerge(params: {
  existing: object | null;
}): Promise<{ env: { ANTHROPIC_CUSTOM_HEADERS: string } }> {
  const script = renderSetupScript({
    ...fullContext("claude-code"),
    mcp: null,
    skills: null,
    proxy: ANTHROPIC_PASSTHROUGH_PROXY,
  });
  const match = script.match(
    /python3 - <<'ARCHESTRA_PY'\n([\s\S]*?)\nARCHESTRA_PY/,
  );
  if (!match) throw new Error("could not extract the settings-merge python");
  const home = await mkdtemp(path.join(tmpdir(), "archestra-home-"));
  try {
    await mkdir(path.join(home, ".claude"), { recursive: true });
    const settingsPath = path.join(home, ".claude", "settings.json");
    if (params.existing) {
      await writeFile(settingsPath, JSON.stringify(params.existing), "utf8");
    }
    const pyFile = path.join(home, "merge.py");
    await writeFile(pyFile, match[1], "utf8");
    await execFileAsync("python3", [pyFile], {
      env: {
        ...process.env,
        HOME: home,
        // The script exports one "Name: Value" per line — the client-attribution
        // header plus the passthrough key header — so the merge dedupes both.
        ARCHESTRA_APPEND_ANTHROPIC_CUSTOM_HEADERS: `${AGENT_ID_HEADER_LINE}\nX-Archestra-Virtual-Key: arch_passthroughcafe`,
      },
    });
    return JSON.parse(await readFile(settingsPath, "utf8"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * A python pty driver that reproduces the exact `curl | bash` shape inside a
 * terminal: bash reads the script from a pipe (so its stdin is NOT a tty, and
 * every command inherits that pipe), while its stdout IS a real tty. The driver
 * also answers terminal probes the way an emulator would, so any probe reply
 * that leaks would show up in the captured output.
 */
const PTY_DRIVER = `import os, pty, select, sys, time, re
script_path = sys.argv[1]
r, w = os.pipe()
os.write(w, b"FROM-THE-CURL-PIPE\\n" * 20); os.close(w)
pid, master = os.forkpty()
if pid == 0:
    os.dup2(r, 0)                      # stdin = the download pipe (curl | bash)
    os.execvp("bash", ["bash", script_path])
    os._exit(1)
out = b""; end = time.time() + 20
while time.time() < end:
    rr, _, _ = select.select([master], [], [], 0.3)
    if rr:
        try: d = os.read(master, 65536)
        except OSError: break
        if not d: break
        out += d
        reply = b""
        if b"\\x1b]11;?" in d: reply += b"\\x1b]11;rgb:1e1e/1e1e/1e1e\\x1b\\\\"
        if re.search(rb"\\x1b\\[c", d): reply += b"\\x1b[?1;2c"
        if reply: os.write(master, reply)
    if os.waitpid(pid, os.WNOHANG)[0] != 0:
        time.sleep(0.3)
        rr, _, _ = select.select([master], [], [], 0.3)
        if rr:
            try: out += os.read(master, 65536)
            except OSError: pass
        break
try: os.kill(pid, 9)
except Exception: pass
sys.stdout.write(out.decode("latin1"))`;

/** The rendered helper block (color + terminal guard + `say`/`cli`/… helpers). */
function helperBlock(): string {
  return renderSetupScript(fullContext("claude-code"))
    .split("set -euo pipefail\n\n")[1]
    .split("\n\ncat <<'ARCHESTRA_BANNER'")[0];
}

/**
 * Runs arbitrary bash under {@link PTY_DRIVER} — i.e. as `curl | bash` would,
 * with the download pipe on stdin and a live tty on stdout, and an emulator that
 * answers terminal probes. Returns everything the terminal saw (escape bytes
 * shown as `^[`).
 */
async function runBashInTerminal(script: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "archestra-cli-"));
  try {
    const scriptFile = path.join(dir, "run.sh");
    const driver = path.join(dir, "pty.py");
    await writeFile(scriptFile, script, "utf8");
    await writeFile(driver, PTY_DRIVER, "utf8");
    const { stdout } = await execFileAsync("python3", [driver, scriptFile]);
    return stdout.replaceAll("\x1b", "^[");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Runs `body` after the real rendered helper block. */
function runInTerminal(body: string): Promise<string> {
  return runBashInTerminal(`set -euo pipefail\n${helperBlock()}\n${body}\n`);
}

const ALL_CLIENTS = ["claude-code", "codex", "copilot-cli", "cursor"] as const;

describe("renderSetupScript", () => {
  for (const clientId of ALL_CLIENTS) {
    test(`${clientId}: full script is valid bash with no placeholders`, async () => {
      const script = renderSetupScript(fullContext(clientId));

      await expectValidBash(script);
      expect(script).toContain("set -euo pipefail");
      // Every heredoc must use a quoted delimiter: unquoted heredocs expand
      // $(...) in embedded data (URLs derive from user-supplied baseUrl).
      expect(script).not.toMatch(/<<[ \t]*ARCHESTRA/);
      // No leftover template placeholders.
      expect(script).not.toMatch(/<your-[a-z-]+>/);
      expect(script).not.toContain("archestra_TOKEN");
      // Secrets are injected.
      expect(script).toContain(PROXY.virtualKey);
      expect(script).toContain(SKILLS.cloneUrl);
      // Revocation guidance present.
      expect(script).toContain(PROXY.virtualKeyName);
      expect(script).toContain(SKILLS.marketplaceName);
    });

    test(`${clientId}: client CLIs never drive the terminal directly`, () => {
      const script = renderSetupScript(fullContext(clientId));
      // A client CLI renders a full-screen TUI when its stdout is a tty: it
      // probes the terminal (replies echo in as "rgb:1e1e/1e1e/1e1e" / "^[[?1;2c")
      // and positions text with absolute cursor moves that assume it owns the
      // screen, cascading every line to the right under `curl | bash`. Every
      // invocation must go through `cli`, which detaches stdout from the tty.
      const bareInvocations = script
        .split("\n")
        .map((line) => line.trim())
        .filter((line) =>
          /^(?:if\s+!\s+|!\s+)?(?:claude|codex|copilot)\s/.test(line),
        );
      expect(bareInvocations).toEqual([]);
    });

    test(`${clientId}: sections are omitted when not selected`, async () => {
      const script = renderSetupScript({
        clientId,
        platform: "macos",
        appName: "Archestra",
        mcp: MCP,
        proxy: null,
        skills: null,
      });

      await expectValidBash(script);
      expect(script).toContain(MCP.url);
      expect(script).not.toContain(PROXY.virtualKey);
      expect(script).not.toContain("marketplace");
    });
  }

  test("bash: `cli` detaches a command's stdout from the terminal", async () => {
    // Control + subject in one run. At script level stdout is a real tty (the
    // pty harness is faithful), so the control prints TTY-AT-SCRIPT. Through
    // `cli` the same probe sees a pipe, so it prints PIPE-VIA-CLI — that non-tty
    // stdout is what stops a client CLI probing the terminal or positioning text
    // with absolute cursor moves. `cat` reads stdin and gets EOF from /dev/null,
    // so the download pipe ("FROM-THE-CURL-PIPE") is never read as input.
    const probe = `[ -t 1 ] && echo TTY-AT-SCRIPT
cli sh -c '[ -t 1 ] && echo TTY-VIA-CLI || echo PIPE-VIA-CLI; cat'`;
    const out = await runInTerminal(probe);
    expect(out).toContain("TTY-AT-SCRIPT");
    expect(out).toContain("PIPE-VIA-CLI");
    expect(out).not.toContain("TTY-VIA-CLI");
    expect(out).not.toContain("FROM-THE-CURL-PIPE");
  });

  test("bash: `cli` leaks no terminal probe replies into the output", async () => {
    // Model a client CLI faithfully: it probes the terminal only when stdout is
    // a tty. Run bare (stdout = tty) it fires the probe and the harness's reply
    // echoes in as stray "rgb:1e1e/1e1e/1e1e" / "^[[?1;2c" text — the reported
    // bug. Through `cli` (stdout = pipe) the tty check fails, so nothing probes
    // and nothing leaks.
    const probe = `if [ -t 1 ]; then printf '\\033]11;?\\033[c'; fi; sleep 0.5`;

    const bare = await runInTerminal(`sh -c ${JSON.stringify(probe)}`);
    expect(bare).toContain("1e1e/1e1e/1e1e"); // harness answers, bare leaks

    const wrapped = await runInTerminal(`cli sh -c ${JSON.stringify(probe)}`);
    expect(wrapped).not.toContain("1e1e/1e1e/1e1e");
    expect(wrapped).not.toContain("^[[?1;2c");
  });

  test("bash: `cli` surfaces the command's failure through pipefail", async () => {
    // `cli` pipes stdout through cat; without `set -o pipefail` the pipeline
    // would mask a CLI failure behind cat's success, so `if ! cli ...` guards
    // (e.g. the skills-install fallback) would never fire.
    const out = await runInTerminal(
      `if ! cli sh -c 'exit 7'; then echo FAILURE-SEEN; fi`,
    );
    expect(out).toContain("FAILURE-SEEN");
  });

  test("bash: the script leaves the terminal's line discipline sane", async () => {
    // Regression: a CLI that grabbed the terminal (raw mode) leaves newline
    // translation (onlcr) off, so every line staircases to the right — including
    // a plain banner printed before any CLI runs. The helper block guards both
    // ends: it resets the terminal on entry (healing a terminal a *previous* run
    // wedged) and, via an EXIT trap, restores it on exit (so a CLI that wedges it
    // *mid-run* never leaves it broken for the next command).
    const state = (label: string) =>
      `printf '${label}:'; stty -a </dev/tty | grep -o -- '-\\?onlcr' | head -1`;

    // Sanity: the harness really can wedge the terminal (nothing heals it here).
    const wedged = await runBashInTerminal(
      `stty -onlcr </dev/tty\n${state("BARE")}\n`,
    );
    expect(wedged).toContain("BARE:-onlcr");

    // Start wedged (inherited). Inside a subshell running the helper block, entry
    // reset should have healed it (ENTRY); then re-wedge to mimic a CLI grabbing
    // the terminal mid-run; after the subshell exits its trap should heal it
    // again (AFTER). Both points must read `onlcr`, isolating the two guards.
    const helpers = helperBlock();
    const out = await runBashInTerminal(
      `stty -onlcr </dev/tty\n(\nset -euo pipefail\n${helpers}\n${state("ENTRY")}\nstty -onlcr </dev/tty\n)\n${state("AFTER")}\n`,
    );
    expect(out).toContain("ENTRY:onlcr"); // entry reset healed the inherited wedge
    expect(out).toContain("AFTER:onlcr"); // exit trap healed the mid-run wedge
  });

  test("claude-code: registers gateway idempotently and merges settings.json", () => {
    const script = renderSetupScript(fullContext("claude-code"));
    // The terminal is reset on entry and on exit so a raw-mode-wedged terminal
    // is healed and never handed back broken.
    expect(script).toContain("stty sane </dev/tty");
    expect(script).toContain(
      "trap 'stty sane </dev/tty 2>/dev/null || true' EXIT",
    );
    // Client CLIs run detached from the tty so they print plain linear text.
    expect(script).toContain('cli() { "$@" </dev/null 2>&1 | cat; }');
    // Remove per-scope: a scopeless `claude mcp remove` errors ("exists in
    // multiple scopes") when both a local and user entry exist, which would
    // abort the script under `set -euo pipefail`. Add at user scope so the
    // gateway is visible from every directory, not just where connect ran.
    expect(script).toContain(
      "cli claude mcp remove --scope local 'prod_gateway' >/dev/null 2>&1 || true",
    );
    expect(script).toContain(
      "cli claude mcp remove --scope user 'prod_gateway' >/dev/null 2>&1 || true",
    );
    expect(script).toContain(
      `cli claude mcp add --scope user --transport http 'prod_gateway' '${MCP.url}'`,
    );
    expect(script).toContain("ANTHROPIC_BASE_URL");
    expect(script).toContain("ANTHROPIC_AUTH_TOKEN");
    expect(script).toContain(
      `cli claude plugin marketplace add '${SKILLS.cloneUrl}'`,
    );
    // The skill bundle is installed by the script, not via a manual browse step.
    expect(script).toContain(
      `cli claude plugin install '${SKILLS.marketplaceName}@${SKILLS.marketplaceName}'`,
    );
    expect(script).not.toContain("marketplace browse");
    // python3 fallback prints a manual snippet rather than failing.
    expect(script).toContain("python3 not found");
    // Next steps name the exact command and server for the OAuth handshake.
    expect(script).toContain("claude /mcp");
    expect(script).toContain(`select "${MCP.serverName}"`);
  });

  test("claude-code (windows): next steps carry the same OAuth guidance", () => {
    const script = renderSetupScript(fullContext("claude-code", "windows"));
    expect(script).toContain("claude /mcp");
    expect(script).toContain(`select "${MCP.serverName}"`);
  });

  test("claude-code bedrock: keeps the bearer token out of settings.json", () => {
    const script = renderSetupScript({
      ...fullContext("claude-code"),
      proxy: {
        ...PROXY,
        provider: "bedrock",
        providerLabel: "Bedrock",
        url: "https://archestra.example.com/v1/bedrock/profile-123",
      },
    });
    expect(script).toContain("CLAUDE_CODE_USE_BEDROCK");
    expect(script).toContain("ANTHROPIC_BEDROCK_BASE_URL");
    expect(script).toContain("AWS_BEARER_TOKEN_BEDROCK");
    // The secret goes to the profile-paste block, not the settings merge env.
    expect(script).not.toContain(`ARCHESTRA_SET_ENV_AWS_BEARER_TOKEN_BEDROCK`);
    // The client-attribution header rides along for Bedrock too (no passthrough
    // key in virtual-key mode, so only the agent-id line).
    expect(script).toContain(
      "export ARCHESTRA_APPEND_ANTHROPIC_CUSTOM_HEADERS",
    );
    expect(script).toContain(AGENT_ID_HEADER_LINE);
    expect(script).not.toContain("X-Archestra-Virtual-Key");
  });

  test("claude-code anthropic passthrough: injects the attribution header, not an auth token", async () => {
    const script = renderSetupScript({
      ...fullContext("claude-code"),
      mcp: null,
      skills: null,
      proxy: ANTHROPIC_PASSTHROUGH_PROXY,
    });
    await expectValidBash(script);
    // Both attribution headers are appended into ANTHROPIC_CUSTOM_HEADERS (colon
    // form), passed via env so the token never lands in argv: the client-id
    // header and the passthrough virtual-key header.
    expect(script).toContain("ARCHESTRA_APPEND_ANTHROPIC_CUSTOM_HEADERS");
    expect(script).toContain(AGENT_ID_HEADER_LINE);
    expect(script).toContain("X-Archestra-Virtual-Key: arch_passthroughcafe");
    expect(script).toContain("ANTHROPIC_CUSTOM_HEADERS");
    // The base URL is still set; the subscription token passes through, so no
    // ANTHROPIC_AUTH_TOKEN is injected (that would override the subscription).
    expect(script).toContain("ANTHROPIC_BASE_URL");
    expect(script).not.toContain("ANTHROPIC_AUTH_TOKEN");
  });

  test("claude-code anthropic passthrough: always sends the client-id header, no virtual key when there's no passthrough key", () => {
    const script = renderSetupScript({
      ...fullContext("claude-code"),
      mcp: null,
      skills: null,
      proxy: { ...ANTHROPIC_PASSTHROUGH_PROXY, passthroughVirtualKey: null },
    });
    // The client-attribution header is always exported (it is not a secret and
    // does not depend on the passthrough key); only the virtual-key line is gated.
    expect(script).toContain(
      "export ARCHESTRA_APPEND_ANTHROPIC_CUSTOM_HEADERS",
    );
    expect(script).toContain(AGENT_ID_HEADER_LINE);
    expect(script).not.toContain("X-Archestra-Virtual-Key");
    expect(script).toContain("ANTHROPIC_BASE_URL");
  });

  test("claude-code bedrock passthrough: injects both attribution headers, no bearer token", async () => {
    const script = renderSetupScript({
      ...fullContext("claude-code"),
      mcp: null,
      skills: null,
      proxy: {
        ...ANTHROPIC_PASSTHROUGH_PROXY,
        provider: "bedrock",
        providerLabel: "Bedrock",
        url: "https://archestra.example.com/v1/bedrock/profile-123",
      },
    });
    await expectValidBash(script);
    // ANTHROPIC_CUSTOM_HEADERS applies to the Bedrock transport too, so both
    // attribution headers are appended exactly like the Anthropic section.
    expect(script).toContain(
      "export ARCHESTRA_APPEND_ANTHROPIC_CUSTOM_HEADERS",
    );
    expect(script).toContain(AGENT_ID_HEADER_LINE);
    expect(script).toContain("X-Archestra-Virtual-Key: arch_passthroughcafe");
    expect(script).toContain("CLAUDE_CODE_USE_BEDROCK");
    // Passthrough: the user's own AWS credentials keep working — no bearer
    // token export is printed.
    expect(script).not.toContain("AWS_BEARER_TOKEN_BEDROCK");
  });

  test("claude-code passthrough merge: preserves existing headers, no duplicate on re-run", async () => {
    // Existing user header must survive; ours is appended once and replaced
    // (not duplicated) on a second run.
    const first = await runClaudeSettingsMerge({
      existing: { env: { ANTHROPIC_CUSTOM_HEADERS: "X-Foo: bar" } },
    });
    expect(first.env.ANTHROPIC_CUSTOM_HEADERS).toContain("X-Foo: bar");
    expect(first.env.ANTHROPIC_CUSTOM_HEADERS).toContain(AGENT_ID_HEADER_LINE);
    expect(first.env.ANTHROPIC_CUSTOM_HEADERS).toContain(
      "X-Archestra-Virtual-Key: arch_passthroughcafe",
    );

    const second = await runClaudeSettingsMerge({ existing: first });
    const lines = second.env.ANTHROPIC_CUSTOM_HEADERS.split("\n");
    // Both of our headers appear exactly once after a re-run; the user's stays.
    expect(lines.filter((l) => l.startsWith("X-Archestra-Agent-Id:"))).toEqual([
      AGENT_ID_HEADER_LINE,
    ]);
    expect(
      lines.filter((l) => l.startsWith("X-Archestra-Virtual-Key:")),
    ).toEqual(["X-Archestra-Virtual-Key: arch_passthroughcafe"]);
    expect(second.env.ANTHROPIC_CUSTOM_HEADERS).toContain("X-Foo: bar");
  });

  test("codex: manages a marker-delimited TOML block and logs in via stdin", () => {
    const script = renderSetupScript(fullContext("codex"));
    expect(script).toContain("# >>> archestra:default_proxy >>>");
    expect(script).toContain("[model_providers.default_proxy]");
    expect(script).toContain('wire_api = "responses"');
    expect(script).toContain("requires_openai_auth = true");
    // Attribution parity with Claude Code: every proxied Codex request carries
    // the client-id header via config.toml's http_headers table.
    expect(script).toContain("[model_providers.default_proxy.http_headers]");
    expect(script).toContain(CODEX_AGENT_ID_TOML_LINE);
    // Virtual-key mode: the injected key carries user attribution, so no
    // separate passthrough-key header is written.
    expect(script).not.toContain('"X-Archestra-Virtual-Key"');
    expect(script).toContain(
      `printf '%s' "$ARCHESTRA_VIRTUAL_KEY" | codex login --with-api-key`,
    );
    // The virtual key is assigned to a variable, never an argv of codex.
    expect(script).not.toContain(
      `codex login --with-api-key ${PROXY.virtualKey}`,
    );
  });

  test("codex passthrough: attributes user + client via config.toml http_headers", () => {
    const script = renderSetupScript({
      ...fullContext("codex"),
      proxy: OPENAI_PASSTHROUGH_PROXY,
    });
    expect(script).toContain("[model_providers.default_proxy.http_headers]");
    expect(script).toContain(CODEX_AGENT_ID_TOML_LINE);
    // Passthrough mode: the user is attributed via the passthrough virtual key,
    // exactly like the Claude Code Anthropic-subscription passthrough.
    expect(script).toContain(
      '"X-Archestra-Virtual-Key" = "arch_passthroughcafe"',
    );
    // No credential is injected into config.toml — Codex keeps its own login.
    expect(script).toContain(
      "Codex keeps using your own OpenAI API key login.",
    );
    expect(script).not.toContain(
      `printf '%s' "$ARCHESTRA_VIRTUAL_KEY" | codex login --with-api-key`,
    );
  });

  test("copilot-cli: prints export lines instead of exporting into a dead shell", () => {
    const script = renderSetupScript(fullContext("copilot-cli"));
    expect(script).toContain('export COPILOT_PROVIDER_TYPE="openai"');
    expect(script).toContain("export COPILOT_PROVIDER_API_KEY=");
    expect(script).toContain("copilot mcp add --transport http");
    expect(script).toContain("copilot mcp get");
  });

  test("copilot-cli github-copilot passthrough: links GitHub in-script, token never in argv", async () => {
    const script = renderSetupScript({
      ...fullContext("copilot-cli"),
      proxy: GITHUB_COPILOT_PROXY,
    });
    await expectValidBash(script);

    // token reuse from the Copilot CLI's local config, then validation
    expect(script).toContain("github-copilot/apps.json");
    expect(script).toContain("github-copilot/hosts.json");
    expect(script).toContain("ghcp_validate");
    // device-flow endpoints + client id from the server-provided config
    expect(script).toContain("https://github.example.com/login/device/code");
    expect(script).toContain(
      "https://github.example.com/login/oauth/access_token",
    );
    expect(script).toContain('{"client_id":"Iv1.testclientid"');
    expect(script).toContain("urn:ietf:params:oauth:grant-type:device_code");
    // RFC 8628 poll semantics: slow_down backoff + expires_in deadline
    expect(script).toContain("slow_down) ghcp_interval=$((ghcp_interval + 5))");
    expect(script).toContain("ghcp_deadline");
    // the token travels via stdin curl config / printf, never argv
    expect(script).toContain(`printf 'header = "authorization: token %s"`);
    // never the well-known CI variable name
    expect(script).not.toContain("GITHUB_TOKEN");
    // export lines come from printf with the runtime token
    expect(script).toContain('"$ARCHESTRA_GHCP_TOKEN"');
    expect(script).toContain('export COPILOT_PROVIDER_TYPE="openai"');
  });

  test("copilot-cli github-copilot virtual-key: injects the virtual key, no device flow", async () => {
    const script = renderSetupScript({
      ...fullContext("copilot-cli"),
      proxy: {
        ...GITHUB_COPILOT_PROXY,
        authMode: "virtual-key" as const,
        virtualKey: "arch_deadbeefcafe",
        virtualKeyName: "Connection setup — user@example.com",
        githubCopilot: null,
      },
    });
    await expectValidBash(script);
    expect(script).toContain("'arch_deadbeefcafe'");
    expect(script).not.toContain("login/device/code");
    expect(script).not.toContain("ghcp_validate");
  });

  test("github-copilot passthrough without device-flow config throws", () => {
    expect(() =>
      renderSetupScript({
        ...fullContext("copilot-cli"),
        proxy: { ...GITHUB_COPILOT_PROXY, githubCopilot: null },
      }),
    ).toThrow(/device-flow configuration/);
  });

  test("github-copilot: hostile server values stay literal in the link section", async () => {
    const hostile = "https://github.example.com/$(touch /tmp/pwned)";
    const script = renderSetupScript({
      ...fullContext("copilot-cli"),
      proxy: {
        ...GITHUB_COPILOT_PROXY,
        url: `${hostile}/v1/github-copilot/profile-123`,
        githubCopilot: {
          tokenExchangeUrl: `${hostile}/token`,
          deviceAuthBaseUrl: hostile,
          clientId: `Iv1.$(touch /tmp/pwned)`,
        },
      },
    });
    await expectValidBash(script);
    expect(script).toContain(hostile);
    expect(script).not.toMatch(/<<[ \t]*ARCHESTRA/);
  });

  test("cursor: merges mcp.json without auth headers (OAuth) and prints manual proxy steps", () => {
    const script = renderSetupScript(fullContext("cursor"));
    expect(script).toContain("ARCHESTRA_MCP_SERVER_NAME");
    expect(script).not.toContain("Authorization");
    expect(script).toContain("Override OpenAI Base URL");
    expect(script).toContain("/add-plugin");
  });
});

describe("renderSetupScript (windows)", () => {
  for (const clientId of ALL_CLIENTS) {
    test(`${clientId}: renders PowerShell, not bash, with secrets injected`, () => {
      const script = renderSetupScript(fullContext(clientId, "windows"));

      // PowerShell, not bash.
      expect(script).not.toContain("#!/usr/bin/env bash");
      expect(script).not.toContain("set -euo pipefail");
      expect(script).toContain("$ErrorActionPreference = 'Stop'");
      expect(script).toContain("function Say($m)");
      expect(script).toContain("Write-Host");
      // No leftover template placeholders.
      expect(script).not.toMatch(/<your-[a-z-]+>/);
      // Secrets are injected.
      expect(script).toContain(PROXY.virtualKey);
      expect(script).toContain(SKILLS.cloneUrl);
      // Revocation guidance present.
      expect(script).toContain(PROXY.virtualKeyName);
      expect(script).toContain(SKILLS.marketplaceName);
    });

    test(`${clientId}: registers MCP idempotently (remove-then-add)`, () => {
      const script = renderSetupScript(fullContext(clientId, "windows"));
      const binaries: Record<string, string | null> = {
        "claude-code": "claude",
        codex: "codex",
        "copilot-cli": "copilot",
        cursor: null,
      };
      const binary = binaries[clientId];
      if (binary) {
        // The remove is wrapped in try/catch: under $ErrorActionPreference='Stop',
        // Windows PowerShell 5.1 promotes the "No MCP server named …" stderr line
        // (emitted when the server is not yet registered — e.g. a first run or a
        // renamed gateway) to a terminating error that 2>$null does not suppress,
        // which would abort the script before the add ever runs.
        if (clientId === "claude-code") {
          // Claude Code registers at user scope, so it removes per-scope: a
          // scopeless remove errors ("exists in multiple scopes") once both a
          // local and user entry exist, which would abort the script.
          expect(script).toContain(
            `try { ${binary} mcp remove --scope local 'prod_gateway' 2>$null | Out-Null } catch { }`,
          );
          expect(script).toContain(
            `try { ${binary} mcp remove --scope user 'prod_gateway' 2>$null | Out-Null } catch { }`,
          );
        } else {
          expect(script).toContain(
            `try { ${binary} mcp remove 'prod_gateway' 2>$null | Out-Null } catch { }`,
          );
        }
      }
    });
  }

  // Only the clients that write JSON/TOML config files take backups; copilot-cli
  // configures via CLI + environment variables, so it never touches a file.
  for (const clientId of ["claude-code", "codex", "cursor"] as const) {
    test(`${clientId}: backs up config once, never clobbering the pristine copy`, () => {
      const script = renderSetupScript(fullContext(clientId, "windows"));
      expect(script).toContain("-not (Test-Path ($arch_");
      expect(script).toContain(".archestra-backup");
    });
  }

  test("colors are NO_COLOR-guarded", () => {
    const script = renderSetupScript(fullContext("claude-code", "windows"));
    expect(script).toContain(
      "$ArchUseColor = [string]::IsNullOrEmpty($env:NO_COLOR)",
    );
    expect(script).toContain("-ForegroundColor Cyan");
    expect(script).toContain("-ForegroundColor Red");
  });

  test("claude-code: remove-then-add MCP and merge settings.json env", () => {
    const script = renderSetupScript(fullContext("claude-code", "windows"));
    expect(script).toContain(
      "try { claude mcp remove --scope local 'prod_gateway' 2>$null | Out-Null } catch { }",
    );
    expect(script).toContain(
      "try { claude mcp remove --scope user 'prod_gateway' 2>$null | Out-Null } catch { }",
    );
    expect(script).toContain(
      `claude mcp add --scope user --transport http 'prod_gateway' '${MCP.url}'`,
    );
    expect(script).toContain("ANTHROPIC_BASE_URL");
    expect(script).toContain("ANTHROPIC_AUTH_TOKEN");
    expect(script).toContain("ConvertTo-Json -Depth 32");
    expect(script).toContain(".claude\\settings.json");
  });

  test("claude-code anthropic passthrough: appends the attribution header (PowerShell)", () => {
    const script = renderSetupScript({
      ...fullContext("claude-code", "windows"),
      mcp: null,
      skills: null,
      proxy: ANTHROPIC_PASSTHROUGH_PROXY,
    });
    expect(script).toContain("ANTHROPIC_CUSTOM_HEADERS");
    expect(script).toContain(AGENT_ID_HEADER_LINE);
    expect(script).toContain("X-Archestra-Virtual-Key: arch_passthroughcafe");
    // Append/dedupe by header name, preserving the user's other headers.
    expect(script).toContain("-split ':',2");
    expect(script).toContain("$arch_hname");
    expect(script).toContain("ANTHROPIC_BASE_URL");
    // Subscription passes through — no auth token injected.
    expect(script).not.toContain("ANTHROPIC_AUTH_TOKEN");
  });

  test("claude-code bedrock passthrough: appends the attribution headers (PowerShell)", () => {
    const script = renderSetupScript({
      ...fullContext("claude-code", "windows"),
      mcp: null,
      skills: null,
      proxy: {
        ...ANTHROPIC_PASSTHROUGH_PROXY,
        provider: "bedrock",
        providerLabel: "Bedrock",
        url: "https://archestra.example.com/v1/bedrock/profile-123",
      },
    });
    expect(script).toContain("ANTHROPIC_CUSTOM_HEADERS");
    expect(script).toContain(AGENT_ID_HEADER_LINE);
    expect(script).toContain("X-Archestra-Virtual-Key: arch_passthroughcafe");
    expect(script).toContain("CLAUDE_CODE_USE_BEDROCK");
  });

  test("codex: marker-delimited TOML block dropped before append (idempotent)", () => {
    const script = renderSetupScript(fullContext("codex", "windows"));
    expect(script).toContain("# >>> archestra:default_proxy >>>");
    expect(script).toContain("[model_providers.default_proxy]");
    expect(script).toContain('wire_api = "responses"');
    // Attribution parity: the client-id header is written to config.toml.
    expect(script).toContain("[model_providers.default_proxy.http_headers]");
    expect(script).toContain(CODEX_AGENT_ID_TOML_LINE);
    // virtual key passed via variable + stdin, never argv.
    expect(script).toContain("$ArchVirtualKey | codex login --with-api-key");
    expect(script).not.toContain(
      `codex login --with-api-key ${PROXY.virtualKey}`,
    );
  });

  test("copilot-cli github-copilot passthrough: device flow via Invoke-RestMethod, token never in argv", () => {
    const script = renderSetupScript({
      ...fullContext("copilot-cli", "windows"),
      proxy: GITHUB_COPILOT_PROXY,
    });
    expect(script).toContain("function Test-ArchGhcp");
    expect(script).toContain("github-copilot\\apps.json");
    expect(script).toContain("https://github.example.com/login/device/code");
    expect(script).toContain(
      "https://github.example.com/login/oauth/access_token",
    );
    expect(script).toContain("urn:ietf:params:oauth:grant-type:device_code");
    expect(script).toContain("slow_down");
    expect(script).toContain("Invoke-RestMethod");
    // never the well-known CI variable name
    expect(script).not.toContain("GITHUB_TOKEN");
    // token only ever surfaces via a runtime variable in the export lines
    expect(script).toContain("$ArchGhcpToken");
  });

  test("cursor: merges mcp.json and prints manual model steps", () => {
    const script = renderSetupScript(fullContext("cursor", "windows"));
    expect(script).toContain(".cursor\\mcp.json");
    expect(script).toContain("mcpServers");
    expect(script).toContain("Override OpenAI Base URL");
    expect(script).toContain("/add-plugin");
  });

  test("github-copilot passthrough without device-flow config throws", () => {
    expect(() =>
      renderSetupScript({
        ...fullContext("copilot-cli", "windows"),
        proxy: { ...GITHUB_COPILOT_PROXY, githubCopilot: null },
      }),
    ).toThrow(/device-flow configuration/);
  });

  test("hostile URLs are single-quote escaped, never interpolated", () => {
    const hostile = "https://archestra.example.com/v1'; rm -rf x #/mcp/y";
    for (const clientId of ALL_CLIENTS) {
      const ctx = fullContext(clientId, "windows");
      const script = renderSetupScript({
        ...ctx,
        mcp: { ...MCP, url: hostile },
        proxy: ctx.proxy ? { ...ctx.proxy, url: hostile } : null,
        skills: { ...SKILLS, cloneUrl: hostile },
      });
      // Single quotes in injected values are doubled (PowerShell escaping).
      expect(script).toContain("''; rm -rf x #");
    }
  });
});

describe("shell-injection resistance", () => {
  test("hostile URLs stay literal (never expanded) in every client script", async () => {
    const hostileUrl =
      "https://archestra.example.com/v1$(touch /tmp/pwned)/mcp/x";
    for (const clientId of ALL_CLIENTS) {
      const ctx = fullContext(clientId);
      const script = renderSetupScript({
        ...ctx,
        mcp: { ...MCP, url: hostileUrl },
        proxy: ctx.proxy ? { ...ctx.proxy, url: hostileUrl } : null,
        skills: { ...SKILLS, cloneUrl: hostileUrl },
      });
      await expectValidBash(script);
      // The hostile content survives verbatim (it would render mangled or
      // expanded if it passed through an unquoted context).
      expect(script).toContain(hostileUrl);
      expect(script).not.toMatch(/<<[ \t]*ARCHESTRA/);
    }
  });
});

describe("banner", () => {
  test("default app shows the ASCII mark + details; white-label drops the mark", async () => {
    const branded = renderSetupScript(fullContext("claude-code"));
    await expectValidBash(branded);
    expect(branded).toContain("cat <<'ARCHESTRA_BANNER'");
    expect(branded).toContain("Secure access to your AI tools");
    // the Archestra block-mark is printed under the default brand
    expect(branded).toContain("▟██▙");
    expect(branded).toContain("Client:     Claude Code");
    expect(branded).toContain("Configures:");
    expect(branded).toContain("one-time setup");

    const whiteLabel = renderSetupScript({
      ...fullContext("claude-code"),
      appName: "Acme AI",
    });
    await expectValidBash(whiteLabel);
    expect(whiteLabel).toContain("Acme AI");
    // the Archestra block-mark is not printed under a custom brand
    expect(whiteLabel).not.toContain("▟██▙");
  });
});

describe("appName sanitization", () => {
  test("collapses control characters so they cannot break out of comments", async () => {
    const script = renderSetupScript({
      ...fullContext("claude-code"),
      appName: "Evil\n# rm -rf / # Co",
    });
    await expectValidBash(script);
    // the newline is gone — no line in the script starts an injected command
    expect(script).not.toContain("\n# rm -rf /");
    expect(script).toContain("Evil # rm -rf / # Co setup");
  });
});

describe("color output", () => {
  test("defines TTY/NO_COLOR-guarded color helpers", async () => {
    const script = renderSetupScript(fullContext("claude-code"));
    await expectValidBash(script);
    // Colors only when stdout is a TTY and NO_COLOR is unset.
    expect(script).toContain("if [ -t 1 ] && [ -z");
    expect(script).toContain("NO_COLOR:-");
    // The logging helpers are defined and used.
    expect(script).toContain("say()");
    expect(script).toContain("err()");
    expect(script).toContain("warn()");
    expect(script).toContain('ok "Done."');
    // Errors are routed through err() (stderr), not bare `echo ... >&2`.
    expect(script).not.toContain('echo "error:');
  });

  test("ANSI codes never leak into quoted heredoc data", async () => {
    const script = renderSetupScript(fullContext("claude-code"));
    await expectValidBash(script);
    // The escape sequence is only assigned in the color-setup block, never
    // emitted literally inside banner/next-step heredocs.
    expect(script.match(/\\033\[/g)?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("idempotent re-runs", () => {
  test("config backups are taken once, never clobbering the pristine copy", () => {
    const claude = renderSetupScript(fullContext("claude-code"));
    // Guarded so a second run keeps the original (pre-Archestra) backup.
    expect(claude).toContain(
      "[ ! -f '$HOME/.claude/settings.json.archestra-backup' ]",
    );

    const codex = renderSetupScript(fullContext("codex"));
    expect(codex).toContain(
      '[ -f "$CONFIG.archestra-backup" ] || cp "$CONFIG" "$CONFIG.archestra-backup"',
    );
  });
});

describe("buildSetupCommand / proxyBaseUrlToOrigin", () => {
  test("strips the /v1 suffix and builds the one-liner", () => {
    expect(proxyBaseUrlToOrigin("https://host.example.com/v1")).toBe(
      "https://host.example.com",
    );
    expect(proxyBaseUrlToOrigin("https://host.example.com/v1/")).toBe(
      "https://host.example.com",
    );
    expect(proxyBaseUrlToOrigin("http://localhost:9000")).toBe(
      "http://localhost:9000",
    );

    expect(
      buildSetupCommand({
        origin: "https://host.example.com",
        rawToken: "archestra_con_abc",
        platform: "macos",
      }),
    ).toBe(
      "curl -fsSL 'https://host.example.com/api/connection-setups/script/archestra_con_abc' | bash",
    );

    expect(
      buildSetupCommand({
        origin: "https://host.example.com",
        rawToken: "archestra_con_abc",
        platform: "windows",
      }),
    ).toBe(
      "irm 'https://host.example.com/api/connection-setups/script/archestra_con_abc' | iex",
    );
  });
});
