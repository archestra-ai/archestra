import { execFile } from "node:child_process";
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
import { describe, expect, test } from "vitest";
import {
  buildStartupGuardInstallSection,
  buildStartupGuardUnshadowSection,
  renderStartupGuardScript,
  type StartupGuardClient,
  type StartupGuardContext,
} from "@/services/startup-guard";
import {
  CLAUDE_CODE_GUARD_CLIENT,
  CODEX_GUARD_CLIENT,
  COPILOT_GUARD_CLIENT,
} from "@/services/startup-guard.clients";
import { renderStartupGuardPowerShell } from "@/services/startup-guard.windows";

const execFileAsync = promisify(execFile);

const CTX: StartupGuardContext = {
  appName: "Archestra",
  healthUrl:
    "https://archestra.example.com/v1/health?mcp=prod-gateway&llm=acme-proxy",
  proxy: {
    provider: "openai",
    providerLabel: "OpenAI",
    url: "https://archestra.example.com/v1/openai/acme-proxy",
    ref: "acme-proxy",
    proxyName: "acme_proxy",
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

// Behavior common to every non-Claude client: the shared engine is already
// pinned by startup-guard.test.ts against the Claude descriptor, so here we
// only assert each descriptor injects the right client-specific strings and
// that the result is still valid bash.
describe.each([
  { name: "Codex", client: CODEX_GUARD_CLIENT },
  { name: "Copilot CLI", client: COPILOT_GUARD_CLIENT },
])("$name startup guard", ({ client }: { client: StartupGuardClient }) => {
  test("renders valid bash for the guard script and its install section", async () => {
    await expectValidBash(renderStartupGuardScript(CTX, client));
    await expectValidBash(
      `set -euo pipefail\nsay() { :; }\nok() { :; }\nwarn() { :; }\n${buildStartupGuardInstallSection(CTX, client)}`,
    );
  });

  test("wraps the client's own binary behind its own disable flag and paths", () => {
    const script = renderStartupGuardScript(CTX, client);
    const install = buildStartupGuardInstallSection(CTX, client);
    expect(script).toContain(`[ "\${${client.disableEnvVar}:-1}" = "0" ]`);
    expect(script).toContain(`GUARD_PATH="$HOME/${client.scriptRelpath}"`);
    // the profile wrapper re-execs the real binary after the guard
    expect(install).toContain(`${client.binary}() {`);
    expect(install).toContain(`command ${client.binary} "$@"`);
    expect(install).toContain(client.markerStart);
  });

  test("prompts name the client and disconnect mirrors its own CLI", () => {
    const script = renderStartupGuardScript(CTX, client);
    expect(script).toContain(`from ${client.promptName} now? (Y/n)`);
    expect(script).toContain(`command ${client.binary} mcp remove`);
  });

  test("every user-facing message names this client, never a hardcoded 'Claude'", () => {
    const script = renderStartupGuardScript(CTX, client);
    // the "Skipped — … may fail to reach …" lines and the down-summary prompt
    // must use the client's own promptName, not Claude's
    expect(script).toContain(`${client.promptName} may fail to reach`);
    expect(script).not.toContain("Claude may fail to reach");
  });

  test("install hooks the current shell's rc and tells the user how to arm it in this terminal", () => {
    const install = buildStartupGuardInstallSection(CTX, client);
    // The current shell's rc is chosen from $SHELL and hooked unconditionally
    // (created if missing) so the source hint always lands on a hooked profile —
    // a child `curl | bash` can't define the wrapper in the interactive shell.
    expect(install).toContain('archestra_guard_profile="$HOME/.zshrc"');
    expect(install).toContain('archestra_guard_profile="$HOME/.bashrc"');
    expect(install).toContain(
      'archestra_install_guard_block "$archestra_guard_profile"',
    );
    // …and the user is told to reload that exact profile (or open a new terminal).
    expect(install).toContain("source %s");
    expect(install).toContain('"$archestra_guard_profile"');
    expect(install).toContain("or just open a new terminal");
  });

  test("unshadow step drops the wrapper but is non-destructive, silent, and valid bash", async () => {
    const unshadow = buildStartupGuardUnshadowSection(client);
    // It drops the wrapper from the running shell so re-connect's CLI calls
    // reach the real binary instead of recursing into an installed guard…
    expect(unshadow).toContain(`unset -f ${client.binary} 2>/dev/null || true`);
    // …and does NOTHING else. A connect step failing under `set -e` runs between
    // this step and the install section, so this step must never delete the
    // persisted guard or edit a profile — otherwise a mid-connect abort would
    // strand the user with no startup screen (the regression this pins against).
    expect(unshadow).not.toContain("rm ");
    expect(unshadow).not.toContain("rm -f");
    expect(unshadow).not.toContain(`$HOME/${client.scriptRelpath}`);
    expect(unshadow).not.toContain(`$HOME/${client.skipRelpath}`);
    expect(unshadow).not.toContain(client.markerStart);
    expect(unshadow).not.toContain("awk");
    await expectValidBash(`set -euo pipefail\n${unshadow}`);
  });
});

describe("Codex-specific disconnect", () => {
  test("strips the archestra provider block it wrote to Codex's config.toml", () => {
    const script = renderStartupGuardScript(CTX, CODEX_GUARD_CLIENT);
    expect(script).toContain(
      'CONFIG="${CODEX_HOME:-$HOME/.codex}/config.toml"',
    );
    // the awk-delimited block is keyed by the proxy slug connect used
    expect(script).toContain("# >>> archestra:acme_proxy >>>");
    expect(script).toContain("# <<< archestra:acme_proxy <<<");
    // `codex exec` is the non-interactive path the guard bows out on
    expect(script).toContain("exec) INTERACTIVE=0");
  });
});

/**
 * Pull one shell function out of the rendered guard so it can be run on its
 * own. The generator emits every function at column 0 and closes it with a
 * bare `}`, so the slice is unambiguous.
 */
function extractShellFunction(script: string, name: string): string {
  const lines = script.split("\n");
  // The opening line may carry a trailing `# $1 kind` comment.
  const start = lines.findIndex((line) => line.startsWith(`${name}() {`));
  if (start === -1) throw new Error(`no ${name}() in the rendered guard`);
  const end = lines.indexOf("}", start);
  if (end === -1) throw new Error(`${name}() is never closed`);
  return lines.slice(start, end + 1).join("\n");
}

/**
 * Run rendered guard functions for real against a throwaway home directory,
 * with a fake client binary on PATH that records its argv. Exercising the
 * generated shell beats asserting on its text: the defects this pins were all
 * "the code ran and did nothing", which a string match cannot tell from
 * success.
 *
 * `files` are written relative to the temp home; `env` overlays the spawned
 * bash's environment (HOME always points at the temp home, so verifiers that
 * default to `$HOME/...` read the fixture, never this machine's real config).
 * An `env` value may embed `{HOME}`, replaced with the temp home's absolute
 * path — the only way a caller can point CODEX_HOME/CLAUDE_CONFIG_DIR at a
 * directory that does not exist until the harness creates it.
 */
async function runGuardSnippet(params: {
  client: StartupGuardClient;
  functions: string[];
  invoke: string;
  files?: Record<string, string>;
  env?: Record<string, string>;
}): Promise<{ code: number; stdout: string; cliArgs: string[] }> {
  const script = renderStartupGuardScript(CTX, params.client);
  const dir = await mkdtemp(path.join(tmpdir(), "archestra-guard-run-"));
  try {
    const home = path.join(dir, "home");
    const bin = path.join(dir, "bin");
    const argvLog = path.join(dir, "cli-argv.log");
    await mkdir(home, { recursive: true });
    await mkdir(bin, { recursive: true });
    for (const [relpath, content] of Object.entries(params.files ?? {})) {
      const target = path.join(home, relpath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    const fakeCli = path.join(bin, params.client.binary);
    await writeFile(
      fakeCli,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}\n`,
      "utf8",
    );
    await chmod(fakeCli, 0o755);

    const harness = path.join(dir, "harness.sh");
    await writeFile(
      harness,
      [
        "#!/usr/bin/env bash",
        // Presentation helpers the extracted functions call.
        "line_reset() { :; }",
        'C_WARN=""; C_RESET=""; C_DIM=""; C_ERR=""; C_ACCENT=""',
        `MCP_SERVER_NAME=${JSON.stringify(CTX.mcp?.serverName)}`,
        `SKILLS_MARKETPLACE_NAME=${JSON.stringify(CTX.skills?.marketplaceName)}`,
        ...params.functions.map((name) => extractShellFunction(script, name)),
        params.invoke,
      ].join("\n"),
      "utf8",
    );

    const overlay = Object.fromEntries(
      Object.entries(params.env ?? {}).map(([key, value]) => [
        key,
        value.replaceAll("{HOME}", home),
      ]),
    );
    const result = await execFileAsync("bash", [harness], {
      env: {
        ...process.env,
        HOME: home,
        // Config-relocation vars exported on the machine running the tests
        // must not leak into the fixture home. Empty string falls through
        // `${VAR:-default}` to the default, exactly like unset.
        CLAUDE_CONFIG_DIR: "",
        CODEX_HOME: "",
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        ...overlay,
      },
    }).then(
      (r) => ({ code: 0, stdout: r.stdout }),
      (e: { code?: number; stdout?: string }) => ({
        code: e.code ?? 1,
        stdout: e.stdout ?? "",
      }),
    );

    let cliArgs: string[] = [];
    try {
      cliArgs = (await readFile(argvLog, "utf8")).split("\n").filter(Boolean);
    } catch {
      cliArgs = [];
    }
    return { ...result, cliArgs };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Codex flavor of {@link runGuardSnippet}: CODEX_HOME points at the temp home. */
async function runCodexGuardSnippet(params: {
  functions: string[];
  invoke: string;
  configToml?: string;
  authJson?: string;
}): Promise<{ code: number; stdout: string; codexArgs: string[] }> {
  const files: Record<string, string> = {};
  if (params.configToml !== undefined) files["config.toml"] = params.configToml;
  if (params.authJson !== undefined) files["auth.json"] = params.authJson;
  const { code, stdout, cliArgs } = await runGuardSnippet({
    client: CODEX_GUARD_CLIENT,
    functions: params.functions,
    invoke: params.invoke,
    files,
    env: { CODEX_HOME: "{HOME}" },
  });
  return { code, stdout, codexArgs: cliArgs };
}

const GATEWAY_TABLE = [
  "[mcp_servers.prod_gateway]",
  'url = "https://archestra.example.com/v1/mcp/prod-gateway"',
  "",
  "[mcp_servers.prod_gateway.tools.demo__open]",
  'approval_mode = "approve"',
  "",
].join("\n");

const FOREIGN_TABLES = [
  "[mcp_servers.node_repl]",
  'command = "/opt/codex/node"',
  "",
  "[marketplaces.openai-bundled]",
  'source_type = "local"',
  "",
].join("\n");

describe("Codex disconnect reports what it could not remove", () => {
  test("a gateway the CLI failed to remove fails verification and names the fix", async () => {
    const { code, stdout } = await runCodexGuardSnippet({
      functions: ["disconnect_verify"],
      invoke: "disconnect_verify mcp || exit 7\nexit 0\n",
      configToml: `${FOREIGN_TABLES}${GATEWAY_TABLE}`,
    });

    // Before the fix disconnect_verify did not exist and the caller printed
    // "✓ Disconnected" unconditionally.
    expect(code).toBe(7);
    expect(stdout).toContain("[mcp_servers.prod_gateway] is still in");
    expect(stdout).toContain("run `codex mcp remove prod_gateway` yourself");
  });

  test("a marketplace the CLI failed to remove fails verification", async () => {
    const { code, stdout } = await runCodexGuardSnippet({
      functions: ["disconnect_verify"],
      invoke: "disconnect_verify skills || exit 7\nexit 0\n",
      configToml: '[marketplaces.acme-skills]\nsource_type = "git"\n',
    });

    expect(code).toBe(7);
    expect(stdout).toContain("[marketplaces.acme-skills] is still in");
  });

  test("verification passes once the entries are gone, ignoring foreign ones", async () => {
    const { code } = await runCodexGuardSnippet({
      functions: ["disconnect_verify"],
      invoke: "disconnect_verify mcp && disconnect_verify skills\n",
      // node_repl and openai-bundled are the user's own — they must not read
      // as our leftovers.
      configToml: FOREIGN_TABLES,
    });

    expect(code).toBe(0);
  });

  test("verification reads the config CODEX_HOME points at", async () => {
    // Seeded only in CODEX_HOME; a guard hardcoding ~/.codex would see no
    // leftover here and wrongly report success.
    const { code } = await runCodexGuardSnippet({
      functions: ["disconnect_verify"],
      invoke: "disconnect_verify mcp || exit 7\nexit 0\n",
      configToml: GATEWAY_TABLE,
    });

    expect(code).toBe(7);
  });
});

describe("Codex disconnect reverses the credential it installed", () => {
  test("signs Codex out of an archestra virtual key", async () => {
    const { codexArgs, stdout } = await runCodexGuardSnippet({
      functions: ["codex_logout_if_ours", "proxy_disconnect_notes"],
      invoke: "codex_logout_if_ours\nproxy_disconnect_notes\n",
      authJson: '{"OPENAI_API_KEY":"arch_deadbeef","auth_mode":"apikey"}',
    });

    // Without this the key outlives the base_url that made it routable, and
    // every plain `codex` run 401s against api.openai.com.
    expect(codexArgs).toContain("logout");
    expect(stdout).toContain("Signed Codex out of the Archestra virtual key");
  });

  test("leaves a user-owned api key alone", async () => {
    const { codexArgs, stdout } = await runCodexGuardSnippet({
      functions: ["codex_logout_if_ours", "proxy_disconnect_notes"],
      invoke: "codex_logout_if_ours\nproxy_disconnect_notes\n",
      authJson: '{"OPENAI_API_KEY":"sk-useROwnedKey","auth_mode":"apikey"}',
    });

    expect(codexArgs).not.toContain("logout");
    expect(stdout).not.toContain("Signed Codex out");
  });

  test("leaves a ChatGPT session alone even beside our key", async () => {
    // `codex logout` deletes auth.json wholesale, so it must never run while
    // the user has an OAuth session Codex would prefer anyway.
    const { codexArgs } = await runCodexGuardSnippet({
      functions: ["codex_logout_if_ours", "proxy_disconnect_notes"],
      invoke: "codex_logout_if_ours\nproxy_disconnect_notes\n",
      authJson:
        '{"OPENAI_API_KEY":"arch_deadbeef","auth_mode":"chatgpt","tokens":{"access_token":"x"}}',
    });

    expect(codexArgs).not.toContain("logout");
  });

  test("does nothing when Codex holds no credential at all", async () => {
    const { code, codexArgs } = await runCodexGuardSnippet({
      functions: ["codex_logout_if_ours", "proxy_disconnect_notes"],
      invoke: "codex_logout_if_ours\nproxy_disconnect_notes\n",
    });

    expect(code).toBe(0);
    expect(codexArgs).toEqual([]);
  });
});

describe("an unverified disconnect is not recorded as done", () => {
  test("bash: the skip file and the guard uninstall both wait on success", () => {
    const script = renderStartupGuardScript(CTX, CODEX_GUARD_CLIENT);
    // Recording an unproven removal would skip the resource on every later
    // launch, and uninstalling the guard would delete the only thing that
    // could retry.
    expect(script).toContain(
      'if disconnect_resource "${GUARD_KINDS[$i]}" "${GUARD_LABELS[$i]}"; then',
    );
    expect(script).toContain("DISCONNECT_FAILED=1");
    expect(script).toContain(
      '[ "$DOWN_COUNT" -ge "$ACTIVE_TOTAL" ] && [ "$DISCONNECT_FAILED" = "0" ] && uninstall_guard',
    );
    expect(script).toContain(
      '[ "$DISCONNECT_FAILED" = "0" ] && uninstall_guard',
    );
  });

  test("windows: the skip file and the guard uninstall both wait on success", () => {
    const script = renderStartupGuardPowerShell(CTX, CODEX_GUARD_CLIENT);
    expect(script).toContain("if (Disconnect-ArchRemote $r.Kind $r.Label) {");
    expect(script).toContain("$Script:ArchDisconnectFailed = $true");
    expect(script).toContain(
      "if ($downRemotes.Count -ge $ActiveRemotes.Count -and -not $Script:ArchDisconnectFailed) { Remove-ArchGuard }",
    );
    expect(script).toContain(
      "if (-not $Script:ArchDisconnectFailed) { Remove-ArchGuard }",
    );
    // A missing binary cannot have removed anything.
    expect(script).toContain("the codex executable could not be found on PATH");
    // …and Windows reverses the credential too.
    expect(script).toContain("Invoke-ArchCodexLogoutIfOurs");
  });
});

describe("Copilot-specific disconnect", () => {
  test("strips the COPILOT_PROVIDER_* export lines from the shell profiles", () => {
    const script = renderStartupGuardScript(CTX, COPILOT_GUARD_CLIENT);
    expect(script).toContain(
      "export[[:space:]]+COPILOT_PROVIDER_(TYPE|BASE_URL|API_KEY|HEADERS)=",
    );
    expect(script).toContain('"$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"');
    // Copilot's non-interactive one-shot flag
    expect(script).toContain("-p|--prompt) INTERACTIVE=0");
  });
});

describe("Claude Code disconnect reports what it could not remove", () => {
  const GATEWAY_JSON = JSON.stringify({
    mcpServers: {
      prod_gateway: { type: "http", url: "https://archestra.example.com" },
      "user-own-server": { type: "stdio", command: "/usr/bin/thing" },
    },
  });

  test("a gateway the CLI failed to remove fails verification and names the fix", async () => {
    const { code, stdout } = await runGuardSnippet({
      client: CLAUDE_CODE_GUARD_CLIENT,
      functions: ["disconnect_verify"],
      invoke: "disconnect_verify mcp || exit 7\nexit 0\n",
      files: { ".claude.json": GATEWAY_JSON },
    });

    // Before the fix the removal was fire-and-forget: `claude mcp remove` ran
    // silenced with its result discarded, and the guard printed ✓ regardless.
    expect(code).toBe(7);
    expect(stdout).toContain("prod_gateway is still registered in");
    expect(stdout).toContain(
      "run `claude mcp remove --scope user prod_gateway` yourself",
    );
  });

  test("the name appearing in an unrelated value is not a leftover", async () => {
    // ~/.claude.json holds per-project state where a server name can occur in
    // ordinary strings — this is why the check parses JSON instead of grepping.
    const { code } = await runGuardSnippet({
      client: CLAUDE_CODE_GUARD_CLIENT,
      functions: ["disconnect_verify"],
      invoke: "disconnect_verify mcp\n",
      files: {
        ".claude.json": JSON.stringify({
          mcpServers: {},
          projects: {
            "/home/user/repo": { history: ["please debug prod_gateway"] },
          },
        }),
      },
    });

    expect(code).toBe(0);
  });

  test("verification reads the config CLAUDE_CONFIG_DIR points at", async () => {
    // Seeded only under the relocated config dir; a verifier hardcoding
    // ~/.claude.json would see no leftover and wrongly report success.
    const { code } = await runGuardSnippet({
      client: CLAUDE_CODE_GUARD_CLIENT,
      functions: ["disconnect_verify"],
      invoke: "disconnect_verify mcp || exit 7\nexit 0\n",
      files: { "claude-cfg/.claude.json": GATEWAY_JSON },
      env: { CLAUDE_CONFIG_DIR: "{HOME}/claude-cfg" },
    });

    expect(code).toBe(7);
  });

  test("a marketplace the CLI failed to remove fails verification; foreign ones never do", async () => {
    const stillThere = await runGuardSnippet({
      client: CLAUDE_CODE_GUARD_CLIENT,
      functions: ["disconnect_verify"],
      invoke: "disconnect_verify skills || exit 7\nexit 0\n",
      files: {
        ".claude/plugins/known_marketplaces.json": JSON.stringify({
          "claude-plugins-official": { source: "github" },
          "acme-skills": { source: "https://archestra.example.com/repo.git" },
        }),
      },
    });
    expect(stillThere.code).toBe(7);
    expect(stillThere.stdout).toContain(
      "run `claude plugin marketplace remove acme-skills` yourself",
    );

    const foreignOnly = await runGuardSnippet({
      client: CLAUDE_CODE_GUARD_CLIENT,
      functions: ["disconnect_verify"],
      invoke: "disconnect_verify skills\n",
      files: {
        ".claude/plugins/known_marketplaces.json": JSON.stringify({
          "claude-plugins-official": { source: "github" },
        }),
      },
    });
    expect(foreignOnly.code).toBe(0);
  });

  test("an unreadable config passes: presence must be proven, not presumed", async () => {
    const { code } = await runGuardSnippet({
      client: CLAUDE_CODE_GUARD_CLIENT,
      functions: ["disconnect_verify"],
      invoke: "disconnect_verify mcp && disconnect_verify skills\n",
      files: { ".claude.json": "{ this is not json" },
    });

    expect(code).toBe(0);
  });
});

describe("Copilot CLI disconnect reports what it could not remove", () => {
  test("a gateway the CLI failed to remove fails verification and names the fix", async () => {
    const { code, stdout } = await runGuardSnippet({
      client: COPILOT_GUARD_CLIENT,
      functions: ["disconnect_verify"],
      invoke: "disconnect_verify mcp || exit 7\nexit 0\n",
      files: {
        ".copilot/mcp-config.json": JSON.stringify({
          mcpServers: {
            prod_gateway: { url: "https://archestra.example.com" },
          },
        }),
      },
    });

    expect(code).toBe(7);
    expect(stdout).toContain("run `copilot mcp remove prod_gateway` yourself");
  });

  test("a marketplace the CLI failed to remove fails verification", async () => {
    const { code, stdout } = await runGuardSnippet({
      client: COPILOT_GUARD_CLIENT,
      functions: ["disconnect_verify"],
      invoke: "disconnect_verify skills || exit 7\nexit 0\n",
      files: {
        ".copilot/settings.json": JSON.stringify({
          extraKnownMarketplaces: {
            "acme-skills": { source: "https://archestra.example.com/repo.git" },
          },
        }),
      },
    });

    expect(code).toBe(7);
    expect(stdout).toContain(
      "run `copilot plugin marketplace remove acme-skills` yourself",
    );
  });

  test("verification passes once the entries are gone or the files are absent", async () => {
    const clean = await runGuardSnippet({
      client: COPILOT_GUARD_CLIENT,
      functions: ["disconnect_verify"],
      invoke: "disconnect_verify mcp && disconnect_verify skills\n",
      files: {
        ".copilot/mcp-config.json": JSON.stringify({ mcpServers: {} }),
        ".copilot/settings.json": JSON.stringify({}),
      },
    });
    expect(clean.code).toBe(0);

    const absent = await runGuardSnippet({
      client: COPILOT_GUARD_CLIENT,
      functions: ["disconnect_verify"],
      invoke: "disconnect_verify mcp && disconnect_verify skills\n",
    });
    expect(absent.code).toBe(0);
  });
});

describe("windows disconnect verification (string pins — no PS runtime in CI)", () => {
  test("claude: reads the JSON configs the CLI edits, honoring CLAUDE_CONFIG_DIR", () => {
    const script = renderStartupGuardPowerShell(CTX, CLAUDE_CODE_GUARD_CLIENT);
    expect(script).toContain("function Test-ArchDisconnected");
    expect(script).toContain("ConvertFrom-Json");
    expect(script).toContain(
      "$(if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { $env:USERPROFILE }) '.claude.json'",
    );
    expect(script).toContain("plugins\\known_marketplaces.json");
    expect(script).toContain("$archParsed.mcpServers");
  });

  test("copilot: reads mcp-config.json and settings.json", () => {
    const script = renderStartupGuardPowerShell(CTX, COPILOT_GUARD_CLIENT);
    expect(script).toContain(".copilot\\mcp-config.json");
    expect(script).toContain(".copilot\\settings.json");
    expect(script).toContain("$archParsed.extraKnownMarketplaces");
  });
});
