// biome-ignore-all lint/suspicious/noTemplateCurlyInString: asserts on emitted shell source, where `${VAR}` is shell parameter expansion

import { execFile, spawnSync } from "node:child_process";
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
  EXTERNAL_AGENT_ID_HEADER,
  VIRTUAL_KEY_HEADER,
} from "@archestra/shared/consts";
import {
  OPENCODE_PASSTHROUGH_PROVIDER_ROUTES,
  openCodePassthroughBaseUrl,
} from "@archestra/shared/opencode-provider-routes";
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
  OPENCODE_GUARD_CLIENT,
} from "@/services/startup-guard.clients";
import { renderStartupGuardPowerShell } from "@/services/startup-guard.windows";
import { CODEX_HANDOFF_HELPER } from "./codex-handoff";

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
// pinned by startup-guard.unit.test.ts against the Claude descriptor, so here we
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

  test("install hooks interactive and Bash login profiles and prints the current-shell activation", () => {
    const install = buildStartupGuardInstallSection(CTX, client);
    expect(install).toContain('archestra_guard_profile="$HOME/.zshrc"');
    expect(install).toContain('archestra_guard_profile="$HOME/.bashrc"');
    expect(install).toContain('archestra_install_guard_block "$HOME/.zshrc"');
    expect(install).toContain('archestra_install_guard_block "$HOME/.bashrc"');
    expect(install).toContain(
      'archestra_bash_login_profile="$HOME/.bash_profile"',
    );
    expect(install).toContain(
      'archestra_install_guard_block "$archestra_bash_login_profile"',
    );
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

test("OpenCode startup guard is active in a fresh Bash login shell", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "opencode-login-guard-"));
  const installPath = path.join(home, "install.sh");
  try {
    await writeFile(path.join(home, ".hushlogin"), "", "utf8");
    await writeFile(
      installPath,
      `set -euo pipefail
say() { :; }
ok() { :; }
warn() { :; }
ARCH_C_OK=''
ARCH_C_RESET=''
${buildStartupGuardInstallSection(CTX, OPENCODE_GUARD_CLIENT)}`,
      "utf8",
    );
    await execFileAsync("bash", [installPath], {
      env: { ...process.env, HOME: home, SHELL: "/bin/bash" },
    });

    const { stdout } = await execFileAsync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-ic",
        '. "$HOME/.bash_profile"; type -t opencode',
      ],
      {
        env: { ...process.env, HOME: home, SHELL: "/bin/bash" },
      },
    );
    expect(stdout.trim().split("\n").at(-1)).toBe("function");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

