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
import { DEFAULT_RUNTIME_HANDOFF_INSTRUCTIONS } from "@archestra/shared";
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
      "require('node:fs').writeFileSync(process.env.CODEX_TEST_RESULT, JSON.stringify({args:process.argv.slice(2),marker:process.env.ARCHESTRA_CODEX_LAUNCH_MARKER})); process.exit(23);",
    );
    await writeFile(helper, CODEX_HANDOFF_HELPER);
    await expect(
      exec(process.execPath, [helper, "--launch", shim], {
        env: {
          ...process.env,
          CODEX_TEST_RESULT: result,
          ARCHESTRA_CODEX_LAUNCH_MARKER: marker,
          ARCHESTRA_CODEX_LAUNCH_ARGS: Buffer.from(
            JSON.stringify(args),
          ).toString("base64"),
        },
      }),
    ).rejects.toMatchObject({ code: 23 });
    expect(JSON.parse(await readFile(result, "utf8"))).toEqual({ args });
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

for (const shell of ["bash", "zsh"]) {
  for (const client of [CODEX_GUARD_CLIENT, COPILOT_GUARD_CLIENT]) {
    test(`${shell} ${client.binary} adds handoff without replacing user instructions`, async () => {
      const home = await mkdtemp(path.join(tmpdir(), "handoff client "));
      const instructions = 'Offer remote work.\n"quoted" $HOME 雪';
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
        return JSON.parse(
          await readFile(path.join(home, "result.json"), "utf8"),
        );
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
        await writeFile(path.join(home, client.skipRelpath), "mcp\n");
        const disconnected = await launch(args);
        expect(disconnected.args).toEqual(args);
        expect(disconnected.dirs).toBe(env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS);
        await install({ ...ctx, runtimeHandoffInstructions: null });
        const disabled = await launch(args);
        expect(disabled.args).toEqual(args);
        expect(disabled.dirs).toBe(env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS);
        expect(
          await readFile(path.join(env.CODEX_HOME, "AGENTS.md"), "utf8"),
        ).toBe("User guidance stays intact.");
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
