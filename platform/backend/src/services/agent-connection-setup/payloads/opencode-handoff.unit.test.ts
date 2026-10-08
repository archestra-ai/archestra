import { execFile, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { DEFAULT_RUNTIME_HANDOFF_INSTRUCTIONS } from "@archestra/shared/consts";
import { expect, test, vi } from "vitest";
import { OPENCODE_GUARD_CLIENT } from "../guard/clients";
import {
  buildStartupGuardInstallSection,
  type StartupGuardContext,
} from "../guard/startup-guard";
import { buildWindowsStartupGuardInstallSection } from "../guard/startup-guard.windows";
import { OPENCODE_HANDOFF_PLUGIN } from "./opencode-handoff";

const exec = promisify(execFile);
const client = OPENCODE_GUARD_CLIENT;
const ctx: StartupGuardContext = {
  appName: "Test Platform",
  healthUrl: null,
  proxy: null,
  skills: null,
  mcp: {
    serverName: "gateway",
    url: "https://example.com/mcp",
    ref: "gateway",
  },
  runtimeHandoffInstructions: DEFAULT_RUNTIME_HANDOFF_INSTRUCTIONS,
};

test.each([
  DEFAULT_RUNTIME_HANDOFF_INSTRUCTIONS,
  'Custom handoff.\n"quoted" $HOME',
])("handoff guidance reaches roots but not tool-free or nested children", async (instructions) => {
  const home = await mkdtemp(path.join(tmpdir(), "opencode handoff "));
  const plugin = path.join(home, "guard.handoff.mjs");
  const prompt = path.join(home, "guard.prompt.md");
  try {
    await writeFile(plugin, OPENCODE_HANDOFF_PLUGIN);
    await writeFile(prompt, instructions);
    const module = await import(pathToFileURL(plugin).href);
    const get = vi.fn(async ({ path: { id } }: { path: { id: string } }) => ({
      data: {
        id,
        ...(id === "root"
          ? {}
          : { parentID: id === "nested" ? "child" : "root" }),
      },
    }));
    const hooks = await module.RuntimeHandoff({
      client: { session: { get } },
      directory: home,
    });
    const transform = hooks["experimental.chat.system.transform"];
    // A child can be the first request handled by the process.
    for (const sessionID of ["child", "nested"]) {
      const output = { system: ["Return exactly CHILD ONLY."] };
      await transform({ sessionID }, output);
      expect(output.system).toEqual(["Return exactly CHILD ONLY."]);
    }
    const root = { system: ["Existing project instructions."] };
    await transform({ sessionID: "root" }, root);
    await transform({ sessionID: "root" }, root);
    expect(root.system).toEqual([
      "Existing project instructions.",
      instructions,
    ]);
    expect(get).toHaveBeenCalledWith({
      path: { id: "root" },
      query: { directory: home },
      throwOnError: true,
    });
    await writeFile(prompt, "Updated root guidance.");
    const resumedRoot = { system: ["Existing project instructions."] };
    await transform({ sessionID: "root" }, resumedRoot);
    expect(resumedRoot.system).toEqual([
      "Existing project instructions.",
      "Updated root guidance.",
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("missing or unresolved native identity never gets root guidance", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "opencode handoff "));
  const plugin = path.join(home, "guard.handoff.mjs");
  try {
    await writeFile(plugin, OPENCODE_HANDOFF_PLUGIN);
    await writeFile(path.join(home, "guard.prompt.md"), "Root only.");
    const module = await import(pathToFileURL(plugin).href);
    const get = vi.fn();
    const hooks = await module.RuntimeHandoff({
      client: { session: { get } },
      directory: home,
    });
    const transform = hooks["experimental.chat.system.transform"];
    const output = { system: ["Existing guidance."] };
    await transform({}, output);
    expect(get).not.toHaveBeenCalled();
    for (const result of [
      {},
      { error: "lookup failed" },
      { data: { id: "other" } },
      { data: { id: "unknown", parentID: "" } },
    ]) {
      get.mockResolvedValueOnce(result);
      await transform({ sessionID: "unknown" }, output);
      expect(output.system).toEqual(["Existing guidance."]);
    }
    get.mockRejectedValueOnce(new Error("unavailable"));
    await transform({ sessionID: "unknown" }, output);
    expect(output.system).toEqual(["Existing guidance."]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

for (const shell of ["bash", "zsh"]) {
  test(`${shell} installs and launches session-scoped handoff without global instructions`, async () => {
    const home = await mkdtemp(path.join(tmpdir(), "opencode launcher "));
    const env = {
      ...process.env,
      HOME: home,
      ZDOTDIR: home,
      PATH: `${home}:${process.env.PATH}`,
      SHELL: `/bin/${shell}`,
      OPENCODE_CONFIG_CONTENT: "",
      ARCHESTRA_OPENCODE_GUARD: "0",
    };
    const install = async (context: StartupGuardContext) => {
      const script = path.join(home, "install.sh");
      await writeFile(
        script,
        // Match the full setup script's non-terminal SCRIPT_HELPERS context.
        `set -euo pipefail\nARCH_C_RESET=''; ARCH_C_HEAD=''; ARCH_C_OK=''; ARCH_C_WARN=''; ARCH_C_ERR=''\nsay() { :; }; ok() { :; }\n${buildStartupGuardInstallSection(context, client)}`,
      );
      await exec("bash", [script], { env });
    };
    const launch = async (args: string[], config = "") => {
      await expect(
        exec(
          shell,
          [
            "-c",
            `source "$HOME/${shell === "zsh" ? ".zshrc" : ".bashrc"}"; opencode "$@"`,
            "test",
            ...args,
          ],
          {
            env: { ...env, OPENCODE_CONFIG_CONTENT: config },
          },
        ),
      ).rejects.toMatchObject({ code: 23 });
      return JSON.parse(await readFile(path.join(home, "result.json"), "utf8"));
    };
    try {
      await writeFile(
        path.join(home, "opencode"),
        `#!/usr/bin/env node
const fs = require("node:fs");
(async () => {
  const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}");
  const output = { args: process.argv.slice(2), config };
  if (config.plugin) {
    const module = await import(config.plugin[0]);
    const hooks = await module.RuntimeHandoff({ directory: process.env.HOME, client: { session: { get: async ({ path: { id } }) => ({ data: { id, ...(id === "root" ? {} : { parentID: "root" }) } }) } } });
    for (const sessionID of ["root", "child"]) {
      const system = { system: ["Keep existing rules."] };
      await hooks["experimental.chat.system.transform"]({ sessionID }, system);
      output[sessionID] = system.system;
    }
  }
  fs.writeFileSync(process.env.HOME + "/result.json", JSON.stringify(output));
  process.exit(23);
})().catch(error => { console.error(error); process.exit(1); });
`,
      );
      await chmod(path.join(home, "opencode"), 0o755);
      await install(ctx);
      await install(ctx);
      const args = ["run", "two words", "$literal"];
      const result = await launch(args);
      expect(result.args).toEqual(args);
      expect(result.config).not.toHaveProperty("instructions");
      expect(result.root).toEqual([
        "Keep existing rules.",
        DEFAULT_RUNTIME_HANDOFF_INSTRUCTIONS,
      ]);
      expect(result.child).toEqual(["Keep existing rules."]);
      const ownConfig = { instructions: ["/user/rules.md"] };
      // An explicit user configuration still suppresses automatic guidance.
      expect((await launch(args, JSON.stringify(ownConfig))).config).toEqual(
        ownConfig,
      );
      for (const args of [
        ["mcp", "list"],
        ["serve"],
        ["--help"],
        ["--system-prompt", "mine"],
      ]) {
        expect((await launch(args)).config).toEqual({});
      }
      await writeFile(path.join(home, client.skipRelpath), "mcp\n");
      expect((await launch(args)).config).toEqual({});
      await install({
        ...ctx,
        runtimeHandoffInstructions: "Updated guidance.",
      });
      expect((await launch(args)).root).toEqual([
        "Keep existing rules.",
        "Updated guidance.",
      ]);
      await install({ ...ctx, runtimeHandoffInstructions: null });
      expect((await launch(args)).config).toEqual({});
      await expect(
        readFile(path.join(home, `${client.scriptRelpath}.handoff.mjs`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
}

const powershellAvailable =
  spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0;
if (process.env.CI === "true" && !powershellAvailable)
  throw new Error("CI requires PowerShell for handoff launch tests");

test
  .skipIf(!powershellAvailable)
  .each([
    "",
    '{ "instructions": ["{env:__ROOT}/rules.md"], "plugin": ["./user-plugin.mjs"] }',
  ])(
  "PowerShell launches the root-only plugin and restores the caller environment (config=%j)",
  async (configContent) => {
    const home = await mkdtemp(
      path.join(tmpdir(), "opencode powershell #percent% "),
    );
    const callerEnv = {
      HOME: path.join(home, "other home"),
      USERPROFILE: home,
      __ROOT: path.join(home, "user root"),
      OPENCODE_CONFIG: path.join(home, "user config.json"),
      OPENCODE_CONFIG_DIR: path.join(home, "user config dir"),
      XDG_CONFIG_HOME: path.join(home, "user config"),
      XDG_DATA_HOME: path.join(home, "user data"),
      XDG_STATE_HOME: path.join(home, "user state"),
    };
    try {
      const stub = `const fs = require("node:fs");
(async () => {
const result = {
  args: process.argv.slice(2),
  config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}"),
  configContent: process.env.OPENCODE_CONFIG_CONTENT,
  env: Object.fromEntries(${JSON.stringify(Object.keys(callerEnv))}.map(name => [name, process.env[name]])),
};
if (${JSON.stringify(!configContent)}) {
  const module = await import(result.config.plugin[0]);
  const hooks = await module.RuntimeHandoff({
    directory: process.env.USERPROFILE,
    client: { session: { get: async ({ path: { id } }) => ({ data: { id, ...(id === "root" ? {} : { parentID: "root" }) } }) } },
  });
  for (const sessionID of ["root", "child"]) {
    const output = { system: ["User rules."] };
    await hooks["experimental.chat.system.transform"]({ sessionID }, output);
    result[sessionID] = output.system;
  }
}
fs.writeFileSync(require("node:path").join(process.env.USERPROFILE, "result.json"), JSON.stringify(result));
process.exit(23);
})().catch(error => { console.error(error); process.exit(1); });`;
      const binary = path.join(
        home,
        process.platform === "win32" ? "opencode.cmd" : "opencode",
      );
      await writeFile(path.join(home, "client.cjs"), stub);
      await writeFile(
        binary,
        process.platform === "win32"
          ? '@node "%USERPROFILE%\\client.cjs" %*\r\n@exit /b %errorlevel%\r\n'
          : `#!/usr/bin/env node\n${stub}`,
      );
      await chmod(binary, 0o755);
      // Redirect OS profile discovery into the fixture, including on Windows
      // where changing HOME does not change MyDocuments or PowerShell's $HOME.
      const install = buildWindowsStartupGuardInstallSection(
        ctx,
        client,
      ).replaceAll(
        "[Environment]::GetFolderPath('MyDocuments')",
        "$env:USERPROFILE",
      );
      const script = path.join(home, "driver.ps1");
      await writeFile(
        script,
        `
$ErrorActionPreference = 'Stop'
function Say { }; function Ok { }
$PROFILE = [pscustomobject]@{ CurrentUserAllHosts = Join-Path $env:USERPROFILE 'profile.ps1' }
$archCallerEnv = @{}
foreach ($name in @('OPENCODE_CONFIG_CONTENT', ${Object.keys(callerEnv)
          .map((name) => `'${name}'`)
          .join(", ")})) {
  $archCallerEnv[$name] = [Environment]::GetEnvironmentVariable($name)
}
${install}
opencode run 'two words' '$literal'
if ($LASTEXITCODE -ne 23) { throw 'Client exit status lost' }
foreach ($name in $archCallerEnv.Keys) {
  if ([Environment]::GetEnvironmentVariable($name) -cne $archCallerEnv[$name]) { throw ('Caller environment changed: ' + $name) }
}
exit 0
`,
      );
      await exec(
        "pwsh",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script],
        {
          env: {
            ...process.env,
            ...callerEnv,
            PATH: `${home}${path.delimiter}${process.env.PATH}`,
            OPENCODE_CONFIG_CONTENT: configContent,
            ARCHESTRA_OPENCODE_GUARD: "0",
          },
        },
      );
      const result = JSON.parse(
        await readFile(path.join(home, "result.json"), "utf8"),
      );
      expect(result.args).toEqual(["run", "two words", "$literal"]);
      expect(result.env).toEqual(callerEnv);
      if (configContent) {
        expect(result.configContent).toBe(configContent);
        expect(result.config).toEqual(JSON.parse(configContent));
        return;
      }
      expect(result.config).not.toHaveProperty("instructions");
      expect(result.config.plugin).toEqual([
        pathToFileURL(path.join(home, `${client.psScriptRelpath}.handoff.mjs`))
          .href,
      ]);
      expect(result.root).toEqual([
        "User rules.",
        DEFAULT_RUNTIME_HANDOFF_INSTRUCTIONS,
      ]);
      expect(result.child).toEqual(["User rules."]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