describe("OpenCode provider passthrough disconnect", () => {
  test("builds routes from the full proxy URL when the provider suffix is absent", () => {
    if (!CTX.proxy) throw new Error("test proxy missing");
    const script = OPENCODE_GUARD_CLIENT.renderProxyDisconnect({
      ...CTX,
      proxy: {
        ...CTX.proxy,
        authMode: "provider-key",
        provider: "openai",
        url: "https://archestra.example.com/llm",
        passthroughVirtualKey: "arch_passthroughcafe",
      },
    });
    expect(script).toContain("https://archestra.example.com/llm/openai");
    expect(script).not.toContain("https://archestra.example.com/openai");
  });

  test("removes only managed routes and restores prior provider constraints", async () => {
    if (!CTX.proxy) throw new Error("test proxy missing");
    const home = await mkdtemp(path.join(tmpdir(), "opencode disconnect "));
    const configDir = path.join(home, ".config", "opencode");
    const configPath = path.join(configDir, "opencode.json");
    const statePath = path.join(
      home,
      ".archestra",
      "opencode-connection-state.json",
    );
    const pluginPath = path.join(
      configDir,
      "plugins",
      "archestra-llm-proxy.js",
    );
    const pluginStatePath = path.join(
      home,
      ".archestra",
      "opencode-routing-plugin-state.json",
    );
    const configBackupPath = `${configPath}.archestra-backup`;
    const ctx: StartupGuardContext = {
      ...CTX,
      proxy: {
        ...CTX.proxy,
        authMode: "provider-key",
        provider: "openai",
        url: "https://archestra.example.com/v1/openai",
        passthroughVirtualKey: "arch_passthroughcafe",
      },
      mcp: null,
      skills: null,
    };
    const routes = Object.fromEntries(
      OPENCODE_PASSTHROUGH_PROVIDER_ROUTES.map((route) => [
        route.openCodeProviderId,
        openCodePassthroughBaseUrl("https://archestra.example.com/v1", route),
      ]),
    );
    const managedHeaders = {
      [EXTERNAL_AGENT_ID_HEADER]: "opencode",
      [VIRTUAL_KEY_HEADER]: "arch_passthroughcafe",
    };

    try {
      await mkdir(path.dirname(statePath), { recursive: true });
      await mkdir(path.dirname(pluginPath), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({
          enabled_providers: Object.keys(routes),
          disabled_providers: ["legacy"],
          provider: {
            google: {
              options: {
                apiVersion: "v1beta",
                baseURL: routes.google,
                headers: { "X-Local": "kept", ...managedHeaders },
              },
            },
            anthropic: {
              options: {
                baseURL: routes.anthropic,
                headers: managedHeaders,
              },
            },
          },
        }),
      );
      await writeFile(
        statePath,
        JSON.stringify({
          enabledProvidersPresent: true,
          enabledProviders: ["local-provider"],
          disabledProvidersPresent: true,
          disabledProviders: ["google", "legacy"],
          providerState: {
            google: {
              options: {
                apiVersion: "v1beta",
                baseURL: "https://previous.example/v1beta",
                headers: {
                  "X-Local": "kept",
                  [EXTERNAL_AGENT_ID_HEADER]: "previous-value",
                },
              },
            },
            anthropic: null,
          },
        }),
      );
      await writeFile(configBackupPath, "old backup");
      await writeFile(pluginPath, "export const ManagedPlugin = true;");
      await writeFile(
        pluginStatePath,
        JSON.stringify({
          existed: true,
          contentBase64: Buffer.from(
            "export const ExistingPlugin = true;",
          ).toString("base64"),
        }),
      );
      const scriptPath = path.join(home, "disconnect.sh");
      await writeFile(
        scriptPath,
        `set -eu
${OPENCODE_GUARD_CLIENT.renderProxyDisconnect(ctx)}
disconnect_proxy
`,
      );
      await execFileAsync("bash", [scriptPath], {
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: "" },
      });

      const config = JSON.parse(await readFile(configPath, "utf8"));
      expect(config.enabled_providers).toEqual(["local-provider"]);
      expect(config.disabled_providers).toEqual(["google", "legacy"]);
      expect(config.provider.google.options).toEqual({
        apiVersion: "v1beta",
        baseURL: "https://previous.example/v1beta",
        headers: {
          "X-Local": "kept",
          [EXTERNAL_AGENT_ID_HEADER]: "previous-value",
        },
      });
      expect(config.provider).not.toHaveProperty("anthropic");
      await expect(readFile(statePath)).rejects.toThrow();
      expect(await readFile(pluginPath, "utf8")).toBe(
        "export const ExistingPlugin = true;",
      );
      await expect(readFile(pluginStatePath)).rejects.toThrow();
      await expect(readFile(configBackupPath)).rejects.toThrow();

      await writeFile(pluginPath, "export const ManagedPlugin = true;");
      await writeFile(
        pluginStatePath,
        JSON.stringify({ existed: false, contentBase64: null }),
      );
      await execFileAsync("bash", [scriptPath], {
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: "" },
      });
      await expect(readFile(pluginPath)).rejects.toThrow();
      await expect(readFile(pluginStatePath)).rejects.toThrow();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
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
  cliBody?: string;
  /** Read these home-relative paths back before the temp dir is removed. */
  readFiles?: string[];
  /** Hide the real PATH so a missing python3/client binary is the process boundary. */
  isolatePath?: boolean;
}): Promise<{
  code: number;
  stdout: string;
  cliArgs: string[];
  files: Record<string, string | null>;
}> {
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
    const shebang = params.isolatePath ? "#!/bin/bash" : "#!/usr/bin/env bash";
    await writeFile(
      fakeCli,
      `${shebang}\nprintf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}\n${params.cliBody ?? ""}\n`,
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
    const result = await execFileAsync(
      params.isolatePath ? "/bin/bash" : "bash",
      [harness],
      {
        env: {
          ...process.env,
          HOME: home,
          // Config-relocation vars exported on the machine running the tests
          // must not leak into the fixture home. Empty string falls through
          // `${VAR:-default}` to the default, exactly like unset.
          CLAUDE_CONFIG_DIR: "",
          CODEX_HOME: "",
          XDG_CACHE_HOME: "",
          XDG_CONFIG_HOME: "",
          XDG_DATA_HOME: "",
          XDG_STATE_HOME: "",
          PATH: params.isolatePath ? bin : `${bin}:${process.env.PATH ?? ""}`,
          ...overlay,
        },
      },
    ).then(
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
    const files: Record<string, string | null> = {};
    for (const relpath of params.readFiles ?? []) {
      try {
        files[relpath] = await readFile(path.join(home, relpath), "utf8");
      } catch {
        files[relpath] = null;
      }
    }
    return { ...result, cliArgs, files };
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
  test.each([
    false,
    true,
  ])("proxy removal restores direct-mode settings with MCP disconnected first: %s", async (mcpFirst) => {
    const helper = `${CODEX_GUARD_CLIENT.scriptRelpath}.handoff.cjs`;
    const { code } = await runGuardSnippet({
      client: CODEX_GUARD_CLIENT,
      functions: [
        "menu_disconnect_row",
        "disconnect_actions",
        "disconnect_proxy",
        "codex_logout_if_ours",
        "disconnect_verify",
      ],
      files: {
        [helper]: CODEX_HANDOFF_HELPER,
        "model-cli.cmd": "npm shim placeholder",
        "node_modules/@openai/codex/bin/codex.js": `require('node:fs').writeFileSync(require('node:path').join(process.env.CODEX_HOME,'models_cache.json'),JSON.stringify({fetched_at:new Date().toISOString()})); console.log(JSON.stringify({models:[{slug:'model-a',tool_mode:'code_mode_only'}]}));`,
        "config.toml": `model_provider = "acme_proxy"
model = "model-a"
web_search = "live"
[features]
code_mode_host = true
js_repl = true
# >>> archestra:acme_proxy >>>
[model_providers.acme_proxy]
name = "acme_proxy"
# <<< archestra:acme_proxy <<<
${GATEWAY_TABLE}`,
        "config.toml.archestra-backup": 'model_provider = "openai"\n',
      },
      env: { CODEX_HOME: "{HOME}" },
      cliBody: `if [ "$1 $2" = 'mcp remove' ]; then
node -e 'const fs=require("node:fs"); const p=process.env.CODEX_HOME+"/config.toml"; fs.writeFileSync(p,fs.readFileSync(p,"utf8").replace(/\\[mcp_servers\\.prod_gateway\\][\\s\\S]*$/,""));'
fi`,
      invoke: `set -e
node "$HOME/${helper}" --install-direct "$HOME/model-cli.cmd"
test -f "$HOME/archestra-direct-model-catalog.json"
${MENU_ROW_PREAMBLE}
GUARD_KINDS=(mcp proxy)
GUARD_LABELS=("MCP gateway" "LLM proxy")
${mcpFirst ? 'menu_disconnect_row 1 0\ngrep -q "archestra:codex-direct:root" "$HOME/config.toml"\ntest -f "$HOME/archestra-direct-model-catalog.json"' : ""}
menu_disconnect_row 2 1
grep -qx proxy "$SKIP_FILE"
grep -Fx 'code_mode_host = true' "$HOME/config.toml"
grep -Fx 'js_repl = true' "$HOME/config.toml"
grep -Fx 'web_search = "live"' "$HOME/config.toml"
grep -Fx 'model_provider = "openai"' "$HOME/config.toml"
! grep -q 'archestra:codex-direct:' "$HOME/config.toml"
test ! -f "$HOME/archestra-direct-model-catalog.json"
${mcpFirst ? '! grep -Fq "[mcp_servers.prod_gateway]" "$HOME/config.toml"' : 'grep -Fq "[mcp_servers.prod_gateway]" "$HOME/config.toml"'}
`,
    });
    expect(code).toBe(0);
  });

  test.each([
    {
      previous: 'model_provider = "openai"\nmodel = "gpt-5.5"\n',
      selected: 'model_provider = "acme_proxy"',
      expected: 'model_provider = "openai"',
    },
    {
      previous: 'model = "gpt-5.5"\n',
      selected: 'model_provider = "acme_proxy"',
      expected: "",
    },
    {
      previous: 'model_provider = "openai"\n',
      selected: 'model_provider = "other_provider"',
      expected: 'model_provider = "other_provider"',
    },
  ])("restores the prior provider without undoing a later user selection", async ({
    previous,
    selected,
    expected,
  }) => {
    const { code } = await runGuardSnippet({
      client: CODEX_GUARD_CLIENT,
      functions: ["disconnect_proxy", "codex_logout_if_ours"],
      files: {
        "config.toml": `${selected}\n[tools]\nweb_search = true\n# >>> archestra:acme_proxy >>>\n[model_providers.acme_proxy]\nname = "acme_proxy"\n# <<< archestra:acme_proxy <<<\n`,
        "config.toml.archestra-backup": previous,
      },
      env: { CODEX_HOME: "{HOME}" },
      invoke: `disconnect_proxy
if [ -n '${expected}' ]; then
  grep -Fx '${expected}' "$CODEX_HOME/config.toml" || exit 7
else
  ! grep -q '^model_provider' "$CODEX_HOME/config.toml" || exit 8
fi
grep -F '[tools]' "$CODEX_HOME/config.toml" || exit 9
! grep -F '[model_providers.acme_proxy]' "$CODEX_HOME/config.toml" || exit 10
`,
    });

    expect(code).toBe(0);
  });

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

// The menu's cursor/spinner choreography, neutralized: the contract under
// test is verify → record, not the animation. remember_disconnected is
// re-declared verbatim because the real one is a one-liner
// extractShellFunction cannot slice.
const MENU_ROW_PREAMBLE = [
  "menu_at_row() { :; }",
  "menu_leave_row() { :; }",
  "spin_start() { :; }",
  "spin_tick() { :; }",
  'remember_disconnected() { printf "%s\\n" "$1" >> "$SKIP_FILE"; }',
  "MIN_CHECK_FRAMES=0",
  "FRAME_SLEEP=0",
  "GUARD_KINDS=(mcp)",
  'GUARD_LABELS=("MCP gateway")',
  'SKIP_FILE="$HOME/guard-skip"',
  "DISCONNECT_FAILED=0",
].join("\n");

describe("the reconfigure menu obeys the same verify-before-record contract", () => {
  test("bash: a removal that cannot be proven paints ✗, records nothing, and stays retryable", async () => {
    const { code, stdout } = await runCodexGuardSnippet({
      functions: [
        "menu_disconnect_row",
        "disconnect_actions",
        "disconnect_verify",
      ],
      invoke: [
        MENU_ROW_PREAMBLE,
        "menu_disconnect_row 1 0 && exit 9",
        '[ "$DISCONNECT_FAILED" = "1" ] || exit 8',
        '[ ! -f "$SKIP_FILE" ] || exit 7',
        "exit 0",
      ].join("\n"),
      // The fake CLI removes nothing, so the gateway table survives it.
      configToml: GATEWAY_TABLE,
    });

    expect(code).toBe(0);
    expect(stdout).toContain(
      "✗ Could not disconnect MCP gateway — [1] to retry",
    );
    expect(stdout).not.toContain("✓ Disconnected");
    // The verify hint would corrupt the in-place row; it stays suppressed.
    expect(stdout).not.toContain("is still in");
  });

  test("bash: a proven removal lands the check and the skip-file entry", async () => {
    const { code, stdout } = await runCodexGuardSnippet({
      functions: [
        "menu_disconnect_row",
        "disconnect_actions",
        "disconnect_verify",
      ],
      invoke: [
        MENU_ROW_PREAMBLE,
        "menu_disconnect_row 1 0 || exit 9",
        'grep -qx mcp "$SKIP_FILE" || exit 8',
        '[ "$DISCONNECT_FAILED" = "0" ] || exit 7',
        "exit 0",
      ].join("\n"),
      // Nothing of ours left behind, so the removal verifies.
      configToml: FOREIGN_TABLES,
    });

    expect(code).toBe(0);
    expect(stdout).toContain("✓ Disconnected MCP gateway");
  });

  test("bash: the menu's guard uninstall waits on every removal being proven", () => {
    const script = renderStartupGuardScript(CTX, CODEX_GUARD_CLIENT);
    expect(script).toContain(
      'menu_disconnect_row "$key" "$menu_target" || continue',
    );
    expect(script).toContain(
      'if [ "$menu_left" -eq 0 ] && [ "$DISCONNECT_FAILED" = "0" ]; then',
    );
  });

  test("windows: same contract — verify, gate the record, gate the uninstall", () => {
    const script = renderStartupGuardPowerShell(CTX, CODEX_GUARD_CLIENT);
    expect(script).toContain("$archOk = Invoke-ArchDisconnectActions $r.Kind");
    expect(script).toContain(
      "if (-not (Disconnect-ArchMenuRow ($d - 1) $count $baseTop)) { continue }",
    );
    expect(script).toContain(
      "if ($done.Count -ge $count -and -not $Script:ArchDisconnectFailed) { Remove-ArchGuard; break }",
    );
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

const OWNED_ALLOW = [
  "mcp__prod_gateway__archestra__get_remedy_plans",
  "mcp__prod_gateway__archestra__execute_remedy_plan",
  "mcp__prod_gateway__archestra__yell",
  "mcp__prod_gateway__archestra__ask_user",
];
const USER_ALLOW = ["Bash(git status)", "Read"];
const OTHER_ALLOW = ["mcp__other_gateway__archestra__yell"];
const SETTINGS_REL = ".claude/settings.json";
const LEDGER_REL = ".archestra/claude-appa-permissions.json";
const BACKUP_REL = ".claude/settings.json.archestra-backup";

function claudeSettings(
  allow: string[] = [...OWNED_ALLOW, ...USER_ALLOW, ...OTHER_ALLOW],
): string {
  return JSON.stringify({
    enableAllProjectMcpServers: false,
    numRetries: 1,
    env: { USER_OWNED_KEY: "keep-me" },
    permissions: {
      allow,
      ask: ["Bash(rm *)"],
      deny: ["WebFetch", OWNED_ALLOW[0]],
    },
    model: "claude-sonnet",
  });
}

function claudeLedger(
  body: Record<string, unknown> = {
    prod_gateway: OWNED_ALLOW,
    other_gateway: OTHER_ALLOW,
    schemaVersion: 1,
  },
): string {
  return JSON.stringify(body);
}

function expectOwnedRulesRemoved(
  raw: string,
  allow: string[] = [...USER_ALLOW, ...OTHER_ALLOW],
): void {
  const settings = JSON.parse(raw) as {
    enableAllProjectMcpServers: boolean;
    numRetries: number;
    env: { USER_OWNED_KEY: string };
    permissions: { allow: unknown; ask: unknown; deny: unknown };
    model: string;
  };
  expect(settings.permissions.allow).toEqual(allow);
  expect(Array.isArray(settings.permissions.allow)).toBe(true);
  expect(settings.permissions.ask).toEqual(["Bash(rm *)"]);
  expect(settings.permissions.deny).toEqual(["WebFetch", OWNED_ALLOW[0]]);
  expect(Array.isArray(settings.permissions.deny)).toBe(true);
  expect(settings.env).toEqual({ USER_OWNED_KEY: "keep-me" });
  expect(settings.enableAllProjectMcpServers).toBe(false);
  expect(settings.numRetries).toBe(1);
  expect(settings.model).toBe("claude-sonnet");
}

function expectOtherLedgerKept(raw: string): void {
  const ledger = JSON.parse(raw) as {
    prod_gateway?: unknown;
    other_gateway: unknown;
    schemaVersion: number;
  };
  expect(ledger).not.toHaveProperty("prod_gateway");
  expect(ledger.other_gateway).toEqual(OTHER_ALLOW);
  expect(Array.isArray(ledger.other_gateway)).toBe(true);
  expect(ledger.schemaVersion).toBe(1);
}

describe("Claude APPA permission cleanup on MCP disconnect", () => {
  test("removes only the target server's owned allow rules and leaves the installer backup", async () => {
    const backup = '{"permissions":{"allow":["Read"]}}\n';
    const { code, cliArgs, files } = await runGuardSnippet({
      client: CLAUDE_CODE_GUARD_CLIENT,
      functions: ["disconnect_actions"],
      invoke: "disconnect_actions mcp\ndisconnect_actions mcp\n",
      files: {
        [SETTINGS_REL]: claudeSettings(),
        [LEDGER_REL]: claudeLedger(),
        [BACKUP_REL]: backup,
      },
      readFiles: [SETTINGS_REL, LEDGER_REL, BACKUP_REL],
    });

    expect(code).toBe(0);
    expect(cliArgs).toContain("mcp remove --scope user prod_gateway");
    expect(cliArgs).toContain("mcp remove --scope local prod_gateway");
    expectOwnedRulesRemoved(files[SETTINGS_REL] ?? "");
    expectOtherLedgerKept(files[LEDGER_REL] ?? "");
    expect(files[BACKUP_REL]).toBe(backup);
  });

  test("a single remaining allow rule stays a JSON array", async () => {
    const { files } = await runGuardSnippet({
      client: CLAUDE_CODE_GUARD_CLIENT,
      functions: ["disconnect_actions"],
      invoke: "disconnect_actions mcp\n",
      files: {
        [SETTINGS_REL]: claudeSettings(["Read", ...OWNED_ALLOW]),
        [LEDGER_REL]: claudeLedger({ prod_gateway: OWNED_ALLOW }),
      },
      readFiles: [SETTINGS_REL, LEDGER_REL],
    });

    const settings = JSON.parse(files[SETTINGS_REL] ?? "") as {
      permissions: { allow: unknown };
    };
    expect(settings.permissions.allow).toEqual(["Read"]);
    expect(files[LEDGER_REL]).toBeNull();
  });

  test("drops a ledger whose rules are not yet in settings", async () => {
    const settings = claudeSettings(["Read"]);
    const { files } = await runGuardSnippet({
      client: CLAUDE_CODE_GUARD_CLIENT,
      functions: ["disconnect_actions"],
      invoke: "disconnect_actions mcp\n",
      files: {
        [SETTINGS_REL]: settings,
        [LEDGER_REL]: claudeLedger({
          prod_gateway: OWNED_ALLOW,
          other_gateway: OTHER_ALLOW,
          schemaVersion: 1,
        }),
      },
      readFiles: [SETTINGS_REL, LEDGER_REL],
    });

    expect(files[SETTINGS_REL]).toBe(settings);
    expectOtherLedgerKept(files[LEDGER_REL] ?? "");
  });

  test("keeps custom-profile ownership separate from the default profile", async () => {
    const decoy = claudeSettings();
    const { files } = await runGuardSnippet({
      client: CLAUDE_CODE_GUARD_CLIENT,
      functions: ["disconnect_actions"],
      invoke: "disconnect_actions mcp\n",
      files: {
        [SETTINGS_REL]: decoy,
        "claude-cfg/settings.json": claudeSettings(),
        [LEDGER_REL]: claudeLedger(),
        "claude-cfg/.archestra/claude-appa-permissions.json": claudeLedger(),
      },
      env: { CLAUDE_CONFIG_DIR: "{HOME}/claude-cfg" },
      readFiles: [
        SETTINGS_REL,
        "claude-cfg/settings.json",
        LEDGER_REL,
        "claude-cfg/.archestra/claude-appa-permissions.json",
      ],
    });

    expect(files[SETTINGS_REL]).toBe(decoy);
    expectOwnedRulesRemoved(files["claude-cfg/settings.json"] ?? "");
    expect(files[LEDGER_REL]).toBe(claudeLedger());
    expectOtherLedgerKept(
      files["claude-cfg/.archestra/claude-appa-permissions.json"] ?? "",
    );
  });

  test("drops the target ledger entry when settings.json is missing and does not create it", async () => {
    const { files } = await runGuardSnippet({
      client: CLAUDE_CODE_GUARD_CLIENT,
      functions: ["disconnect_actions"],
      invoke: "disconnect_actions mcp\n",
      files: { [LEDGER_REL]: claudeLedger() },
      readFiles: [SETTINGS_REL, LEDGER_REL],
    });

    expect(files[SETTINGS_REL]).toBeNull();
    expectOtherLedgerKept(files[LEDGER_REL] ?? "");
  });

  test("an empty settings file drops the ledger entry without being rewritten", async () => {
    const empty = "\n";
    const { files } = await runGuardSnippet({
      client: CLAUDE_CODE_GUARD_CLIENT,
      functions: ["disconnect_actions"],
      invoke: "disconnect_actions mcp\n",
      files: { [SETTINGS_REL]: empty, [LEDGER_REL]: claudeLedger() },
      readFiles: [SETTINGS_REL, LEDGER_REL],
    });

    expect(files[SETTINGS_REL]).toBe(empty);
    expectOtherLedgerKept(files[LEDGER_REL] ?? "");
  });

  test.each([
    {
      name: "invalid settings JSON",
      settings: "{ this is not json",
      ledger: claudeLedger(),
    },
    {
      name: "invalid ledger JSON",
      settings: claudeSettings(),
      ledger: "{ this is not json",
    },
    {
      name: "ledger root is an array",
      settings: claudeSettings(),
      ledger: JSON.stringify(["prod_gateway"]),
    },
    {
      name: "target ledger value is not a string array",
      settings: claudeSettings(),
      ledger: JSON.stringify({
        prod_gateway: "mcp__prod_gateway__archestra__yell",
        other_gateway: OTHER_ALLOW,
      }),
    },
    {
      name: "allow is not a string array",
      settings: JSON.stringify({
        permissions: { allow: "Read", deny: ["WebFetch"] },
        env: { USER_OWNED_KEY: "keep-me" },
      }),
      ledger: claudeLedger(),
    },
    {
      name: "permissions is not an object",
      settings: JSON.stringify({
        permissions: ["Read"],
        env: { USER_OWNED_KEY: "keep-me" },
      }),
      ledger: claudeLedger(),
    },
  ])("$name does not clobber settings or the ledger", async ({
    settings,
    ledger,
  }) => {
    const { code, files } = await runGuardSnippet({
      client: CLAUDE_CODE_GUARD_CLIENT,
      functions: ["disconnect_actions"],
      invoke: "disconnect_actions mcp\n",
      files: { [SETTINGS_REL]: settings, [LEDGER_REL]: ledger },
      readFiles: [SETTINGS_REL, LEDGER_REL],
    });

    expect(code).toBe(0);
    expect(files[SETTINGS_REL]).toBe(settings);
    expect(files[LEDGER_REL]).toBe(ledger);
  });

  test("a server name containing quotes is cleaned only as that ledger key", async () => {
    const tricky = `acme's_"gw"`;
    const owned = [`mcp__${tricky}__archestra__yell`];
    const { files } = await runGuardSnippet({
      client: CLAUDE_CODE_GUARD_CLIENT,
      functions: ["disconnect_actions"],
      invoke: `MCP_SERVER_NAME=${JSON.stringify(tricky)}\ndisconnect_actions mcp\n`,
      files: {
        [SETTINGS_REL]: JSON.stringify({
          permissions: { allow: [...owned, "Read"], deny: ["WebFetch"] },
        }),
        [LEDGER_REL]: JSON.stringify({
          [tricky]: owned,
          other_gateway: OTHER_ALLOW,
        }),
      },
      readFiles: [SETTINGS_REL, LEDGER_REL],
    });

    expect(JSON.parse(files[SETTINGS_REL] ?? "").permissions).toEqual({
      allow: ["Read"],
      deny: ["WebFetch"],
    });
    expect(JSON.parse(files[LEDGER_REL] ?? "")).toEqual({
      other_gateway: OTHER_ALLOW,
    });
  });

  test("proxy and skills disconnect do not strip installer-owned allow rules", async () => {
    const settings = claudeSettings();
    const ledger = claudeLedger();
    const proxy = await runGuardSnippet({
      client: CLAUDE_CODE_GUARD_CLIENT,
      functions: ["disconnect_actions", "disconnect_proxy"],
      invoke: "disconnect_actions proxy\n",
      files: { [SETTINGS_REL]: settings, [LEDGER_REL]: ledger },
      readFiles: [SETTINGS_REL, LEDGER_REL],
    });
    const skills = await runGuardSnippet({
      client: CLAUDE_CODE_GUARD_CLIENT,
      functions: ["disconnect_actions"],
      invoke: "disconnect_actions skills\n",
      files: { [SETTINGS_REL]: settings, [LEDGER_REL]: ledger },
      readFiles: [SETTINGS_REL, LEDGER_REL],
    });

    expect(proxy.code).toBe(0);
    expect(proxy.files[LEDGER_REL]).toBe(ledger);
    expect(
      JSON.parse(proxy.files[SETTINGS_REL] ?? "").permissions.allow,
    ).toEqual(JSON.parse(settings).permissions.allow);
    expect(skills.code).toBe(0);
    expect(skills.files[SETTINGS_REL]).toBe(settings);
    expect(skills.files[LEDGER_REL]).toBe(ledger);
  });

  test("missing python3 skips cleanup without failing the mcp removal", async () => {
    const settings = claudeSettings();
    const ledger = claudeLedger();
    const { code, cliArgs, files } = await runGuardSnippet({
      client: CLAUDE_CODE_GUARD_CLIENT,
      functions: ["disconnect_actions"],
      invoke: "disconnect_actions mcp\n",
      isolatePath: true,
      files: { [SETTINGS_REL]: settings, [LEDGER_REL]: ledger },
      readFiles: [SETTINGS_REL, LEDGER_REL],
    });

    expect(code).toBe(0);
    expect(cliArgs).toContain("mcp remove --scope user prod_gateway");
    expect(files[SETTINGS_REL]).toBe(settings);
    expect(files[LEDGER_REL]).toBe(ledger);
  });

  test("the rendered guard is valid bash and the cleanup is not in proxy disconnect", async () => {
    const script = renderStartupGuardScript(CTX, CLAUDE_CODE_GUARD_CLIENT);
    await expectValidBash(script);
    const proxy = extractShellFunction(script, "disconnect_proxy");
    expect(proxy).not.toContain("claude-appa-permissions.json");
    expect(extractShellFunction(script, "disconnect_actions")).toContain(
      "claude-appa-permissions.json",
    );
  });
});

function pwshBin(): string | null {
  const candidates = [
    ...(process.platform === "win32" ? ["powershell.exe"] : []),
    "pwsh",
    "/home/archestra/.local/bin/pwsh",
  ];
  for (const candidate of candidates) {
    if (
      spawnSync(candidate, ["-NoProfile", "-Command", "exit 0"], {
        timeout: 15_000,
      }).status === 0
    ) {
      return candidate;
    }
  }
  return null;
}

const powershellBin = pwshBin();

if (process.env.CI === "true" && !powershellBin) {
  throw new Error("CI requires a working PowerShell runtime for these tests");
}

function extractPowerShellFunction(script: string, name: string): string {
  const start = script.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`no ${name} in rendered PowerShell`);
  const open = script.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < script.length; i++) {
    if (script[i] === "{") depth++;
    else if (script[i] === "}") {
      depth--;
      if (depth === 0) return script.slice(start, i + 1);
    }
  }
  throw new Error(`${name} is never closed`);
}

function psSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function runWindowsMcpCleanup(params: {
  files: Record<string, string>;
  readFiles: string[];
  claudeConfigDir?: string;
  serverName?: string;
}): Promise<Record<string, string | null>> {
  const action = extractPowerShellFunction(
    renderStartupGuardPowerShell(CTX, CLAUDE_CODE_GUARD_CLIENT),
    "Invoke-ArchDisconnectActions",
  );
  const dir = await mkdtemp(path.join(tmpdir(), "archestra-appa-ps-"));
  const home = path.join(dir, "home");
  try {
    await mkdir(home, { recursive: true });
    for (const [relpath, content] of Object.entries(params.files)) {
      const target = path.join(home, relpath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    const driver = path.join(dir, "driver.ps1");
    const claudeConfigDir = (params.claudeConfigDir ?? "").replaceAll(
      "{HOME}",
      home,
    );
    await writeFile(
      driver,
      [
        "$ErrorActionPreference = 'Stop'",
        "function Get-ArchRealExe { return @{ Source = 'arch-claude-stub-not-real' } }",
        "function Test-ArchDisconnected { return $true }",
        `$McpServerName = ${psSingleQuote(params.serverName ?? "prod_gateway")}`,
        action,
        "Invoke-ArchDisconnectActions 'mcp' | Out-Null",
      ].join("\n"),
      "utf8",
    );
    await execFileAsync(
      powershellBin ?? "pwsh",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", driver],
      {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          CLAUDE_CONFIG_DIR: claudeConfigDir,
        },
        timeout: 30_000,
      },
    );
    const out: Record<string, string | null> = {};
    for (const relpath of params.readFiles) {
      try {
        out[relpath] = await readFile(path.join(home, relpath), "utf8");
      } catch {
        out[relpath] = null;
      }
    }
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!powershellBin)(
  "Claude APPA permission cleanup on Windows MCP disconnect",
  () => {
    test("serializes wrapped CLR collections without a version-dependent reflection serializer", async () => {
      const serializer = extractPowerShellFunction(
        renderStartupGuardPowerShell(CTX, CLAUDE_CODE_GUARD_CLIENT),
        "ConvertTo-ArchClaudeJson",
      );
      const result = await execFileAsync(
        powershellBin ?? "pwsh",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$ErrorActionPreference = 'Stop'
${serializer}
$PSVersionTable.PSVersion = [version]'5.1'
$value = New-Object 'System.Collections.Generic.Dictionary[string,object]'
$empty = [object[]]@()
$value['empty'] = [psobject]::AsPSObject($empty)
$value['allow'] = [psobject]::AsPSObject([object[]]@('Read'))
$value['deny'] = [object[]]@('Bash')
$value['nil'] = $null
$value['flag'] = $false
ConvertTo-ArchClaudeJson ([psobject]::AsPSObject($value))`,
        ],
        { timeout: 30_000 },
      );
      expect(JSON.parse(result.stdout)).toEqual({
        empty: [],
        allow: ["Read"],
        deny: ["Bash"],
        nil: null,
        flag: false,
      });
    });

    test("removes only the target server's owned allow rules", async () => {
      const backup = '{"permissions":{"allow":["Read"]}}\n';
      const files = await runWindowsMcpCleanup({
        files: {
          [SETTINGS_REL]: claudeSettings(),
          [LEDGER_REL]: claudeLedger(),
          [BACKUP_REL]: backup,
        },
        readFiles: [SETTINGS_REL, LEDGER_REL, BACKUP_REL],
      });

      expectOwnedRulesRemoved(files[SETTINGS_REL] ?? "");
      expectOtherLedgerKept(files[LEDGER_REL] ?? "");
      expect(files[BACKUP_REL]).toBe(backup);
    });

    test("a single remaining allow rule stays a JSON array", async () => {
      const files = await runWindowsMcpCleanup({
        files: {
          [SETTINGS_REL]: claudeSettings(["Read", ...OWNED_ALLOW]),
          [LEDGER_REL]: claudeLedger({ prod_gateway: OWNED_ALLOW }),
        },
        readFiles: [SETTINGS_REL, LEDGER_REL],
      });

      expect(JSON.parse(files[SETTINGS_REL] ?? "").permissions.allow).toEqual([
        "Read",
      ]);
      expect(files[LEDGER_REL]).toBeNull();
    });

    test("drops a ledger whose rules are not yet in settings", async () => {
      const settings = claudeSettings(["Read"]);
      const files = await runWindowsMcpCleanup({
        files: {
          [SETTINGS_REL]: settings,
          [LEDGER_REL]: claudeLedger({
            prod_gateway: OWNED_ALLOW,
            other_gateway: OTHER_ALLOW,
            schemaVersion: 1,
          }),
        },
        readFiles: [SETTINGS_REL, LEDGER_REL],
      });

      expect(files[SETTINGS_REL]).toBe(settings);
      expectOtherLedgerKept(files[LEDGER_REL] ?? "");
    });

    test("keeps custom-profile ownership separate from the default profile", async () => {
      const decoy = claudeSettings();
      const files = await runWindowsMcpCleanup({
        files: {
          [SETTINGS_REL]: decoy,
          "claude-cfg/settings.json": claudeSettings(),
          [LEDGER_REL]: claudeLedger(),
          "claude-cfg/.archestra/claude-appa-permissions.json": claudeLedger(),
        },
        readFiles: [
          SETTINGS_REL,
          "claude-cfg/settings.json",
          LEDGER_REL,
          "claude-cfg/.archestra/claude-appa-permissions.json",
        ],
        claudeConfigDir: "{HOME}/claude-cfg",
      });

      expect(files[SETTINGS_REL]).toBe(decoy);
      expectOwnedRulesRemoved(files["claude-cfg/settings.json"] ?? "");
      expect(files[LEDGER_REL]).toBe(claudeLedger());
      expectOtherLedgerKept(
        files["claude-cfg/.archestra/claude-appa-permissions.json"] ?? "",
      );
    });

    test("drops the ledger entry when settings are missing and does not clobber invalid JSON", async () => {
      const missing = await runWindowsMcpCleanup({
        files: { [LEDGER_REL]: claudeLedger() },
        readFiles: [SETTINGS_REL, LEDGER_REL],
      });
      expect(missing[SETTINGS_REL]).toBeNull();
      expectOtherLedgerKept(missing[LEDGER_REL] ?? "");

      const settings = "{ this is not json";
      const ledger = claudeLedger();
      const invalid = await runWindowsMcpCleanup({
        files: { [SETTINGS_REL]: settings, [LEDGER_REL]: ledger },
        readFiles: [SETTINGS_REL, LEDGER_REL],
      });
      expect(invalid[SETTINGS_REL]).toBe(settings);
      expect(invalid[LEDGER_REL]).toBe(ledger);
    });

    test("the rendered guard parses", async () => {
      const dir = await mkdtemp(
        path.join(tmpdir(), "archestra-appa-ps-parse-"),
      );
      const file = path.join(dir, "guard.ps1");
      try {
        await writeFile(
          file,
          renderStartupGuardPowerShell(CTX, CLAUDE_CODE_GUARD_CLIENT),
          "utf8",
        );
        const checker = path.join(dir, "parse.ps1");
        await writeFile(
          checker,
          `$tokens = $null
$errors = $null
$path = ${psSingleQuote(file)}
$null = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
if ($errors) { $errors | ForEach-Object { Write-Output $_.ToString() }; exit 1 }
exit 0
`,
          "utf8",
        );
        await execFileAsync(
          powershellBin ?? "pwsh",
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", checker],
          { timeout: 30_000 },
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  },
);
