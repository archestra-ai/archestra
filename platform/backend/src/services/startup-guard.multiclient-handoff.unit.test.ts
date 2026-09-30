import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DEFAULT_RUNTIME_HANDOFF_INSTRUCTIONS } from "@archestra/shared/consts";
import { parse as parseToml } from "smol-toml";
import { expect, test } from "vitest";
import { CODEX_HANDOFF_HELPER } from "./codex-handoff";
import { renderSetupScript } from "./connection-setup-script";
import {
  buildStartupGuardInstallSection,
  type StartupGuardContext,
} from "./startup-guard";
import {
  CODEX_GUARD_CLIENT,
  COPILOT_GUARD_CLIENT,
} from "./startup-guard.clients";

const exec = promisify(execFile);

test("Windows npm Codex shim preserves multiword handoff config at launch", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex shim "));
  const shim = path.join(home, "codex.cmd");
  const entry = path.join(home, "node_modules/@openai/codex/bin/codex.js");
  const helper = path.join(home, "handoff.cjs");
  const result = path.join(home, "args.json");
  const marker = path.join(home, "launched");
  const args = [
    "-c",
    `developer_instructions=${JSON.stringify(DEFAULT_RUNTIME_HANDOFF_INSTRUCTIONS)}`,
    "-c",
    "model_provider=llm_proxy",
    "exec",
    "hello",
  ];
  try {
    await mkdir(path.dirname(entry), { recursive: true });
    await writeFile(shim, "npm shim placeholder");
    await writeFile(
      entry,
      "require('node:fs').writeFileSync(process.env.CODEX_TEST_RESULT, JSON.stringify({args:process.argv.slice(2),marker:process.env.ARCHESTRA_CODEX_LAUNCH_MARKER,codexHome:process.env.CODEX_HOME,path:process.env.PATH})); process.exit(23);",
    );
    await writeFile(helper, CODEX_HANDOFF_HELPER);
    await expect(
      exec(process.execPath, [helper, "--launch", shim], {
        env: {
          ...process.env,
          CODEX_HOME: home,
          CODEX_TEST_RESULT: result,
          ARCHESTRA_CODEX_LAUNCH_MARKER: marker,
          ARCHESTRA_CODEX_LAUNCH_ARGS: Buffer.from(
            JSON.stringify(args),
          ).toString("base64"),
        },
      }),
    ).rejects.toMatchObject({ code: 23 });
    expect(JSON.parse(await readFile(result, "utf8"))).toEqual({
      args,
      codexHome: home,
      path: process.env.PATH,
    });
    expect(await readFile(marker, "utf8")).toBe("");

    await writeFile(entry, "process.exit(125);");
    const exitMarker = path.join(home, "exit-125");
    await expect(
      exec(process.execPath, [helper, "--launch", shim], {
        env: {
          ...process.env,
          ARCHESTRA_CODEX_LAUNCH_MARKER: exitMarker,
          ARCHESTRA_CODEX_LAUNCH_ARGS: Buffer.from(
            JSON.stringify(args),
          ).toString("base64"),
        },
      }),
    ).rejects.toMatchObject({ code: 125 });
    expect(await readFile(exitMarker, "utf8")).toBe("");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Windows npm Codex shim prepares every model for direct calls", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex direct "));
  const shim = path.join(home, "codex.cmd");
  const entry = path.join(home, "node_modules/@openai/codex/bin/codex.js");
  const helper = path.join(home, "handoff.cjs");
  const codexHome = path.join(home, "config with spaces");
  try {
    await mkdir(path.dirname(entry), { recursive: true });
    await writeFile(shim, "npm shim placeholder");
    await writeFile(
      entry,
      `if (process.argv[2] !== 'debug') process.exit(1);
require('node:fs').writeFileSync(require('node:path').join(process.env.CODEX_HOME, 'models_cache.json'), JSON.stringify({fetched_at:new Date().toISOString()}));
process.stdout.write(JSON.stringify({models:[{slug:'one',tool_mode:'code_mode_only',supports_search_tool:true},{slug:'two',tool_mode:null,supports_search_tool:true}]}));`,
    );
    await writeFile(helper, CODEX_HANDOFF_HELPER);
    const { stdout } = await exec(
      process.execPath,
      [helper, "--direct", shim, "--output-base64"],
      { env: { ...process.env, CODEX_HOME: codexHome } },
    );
    const config = Buffer.from(stdout, "base64").toString("utf8");
    const catalog = JSON.parse(
      await readFile(JSON.parse(config.split("=")[1]), "utf8"),
    );
    expect(catalog.models).toEqual([
      { slug: "one", tool_mode: "direct", supports_search_tool: false },
      { slug: "two", tool_mode: "direct", supports_search_tool: false },
    ]);
    await writeFile(entry, "process.stdout.write('{}');");
    await expect(
      exec(process.execPath, [helper, "--direct", shim], {
        env: { ...process.env, CODEX_HOME: codexHome },
      }),
    ).rejects.toMatchObject({ code: 1 });
    expect(
      JSON.parse(await readFile(JSON.parse(config.split("=")[1]), "utf8")),
    ).toEqual(catalog);
    await rm(JSON.parse(config.split("=")[1]));
    await expect(
      exec(process.execPath, [helper, "--direct", shim], {
        env: { ...process.env, CODEX_HOME: codexHome },
      }),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      readFile(JSON.parse(config.split("=")[1]), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Codex setup keeps fetched-only models direct in bare probes and restores user config on disconnect", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex fetched "));
  const entry = path.join(home, "codex.cmd");
  const cli = path.join(home, "node_modules/@openai/codex/bin/codex.js");
  const helper = path.join(home, "handoff.cjs");
  const codexHome = path.join(home, "config with spaces");
  const configFile = path.join(codexHome, "config.toml");
  const original = `model = "gpt-6-luna"
model_provider = "user-provider"
web_search = "live"
model_catalog_json = "user-models.json"
approval_policy = "never"
approvals_reviewer = "auto_review"
sandbox_mode = "danger-full-access"
[features]
js_repl = false
code_mode_host = true
[tools]
apply_patch_tool_type = "freeform"
other_tool = "keep"
`;
  try {
    await mkdir(path.dirname(cli), { recursive: true });
    await mkdir(codexHome);
    await writeFile(entry, "npm shim placeholder");
    await writeFile(
      cli,
      `if (process.argv[2] !== 'debug') process.exit(1);
require('node:fs').writeFileSync(require('node:path').join(process.env.CODEX_HOME, 'models_cache.json'), JSON.stringify({fetched_at:new Date().toISOString()}));
process.stdout.write(JSON.stringify({models:process.argv.includes('--bundled') ? [{slug:'old',tool_mode:null}] : [{slug:'old',tool_mode:null},{slug:'gpt-6-luna',tool_mode:'code_mode_only',supports_search_tool:true}]}));`,
    );
    await writeFile(helper, CODEX_HANDOFF_HELPER);
    await writeFile(configFile, original);
    const env = { ...process.env, CODEX_HOME: codexHome };
    await exec(process.execPath, [helper, "--install-direct", entry], { env });
    const installed = await readFile(configFile, "utf8");
    const config = parseToml(installed);
    expect(config).toMatchObject({
      model: "gpt-6-luna",
      model_provider: "user-provider",
      web_search: "disabled",
      approval_policy: "never",
      approvals_reviewer: "auto_review",
      sandbox_mode: "danger-full-access",
      features: {
        js_repl: false,
        code_mode_host: false,
      },
      tools: { apply_patch_tool_type: "freeform", other_tool: "keep" },
    });
    expect(
      JSON.parse(await readFile(config.model_catalog_json as string, "utf8"))
        .models,
    ).toEqual([
      { slug: "old", tool_mode: "direct", supports_search_tool: false },
      { slug: "gpt-6-luna", tool_mode: "direct", supports_search_tool: false },
    ]);
    await writeFile(
      cli,
      `console.log(JSON.stringify({models:[{slug:'gpt-6-luna',tool_mode:'code_mode_only'}]}));`,
    );
    // Codex can exit successfully with a bundled fallback; that is not a refresh.
    await expect(
      exec(process.execPath, [helper, "--direct", entry], { env }),
    ).rejects.toMatchObject({ code: 1 });
    await writeFile(
      cli,
      `require('node:fs').writeFileSync(require('node:path').join(process.env.CODEX_HOME,'models_cache.json'),JSON.stringify({fetched_at:new Date(Date.now()-60000).toISOString()}));console.log(JSON.stringify({models:[{slug:'gpt-6-luna',tool_mode:'code_mode_only'}]}));`,
    );
    await expect(
      exec(process.execPath, [helper, "--direct", entry], { env }),
    ).rejects.toMatchObject({ code: 1 });
    expect(
      JSON.parse(await readFile(config.model_catalog_json as string, "utf8"))
        .models,
    ).toHaveLength(2);
    await writeFile(
      cli,
      `require('node:fs').writeFileSync(require('node:path').join(process.env.CODEX_HOME,'models_cache.json'),JSON.stringify({fetched_at:new Date(Date.now()-500).toISOString()}));console.log(JSON.stringify({models:[{slug:'gpt-6-luna',tool_mode:'code_mode_only'}]}));`,
    );
    await expect(
      exec(process.execPath, [helper, "--direct", entry], { env }),
    ).resolves.toBeDefined();
    await writeFile(cli, "process.exit(99);");
    await expect(
      exec(process.execPath, [helper, "--direct", entry], { env }),
    ).rejects.toMatchObject({ code: 1 });
    await writeFile(
      path.join(codexHome, "auth.json"),
      JSON.stringify({ tokens: { access_token: "fixture-original" } }),
    );
    await writeFile(
      cli,
      `const fs = require('node:fs');
const path = require('node:path');
if (process.argv[2] !== 'debug') process.exit(1);
const config = fs.readFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8');
if (config.includes('model_catalog_json') || fs.existsSync(path.join(process.env.CODEX_HOME, 'models_cache.json'))) process.exit(98);
fs.writeFileSync(${JSON.stringify(path.join(home, "refresh-home"))}, process.env.CODEX_HOME);
fs.writeFileSync(path.join(process.env.CODEX_HOME, 'models_cache.json'), JSON.stringify({fetched_at:new Date().toISOString()}));
fs.writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify({tokens:{access_token:'fixture-refreshed'}}));
process.stdout.write(JSON.stringify({models:[{slug:'gpt-6-luna',tool_mode:'code_mode_only'}, {slug:'newly-released',tool_mode:'code_mode_only',supports_search_tool:true}]}));`,
    );
    await exec(
      process.execPath,
      [helper, "--direct", entry, "-m", "newly-released"],
      { env },
    );
    expect(
      JSON.parse(await readFile(config.model_catalog_json as string, "utf8"))
        .models,
    ).toContainEqual({
      slug: "newly-released",
      tool_mode: "direct",
      supports_search_tool: false,
    });
    const refreshHome = await readFile(path.join(home, "refresh-home"), "utf8");
    await expect(
      readFile(path.join(refreshHome, "config.toml")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      JSON.parse(await readFile(path.join(codexHome, "auth.json"), "utf8")),
    ).toEqual({ tokens: { access_token: "fixture-refreshed" } });
    await expect(
      exec(
        process.execPath,
        [helper, "--direct", entry, "--model=missing-model"],
        { env },
      ),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      exec(
        process.execPath,
        [helper, "--direct", entry, "-c", 'model="missing-model"'],
        { env },
      ),
    ).rejects.toMatchObject({ code: 1 });
    await writeFile(
      configFile,
      `${installed}\n[profiles.future]\nmodel = "missing-model"\n`,
    );
    await expect(
      exec(
        process.execPath,
        [helper, "--direct", entry, "--profile", "future"],
        { env },
      ),
    ).rejects.toMatchObject({ code: 1 });
    await writeFile(configFile, installed);
    await expect(
      exec(
        process.execPath,
        [helper, "--direct", entry, "-m", "openai-codex/newly-released-dated"],
        { env },
      ),
    ).resolves.toBeDefined();
    await exec(process.execPath, [helper, "--install-direct", entry], { env });
    expect(parseToml(await readFile(configFile, "utf8"))).toEqual(config);
    await exec(process.execPath, [helper, "--remove-direct"], { env });
    expect(parseToml(await readFile(configFile, "utf8"))).toEqual(
      parseToml(original),
    );
    await expect(
      readFile(config.model_catalog_json as string),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await writeFile(
      configFile,
      original.replace(
        'approval_policy = "never"',
        'approval_policy = "on-request"',
      ),
    );
    await exec(process.execPath, [helper, "--install-direct", entry], { env });
    const existingPrompts = parseToml(await readFile(configFile, "utf8"));
    expect(existingPrompts.approval_policy).toBe("on-request");
    expect(existingPrompts.approvals_reviewer).toBe("auto_review");

    const multiline = [
      'model = "gpt-6-luna"',
      'developer_instructions = """',
      "[features]",
      "code_mode_host = true",
      '"""',
      "features.js_repl = false",
      "features.code_mode_host = true",
      "",
    ].join("\r\n");
    await writeFile(configFile, multiline);
    await exec(process.execPath, [helper, "--install-direct", entry], { env });
    const installedMultiline = await readFile(configFile, "utf8");
    expect(parseToml(installedMultiline)).toMatchObject({
      developer_instructions: "[features]\r\ncode_mode_host = true\r\n",
      features: { js_repl: false, code_mode_host: false },
    });
    expect(installedMultiline.match(/\[features\]/g)).toHaveLength(1);
    expect(installedMultiline.replaceAll("\r\n", "")).not.toContain("\n");
    await exec(process.execPath, [helper, "--remove-direct"], { env });
    expect(parseToml(await readFile(configFile, "utf8"))).toEqual(
      parseToml(multiline),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

for (const shell of ["bash", "zsh"]) {
  for (const client of [CODEX_GUARD_CLIENT, COPILOT_GUARD_CLIENT]) {
    test(`${shell} ${client.binary} adds handoff without replacing user instructions`, async () => {
      const home = await mkdtemp(path.join(tmpdir(), "handoff client "));
      const instructions = 'Offer remote work.\n"quoted" $HOME 雪';
      const ctx: StartupGuardContext = {
        appName: "Test Platform",
        healthUrl: null,
        proxy:
          client.clientId === "codex"
            ? {
                provider: "openai",
                providerLabel: "OpenAI",
                url: "https://example.com/v1/openai/profile",
                ref: "profile",
                proxyName: "llm_proxy",
              }
            : null,
        skills: null,
        mcp: {
          serverName: "gateway",
          url: "https://example.com/mcp",
          ref: "gateway",
        },
        runtimeHandoffInstructions: instructions,
      };
      const env = {
        ...process.env,
        HOME: home,
        ZDOTDIR: home,
        SHELL: `/bin/${shell}`,
        PATH: `${home}:${process.env.PATH}`,
        CODEX_HOME: path.join(home, "custom codex"),
        COPILOT_CUSTOM_INSTRUCTIONS_DIRS: "/existing/rules,/another/rules",
        ARCHESTRA_CODEX_GUARD: "0",
        ARCHESTRA_COPILOT_GUARD: "0",
        ARCH_C_OK: "",
        ARCH_C_RESET: "",
      };
      const profile = shell === "zsh" ? ".zshrc" : ".bashrc";
      const install = async (context: StartupGuardContext) => {
        const script = path.join(home, "install.sh");
        await writeFile(
          script,
          `set -eu\nsay() { :; }; ok() { :; }\n${buildStartupGuardInstallSection(context, client)}`,
        );
        await exec("bash", [script], { env });
      };
      const launch = async (args: string[], mode = "success") => {
        await expect(
          exec(
            shell,
            [
              "-c",
              `source "$HOME/${profile}"; ${client.binary} "$@"`,
              "test",
              ...args,
            ],
            { cwd: home, env: { ...env, HANDOFF_MODE: mode } },
          ),
        ).rejects.toMatchObject({ code: 23 });
        const result = JSON.parse(
          await readFile(path.join(home, "result.json"), "utf8"),
        );
        if (
          client.clientId === "codex" &&
          result.args[1] === "features.code_mode_host=false"
        ) {
          result.directArgs = result.args.splice(0, 6);
        }
        return result;
      };
      try {
        await mkdir(env.CODEX_HOME);
        await writeFile(
          path.join(env.CODEX_HOME, "AGENTS.md"),
          "User guidance stays intact.",
        );
        await writeFile(
          path.join(home, client.binary),
          `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.argv[2] === 'app-server') {
  require('node:readline').createInterface({input:process.stdin}).on('line', line => {
    const request = JSON.parse(line);
    if (request.method === 'initialize') console.log(JSON.stringify({id:request.id,result:{}}));
    if (request.method === 'config/read') {
      fs.writeFileSync(path.join(process.env.HOME, 'read.json'), JSON.stringify({cwd:request.params.cwd,home:process.env.CODEX_HOME}));
      if (process.env.HANDOFF_MODE === 'timeout') return;
      console.log(JSON.stringify(process.env.HANDOFF_MODE === 'error' ? {id:request.id,error:{code:-1}} : {id:request.id,result:{config:{developer_instructions:'Keep existing rules.\\nUse tests.'}}}));
    }
  });
} else {
  if (process.argv.includes('debug')) {
    if (process.env.HANDOFF_MODE === 'bad-catalog') {
      process.stdout.write('{}');
      process.exit(0);
    }
    fs.writeFileSync(path.join(process.env.CODEX_HOME, 'models_cache.json'), JSON.stringify({fetched_at:new Date().toISOString()}));
    process.stdout.write(JSON.stringify({models:[{slug:'selected',tool_mode:'code_mode_only',supports_search_tool:true},{slug:'other',tool_mode:null}]}));
    process.exit(0);
  }
  fs.writeFileSync(path.join(process.env.HOME, 'result.json'), JSON.stringify({args:process.argv.slice(2),dirs:process.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS}));
  process.exit(23);
}
`,
        );
        await chmod(path.join(home, client.binary), 0o755);
        await install(ctx);
        await install(ctx);
        const args = [
          client.clientId === "codex" ? "exec" : "-p",
          "two words",
          "$literal",
        ];
        const result = await launch(args);
        if (client.clientId === "codex") {
          const config = result.directArgs;
          expect(config.slice(0, 4)).toEqual([
            "-c",
            "features.code_mode_host=false",
            "-c",
            'web_search="disabled"',
          ]);
          expect(config[4]).toBe("-c");
          expect(config[5]).toMatch(/^model_catalog_json=/);
          expect(
            JSON.parse(
              await readFile(JSON.parse(config[5].split("=")[1]), "utf8"),
            ).models,
          ).toEqual([
            {
              slug: "selected",
              tool_mode: "direct",
              supports_search_tool: false,
            },
            { slug: "other", tool_mode: "direct", supports_search_tool: false },
          ]);
          expect(result.args).toEqual([
            "-c",
            `developer_instructions=${JSON.stringify(`Keep existing rules.\nUse tests.\n\n${instructions}`)}`,
            ...args,
          ]);
          expect(
            JSON.parse(await readFile(path.join(home, "read.json"), "utf8")),
          ).toEqual({ cwd: await realpath(home), home: env.CODEX_HOME });
          const encoded = await exec(
            process.execPath,
            [
              path.join(home, `${client.scriptRelpath}.handoff.cjs`),
              path.join(home, `${client.scriptRelpath}.prompt.md`),
              "--output-base64",
            ],
            { cwd: home, env },
          );
          expect(Buffer.from(encoded.stdout, "base64").toString("utf8")).toBe(
            `developer_instructions=${JSON.stringify(`Keep existing rules.\nUse tests.\n\n${instructions}`)}`,
          );
          expect((await launch(args, "error")).args).toEqual(args);
          const providerArgs = ["-c", 'model_provider="gateway"', ...args];
          expect((await launch(providerArgs)).args).toEqual([
            ...result.args.slice(0, 2),
            ...providerArgs,
          ]);
          if (shell === "bash") {
            expect((await launch(args, "timeout")).args).toEqual(args);
          }
          for (const flags of [
            ["-c", 'developer_instructions="mine"'],
            ["--config=developer_instructions=mine"],
            ["--profile", "custom"],
            ["-C", "/elsewhere"],
          ]) {
            expect((await launch(flags)).args).toEqual(flags);
          }
          expect((await launch(["-m", "other", ...args])).args).toEqual([
            ...result.args.slice(0, 2),
            "-m",
            "other",
            ...args,
          ]);
          await expect(
            exec(
              shell,
              ["-c", `source "$HOME/${profile}"; codex "$@"`, "test", ...args],
              { cwd: home, env: { ...env, HANDOFF_MODE: "bad-catalog" } },
            ),
          ).rejects.toMatchObject({ code: 1 });
          await writeFile(path.join(home, client.skipRelpath), "proxy\n");
          const withoutProxy = await launch(args);
          expect(withoutProxy.args).toEqual(result.args);
          expect(withoutProxy.directArgs).toBeUndefined();
        } else {
          expect(result.args).toEqual(args);
          const directory = path.join(
            home,
            `${client.scriptRelpath}.instructions`,
          );
          expect(result.dirs).toBe(
            `${env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS},${directory}`,
          );
          expect(
            await readFile(path.join(directory, "AGENTS.md"), "utf8"),
          ).toBe(instructions);
        }
        const management = await launch(["mcp", "list"]);
        expect(management.args).toEqual(["mcp", "list"]);
        expect(management.dirs).toBe(env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS);
        if (client.clientId === "codex") {
          const debug = await exec(
            shell,
            ["-c", `source "$HOME/${profile}"; codex debug models --bundled`],
            { cwd: home, env },
          );
          expect(JSON.parse(debug.stdout).models[0].tool_mode).toBe(
            "code_mode_only",
          );
        }
        await writeFile(path.join(home, client.skipRelpath), "mcp\n");
        const disconnected = await launch(args);
        expect(disconnected.args).toEqual(args);
        if (client.clientId === "codex")
          expect(disconnected.directArgs).toEqual(result.directArgs);
        expect(disconnected.dirs).toBe(env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS);
        await install({ ...ctx, runtimeHandoffInstructions: null });
        const disabled = await launch(args);
        expect(disabled.args).toEqual(args);
        if (client.clientId === "codex")
          expect(disabled.directArgs).toEqual(result.directArgs);
        expect(disabled.dirs).toBe(env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS);
        expect(
          await readFile(path.join(env.CODEX_HOME, "AGENTS.md"), "utf8"),
        ).toBe("User guidance stays intact.");
        if (client.clientId === "codex") {
          await rm(path.join(home, "result.json"));
          await rm(path.join(home, `${client.scriptRelpath}.handoff.cjs`));
          await expect(
            exec(shell, ["-c", `source "$HOME/${profile}"; codex exec check`], {
              cwd: home,
              env,
            }),
          ).rejects.toMatchObject({ code: 1 });
          await expect(
            readFile(path.join(home, "result.json")),
          ).rejects.toMatchObject({ code: "ENOENT" });
        }
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });
  }
}

test("Cursor prints literal instructions for manual User Rules without editing project rules", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cursor-handoff-"));
  try {
    const instructions =
      'Offer handoff.\n\'\n$(touch "$HOME/injected")\nARCHESTRA_CURSOR';
    const script = path.join(home, "setup.sh");
    await writeFile(
      script,
      renderSetupScript({
        clientId: "cursor",
        platform: "linux",
        appName: "Test Platform",
        mcp: { serverName: "gateway", url: "https://example.com/mcp" },
        proxy: null,
        skills: null,
        runtimeHandoffInstructions: instructions,
      }),
    );
    const { stdout } = await exec("bash", [script], {
      cwd: home,
      env: { ...process.env, HOME: home },
    });
    expect(stdout).toContain(instructions);
    expect(stdout).toContain("Customize > Rules > User Rules");
    await expect(readFile(path.join(home, "injected"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(path.join(home, ".cursor/rules")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
